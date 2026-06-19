#!/usr/bin/env node
'use strict';

/*
 * build feed data.js — the single orchestrator the GitHub Actions cron runs.
 *
 * Deterministic only. No Anthropic API, no LLM. Node built-ins + the existing
 * fetch/watch/regime scripts. Produces three files under docs/ that the static
 * market-feed.html reads:
 *   - feed-events.json   rolling reverse-chron event log (last 3 trading days)
 *   - mood-history.csv   one row per run, feeds the timeline charts
 *   - feed-data.json      the full snapshot the page renders on each refresh
 *
 * Pipeline (see "live market feed - build plan.md" §5a):
 *   1. node intraday-watch.js --once   -> event lines on stdout + writes Briefs/<today>/intraday raw.json
 *   2. parse event lines -> structured objects, merge into feed-events.json
 *   3. read that raw.json for the snapshot (prices, gauges, posts, filings, news)
 *   4. node regime engine.js           -> regime read + drivers
 *   5. compute the mood composite (unweighted mean of present components — no invented weights)
 *   6. append a mood-history.csv row
 *   7. write feed-data.json
 *   8. sleeping/closed case: regenerate from last known state, marketOpen:false
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const DOCS = path.join(DIR, 'docs');
const EVENTS_FILE = path.join(DOCS, 'feed-events.json');
const MOOD_CSV = path.join(DOCS, 'mood-history.csv');
const DATA_FILE = path.join(DOCS, 'feed-data.json');
const WATCH_SCRIPT = path.join(DIR, 'intraday-watch.js');
const REGIME_SCRIPT = path.join(DIR, 'regime engine.js');
const MOOD_SIGNALS_SCRIPT = path.join(DIR, 'mood-signals.js');
const MOOD_SIGNALS_STATE = path.join(DIR, 'mood-signals state.json');

const NOW = Date.now();
const round1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);

// ---- ET time helpers -------------------------------------------------------
function etDate(ms) {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
function etClock(ms) {
  // "11:38 AM"
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(ms);
}
function etStamp(ms) {
  // "Jun 18, 2026, 4:05 PM ET"
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(ms);
  return s + ' ET';
}
function etOffsetMs(ms) {
  const u = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'UTC' }));
  const e = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return e.getTime() - u.getTime();
}
// "11:38 AM" (clock, assumed ET) + a YYYY-MM-DD ET date -> epoch ms
function etClockToMs(dateYMD, clock) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(clock.trim());
  if (!m) return NOW;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const [Y, Mo, D] = dateYMD.split('-').map(Number);
  const asUTC = Date.UTC(Y, Mo - 1, D, h, Number(m[2]));
  return asUTC - etOffsetMs(asUTC);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// ---- step 1: run the watcher, capture event lines --------------------------
function runWatcher() {
  try {
    const out = execFileSync('node', [WATCH_SCRIPT, '--once'], { cwd: DIR, timeout: 180000, maxBuffer: 1 << 24, encoding: 'utf8' });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    // even on a non-zero exit, surface whatever it printed
    const out = (e.stdout || '').toString();
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
}

// ---- step 2: parse event lines into structured objects ---------------------
// Lines (12h clock; "ET" in the doc grammar is descriptive, not in the string):
//   MOVE <SYM> <pct>% · <label>
//   POST <SYM> @<handle> <H:MM AM/PM> | <text>
//   NEWS <SYM> <source> <H:MM AM/PM> | <title>
//   THEME <theme> <H:MM AM/PM> | <title>
//   FILING <SYM> <type> <H:MM AM/PM> | <form> <items>
//   GAUGE <name> <old> -> <new> (<score>)
const CLK = '(\\d{1,2}:\\d{2}\\s*[AP]M)';
function parseEvents(lines, dateYMD, sectionOf, urlIndex) {
  const events = [];
  for (const line of lines) {
    let m;
    if ((m = new RegExp(`^MOVE (\\S+) ([+-]?[\\d.]+)% · (.*)$`).exec(line))) {
      events.push({ type: 'move', symbol: m[1], section: sectionOf[m[1]] || null, time: NOW, timeLabel: etClock(NOW), text: `${m[2]}% · ${m[3]}` });
    } else if ((m = new RegExp(`^POST (\\S+) (@\\S+) ${CLK} \\| (.*)$`).exec(line))) {
      const t = etClockToMs(dateYMD, m[3]);
      events.push({ type: 'post', symbol: m[1], section: sectionOf[m[1]] || null, time: t, timeLabel: m[3], handle: m[2], text: m[4], url: urlIndex.post(m[1], m[4]) });
    } else if ((m = new RegExp(`^NEWS (\\S+) (.*?) ${CLK} \\| (.*)$`).exec(line))) {
      const t = etClockToMs(dateYMD, m[3]);
      events.push({ type: 'news', symbol: m[1], section: sectionOf[m[1]] || null, time: t, timeLabel: m[3], source: m[2].trim(), text: m[4], url: urlIndex.news(m[1], m[4]) });
    } else if ((m = new RegExp(`^THEME (.*?) ${CLK} \\| (.*)$`).exec(line))) {
      const t = etClockToMs(dateYMD, m[2]);
      events.push({ type: 'theme', symbol: null, section: 'theme', theme: m[1].trim(), time: t, timeLabel: m[2], text: m[3], url: urlIndex.theme(m[3]) });
    } else if ((m = new RegExp(`^FILING (\\S+) (\\S+) ${CLK} \\| (.*)$`).exec(line))) {
      const t = etClockToMs(dateYMD, m[3]);
      events.push({ type: 'filing', symbol: m[1], section: sectionOf[m[1]] || null, time: t, timeLabel: m[3], filingType: m[2], text: m[4], url: urlIndex.filing(m[1]) });
    } else if ((m = /^GAUGE (.+?) (.+) -> (.+) \((\d+)\)$/.exec(line))) {
      events.push({ type: 'gauge', symbol: null, section: 'macro', time: NOW, timeLabel: etClock(NOW), text: `${m[1].trim()}: ${m[2].trim()} → ${m[3].trim()} (${m[4]})` });
    }
  }
  return events;
}

// Build best-effort URL lookups from the raw snapshot so events can link out.
function buildUrlIndex(raw) {
  const tn = (raw.sources && raw.sources.tickerNews) || {};
  const cp = (raw.sources && raw.sources.companyPosts && raw.sources.companyPosts.byTicker) || {};
  const sf = (raw.sources && raw.sources.secFilings && raw.sources.secFilings.byTicker) || {};
  const tm = (raw.sources && raw.sources.themeNews && raw.sources.themeNews.byTheme) || [];
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  const newsItems = (sym) => {
    const e = tn[sym]; if (!e) return [];
    return [].concat((e.google && e.google.items) || [], (e.yahoo && e.yahoo.items) || []);
  };
  return {
    news: (sym, title) => { const k = norm(title); const it = newsItems(sym).find((i) => norm(i.title) === k); return it ? it.link : undefined; },
    post: (sym, text) => { const e = cp[sym]; if (!e || !e.posts) return undefined; const k = norm(text); const p = e.posts.find((x) => norm(x.text) === k || norm(x.text).startsWith(k.slice(0, 40))); return p ? p.url : undefined; },
    filing: (sym) => { const e = sf[sym]; return e && e.filings && e.filings[0] ? e.filings[0].url : undefined; },
    theme: (title) => { const k = norm(title); for (const t of tm) { const it = (t.items || []).find((i) => norm(i.title) === k); if (it) return it.link; } return undefined; },
  };
}

// ---- step 5: mood composite ------------------------------------------------
// Each component normalized 0-100, higher = greedier / more risk-on.
// Composite = simple unweighted mean of whichever components are present.
// NO invented weights (plan §6b). StockTwits is absent on the --light cron path.
function computeMood(raw, regime) {
  const g = raw.sources && raw.sources.sentimentGauges;
  const comps = [];
  if (g && g.fearGreed && typeof g.fearGreed.score === 'number') comps.push({ name: 'CNN Fear & Greed', value: g.fearGreed.score });
  const hasCrypto = (raw.symbols || []).some((s) => s.class === 'crypto');
  if (hasCrypto && g && g.cryptoFearGreed && typeof g.cryptoFearGreed.value === 'number') comps.push({ name: 'Crypto Fear & Greed', value: g.cryptoFearGreed.value });
  // StockTwits aggregate bull% — only present if a non-light run ever populated it.
  const st = raw.sources && raw.sources.stocktwits && raw.sources.stocktwits.byTicker;
  if (st) {
    let bull = 0, tag = 0;
    for (const k of Object.keys(st)) { const e = st[k]; if (e && typeof e.bullish === 'number') { bull += e.bullish; tag += e.tagged || 0; } }
    if (tag > 0) comps.push({ name: 'StockTwits bull %', value: (bull / tag) * 100 });
  }
  if (regime && typeof regime.on === 'number' && (regime.on + regime.off) > 0) {
    comps.push({ name: 'Regime (% voters risk-on)', value: (regime.on / (regime.on + regime.off)) * 100 });
  }
  const composite = comps.length ? comps.reduce((a, c) => a + c.value, 0) / comps.length : null;
  return { composite: round1(composite), components: comps.map((c) => ({ name: c.name, value: round1(c.value) })) };
}

function moodRating(score) {
  if (score == null) return '—';
  if (score >= 75) return 'Extreme Greed';
  if (score >= 60) return 'Greed';
  if (score >= 45) return 'Neutral';
  if (score >= 25) return 'Fear';
  return 'Extreme Fear';
}

// ---- snapshot + per-name ----------------------------------------------------
function buildSnapshot(raw) {
  const g = raw.sources && raw.sources.sentimentGauges;
  const fg = g && g.fearGreed, cfg = g && g.cryptoFearGreed;
  const tm = (raw.sources && raw.sources.themeNews && raw.sources.themeNews.byTheme) || [];
  const themeHeadlines = tm.map((t) => ({
    theme: t.name,
    items: (t.items || []).slice(0, 3).map((i) => ({ title: i.title, link: i.link, time: i.published ? etClock(Date.parse(i.published)) : null })),
  }));
  return {
    asOfET: raw.asOfET || (raw.generatedAtMs ? etStamp(raw.generatedAtMs) : null),
    pricesAsOf: raw.pricesAsOf ? etStamp(raw.pricesAsOf) : null,
    marketState: raw.marketState || null,
    gauges: {
      cnn: fg ? { score: fg.score, rating: fg.rating, prevClose: fg.previousClose, prevWeek: fg.previous1Week, prevMonth: fg.previous1Month } : null,
      crypto: cfg ? { value: cfg.value, rating: cfg.rating, yesterday: cfg.yesterdayValue } : null,
    },
    themeHeadlines,
  };
}

function buildPerName(raw) {
  const quotes = raw.quotes || {};
  const tn = (raw.sources && raw.sources.tickerNews) || {};
  const cp = (raw.sources && raw.sources.companyPosts && raw.sources.companyPosts.byTicker) || {};
  const sf = (raw.sources && raw.sources.secFilings && raw.sources.secFilings.byTicker) || {};
  const st = (raw.sources && raw.sources.stocktwits && raw.sources.stocktwits.byTicker) || {};
  return (raw.symbols || []).map((s) => {
    const t = s.ticker;
    const q = quotes[t] || {};
    const news = [].concat((tn[t] && tn[t].google && tn[t].google.items) || [], (tn[t] && tn[t].yahoo && tn[t].yahoo.items) || []);
    const latestNews = news[0] ? { title: news[0].title, link: news[0].link, time: news[0].published ? etClock(Date.parse(news[0].published)) : null } : null;
    const post = cp[t] && cp[t].posts && cp[t].posts[0];
    const filing = sf[t] && sf[t].filings && sf[t].filings[0];
    const stE = st[t];
    return {
      ticker: t,
      section: s.section || null,
      class: s.class || null,
      pct: round1(q.pct),
      last: q.last != null ? round1(q.last) : null,
      newsCount: news.length,
      latestNews,
      latestPost: post ? { text: post.text, url: post.url, time: post.ts ? etClock(post.ts) : null } : null,
      latestFiling: filing ? { type: filing.type, label: filing.label, url: filing.url, time: filing.filedAt ? etClock(filing.filedAt) : null } : null,
      stocktwits: stE && typeof stE.bullRatio === 'number' && stE.bullRatio != null
        ? { bullPct: round1(stE.bullRatio * 100), tagged: stE.tagged, perHour: round1(stE.msgsPerHour) }
        : null,
    };
  });
}

// ---- degraded[] ------------------------------------------------------------
// Anything that FAILED (error/empty where it shouldn't be), distinct from feeds
// intentionally skipped on the --light path (reddit / stocktwits / calendars).
function collectDegraded(raw, regimeOk, watcherSleeping) {
  const out = [];
  const ss = raw.sourceStatus || {};
  if (ss.quotes && ss.quotes !== 'ok') out.push(`Prices: ${ss.quotes}`);
  const g = raw.sources && raw.sources.sentimentGauges;
  if (g && g.fearGreedStatus && g.fearGreedStatus !== 'ok') out.push(`CNN Fear & Greed: ${g.fearGreedStatus}`);
  if (g && g.cryptoStatus && g.cryptoStatus !== 'ok') out.push(`Crypto Fear & Greed: ${g.cryptoStatus}`);
  if (ss.secFilings && ss.secFilings !== 'ok') out.push(`SEC filings: ${ss.secFilings}`);
  for (const b of ss.broadMarket || []) if (/: (error|fail|timeout)/i.test(b)) out.push(`News — ${b}`);
  if (typeof ss.companyPosts === 'string' && /error|fail|blocked/i.test(ss.companyPosts)) out.push(`Company posts: ${ss.companyPosts}`);
  if (!regimeOk && !watcherSleeping) out.push('Regime engine: did not return');
  return out;
}

// ---- timeline (read back mood-history.csv) ---------------------------------
function readTimeline() {
  if (!fs.existsSync(MOOD_CSV)) return [];
  const lines = fs.readFileSync(MOOD_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => {
    const [tMs, label, cnn, crypto, stBull, regime, composite] = l.split(',');
    return {
      t: Number(tMs), label,
      cnn: cnn === '' ? null : Number(cnn),
      crypto: crypto === '' ? null : Number(crypto),
      stBull: stBull === '' ? null : Number(stBull),
      regime: regime === '' ? null : Number(regime),
      composite: composite === '' ? null : Number(composite),
    };
  }).slice(-400); // cap so the page payload stays small
}

function appendMoodRow(mood, regime, raw) {
  const g = raw.sources && raw.sources.sentimentGauges;
  const cnn = g && g.fearGreed ? g.fearGreed.score : '';
  const crypto = g && g.cryptoFearGreed ? g.cryptoFearGreed.value : '';
  const comp = (name) => { const c = mood.components.find((x) => x.name.startsWith(name)); return c ? c.value : ''; };
  const regimeScore = regime && (regime.on + regime.off) > 0 ? round1((regime.on / (regime.on + regime.off)) * 100) : '';
  const row = [NOW, etStamp(NOW).replace(/,/g, ''), cnn, crypto, comp('StockTwits'), regimeScore, mood.composite == null ? '' : mood.composite].join(',');
  if (!fs.existsSync(MOOD_CSV)) fs.writeFileSync(MOOD_CSV, 'tMs,etLabel,cnnFG,cryptoFG,stBull,regimeScore,composite\n', 'utf8');
  fs.appendFileSync(MOOD_CSV, row + '\n', 'utf8');
}

// ---- event merge + rolling window (last 3 trading days) --------------------
function mergeEvents(fresh) {
  const prev = readJson(EVENTS_FILE, []);
  const byId = new Map();
  const idOf = (e) => crypto.createHash('sha1').update(`${e.type}|${e.symbol || e.theme || ''}|${e.timeLabel}|${(e.text || '').slice(0, 80)}`).digest('hex').slice(0, 12);
  for (const e of prev) byId.set(e.id || idOf(e), e);
  for (const e of fresh) { const id = idOf(e); if (!byId.has(id)) byId.set(id, { id, ...e }); }
  let all = [...byId.values()].sort((a, b) => b.time - a.time);
  // keep events from the 3 most recent distinct ET dates that have events
  const dates = [...new Set(all.map((e) => etDate(e.time)))].sort().reverse().slice(0, 3);
  const keep = new Set(dates);
  all = all.filter((e) => keep.has(etDate(e.time)));
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(all, null, 1), 'utf8'); // persist the rolling log
  return all;
}

// ---- regime ----------------------------------------------------------------
function runRegime() {
  try {
    const out = execFileSync('node', [REGIME_SCRIPT], { cwd: DIR, timeout: 90000, maxBuffer: 1 << 22, encoding: 'utf8' });
    const j = JSON.parse(out);
    return { ok: true, ...j };
  } catch (e) {
    const st = readJson(path.join(DIR, 'regime state.json'), null);
    if (st && st.regime) return { ok: false, ...st };
    return { ok: false, regime: null, components: {} };
  }
}

// ---- extra mood signals (daily-cached; display+log only, not regime voters) ----
// Self-caches once per ET day, so calling it every run is cheap. On any failure, fall
// back to the cached block, then to the prior feed-data.json, so the section never blanks.
function runMoodSignals(prev) {
  try {
    const out = execFileSync('node', [MOOD_SIGNALS_SCRIPT], { cwd: DIR, timeout: 90000, maxBuffer: 1 << 22, encoding: 'utf8' });
    const j = JSON.parse(out);
    if (j && Array.isArray(j.groups) && j.groups.length) return j;
  } catch (e) { /* fall through to cache */ }
  const st = readJson(MOOD_SIGNALS_STATE, null);
  if (st && st.block && Array.isArray(st.block.groups) && st.block.groups.length) return st.block;
  if (prev && prev.moodSignals && Array.isArray(prev.moodSignals.groups)) return prev.moodSignals;
  return null;
}

function shapeRegime(rg) {
  if (!rg || !rg.regime) return null;
  const r = rg.regime;
  const comps = Object.entries(rg.components || {}).map(([k, v]) => ({ name: k, vote: v.vote, state: v.state, detail: v.detail }));
  return {
    label: r.label, tally: r.tally, on: r.on, off: r.off, drivers: r.drivers || [],
    score: (r.on + r.off) > 0 ? round1((r.on / (r.on + r.off)) * 100) : null,
    components: comps,
  };
}

// ============================================================================
function main() {
  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });

  const lines = runWatcher();
  const sleeping = lines.some((l) => l.startsWith('WATCHER-SLEEPING'));
  const today = etDate(NOW);
  const rawPath = path.join(DIR, 'Briefs', today, 'intraday raw.json');
  const raw = readJson(rawPath, null);

  // Sleeping / closed: regenerate from last known feed-data.json, marketOpen:false.
  if (sleeping || !raw) {
    const prev = readJson(DATA_FILE, null);
    if (prev) {
      prev.generatedAt = etStamp(NOW);
      prev.generatedAtMs = NOW;
      prev.marketOpen = false;
      // events still roll forward (none fresh while sleeping)
      prev.events = mergeEvents([]);
      fs.writeFileSync(DATA_FILE, JSON.stringify(prev, null, 1), 'utf8');
      console.log(`[build] ${sleeping ? 'market closed' : 'no raw'} — regenerated from last known state (${prev.events.length} events)`);
      return;
    }
    // first-ever run while closed and no prior state: write a minimal shell
    const shell = { generatedAt: etStamp(NOW), generatedAtMs: NOW, marketOpen: false, snapshot: null, mood: { composite: null, components: [] }, moodSignals: null, regime: null, perName: [], events: mergeEvents([]), timeline: readTimeline(), degraded: ['No market data yet — first run was off-hours'] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(shell, null, 1), 'utf8');
    console.log('[build] off-hours first run, wrote shell feed-data.json');
    return;
  }

  const sectionOf = {};
  for (const s of raw.symbols || []) sectionOf[s.ticker] = s.section || null;

  const urlIndex = buildUrlIndex(raw);
  const fresh = parseEvents(lines, today, sectionOf, urlIndex);
  const events = mergeEvents(fresh);

  const rg = runRegime();
  const regime = shapeRegime(rg);
  const mood = computeMood(raw, regime);
  const moodSignals = runMoodSignals(readJson(DATA_FILE, null));

  appendMoodRow(mood, regime, raw);

  const data = {
    generatedAt: etStamp(NOW),
    generatedAtMs: NOW,
    marketOpen: true,
    snapshot: buildSnapshot(raw),
    mood: { ...mood, rating: moodRating(mood.composite) },
    moodSignals,
    regime,
    perName: buildPerName(raw),
    events,
    timeline: readTimeline(),
    degraded: collectDegraded(raw, rg.ok, false),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 1), 'utf8');
  console.log(`[build] ok — ${fresh.length} new events, ${events.length} in window, mood ${mood.composite} (${data.mood.rating}), ${data.degraded.length} degraded`);
}

if (require.main === module) main();

module.exports = { parseEvents, buildUrlIndex, computeMood, moodRating, buildSnapshot, buildPerName, collectDegraded, mergeEvents, shapeRegime, readTimeline, etClock, etStamp, etClockToMs, etDate, round1 };
