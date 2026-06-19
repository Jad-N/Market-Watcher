#!/usr/bin/env node
/*
 * intraday-watch.js — keeps the market brief "live" between the 8 AM / 5 PM runs.
 *
 * Same shape as alert-watcher.js: a quiet local poller, run by the harness Monitor tool,
 * that prints ONE line per event and nothing while idle. It only reads the same free public
 * feeds the brief uses (Yahoo, RSS, StockTwits-free gauges, X syndication) — no TradingView
 * app, no login, no software install. It reuses fetch-feeds.js in --light mode each cycle.
 *
 * It notifies ONLY on material change, not on a timer:
 *   - a new post from a company's official X account
 *   - a new news headline on a watchlist name
 *   - the CNN fear-gauge rating flipping zone (Fear -> Neutral, etc.)
 *   - a watchlist name's move crossing a % threshold YOU set (off until set in the config)
 *
 * Priming: the first poll records everything currently present as the baseline and fires
 * nothing — you only hear about what happens AFTER the watch is armed. State persists to
 * "intraday state.json" so a restart mid-day doesn't re-announce the same things.
 *
 * Output contract (one line per event, stdout only, silent when nothing happens):
 *   WATCHER-READY <n> symbols · triggers: posts,news,gauge[,move>=X%]   once, on first good poll
 *   MOVE <SYM> <pct>% · <priceLabel>                                    price crossed your threshold
 *   POST <SYM> @<handle> <H:MM ET> | <text>                            company posted on X
 *   NEWS <SYM> <source> <H:MM ET> | <title>                            new headline on a watchlist name (scoped by newsScope)
 *   THEME <theme> <H:MM ET> | <title>                                  new headline on one of your themes (data centers/miners/AI)
 *   FILING <SYM> <type> <H:MM ET> | <form> <items/desc>                new material SEC filing on a sector name (deal/financing/control)
 *   GAUGE <name> <oldRating> -> <newRating> (<score>)                  fear-gauge flipped zone
 *   WATCHER-DEGRADED <reason>                                          a poll failed (hole in the watch)
 *   WATCHER-RECOVERED                                                  visibility restored
 *   WATCHER-SLEEPING <until>                                           outside market hours, paused
 *
 * Usage:
 *   node intraday-watch.js            loop forever (via the Monitor tool, in-session, rich reads)
 *   node intraday-watch.js --once     single poll then exit (for the unattended scheduled task + toasts)
 * Both share "intraday state.json", so the in-session loop and the scheduled --once never double-notify.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'intraday-watch.json');
const STATE_FILE = path.join(DIR, 'intraday state.json');
const SYMBOLS_FILE = path.join(DIR, 'symbol map.json');
const FETCH_SCRIPT = path.join(DIR, 'fetch-feeds.js');
const REGIME_SCRIPT = path.join(DIR, 'regime engine.js');

const DEFAULT_CONFIG = {
  pollMinutes: 15,
  windowHours: 24,
  marketHours: { startHourET: 7, endHourET: 18 }, // 7 AM–6 PM ET catches pre/post too
  weekdaysOnly: true,
  triggers: { posts: true, news: true, gauges: true, price: true, filings: true, regime: true },
  newsScope: 'all',         // 'all' = every watchlist name; 'trading+themes' = trading names + theme-keyword hits only
  movePctThreshold: null,   // null = price alerts OFF until you set a number (e.g. 4)
  reArmStepPct: 2,          // after a MOVE fires, only re-fire if it moves this much further
  regimeEveryNPolls: 4,     // run the macro regime engine every Nth poll (~hourly at 15-min polls) — plumbing cadence, not a market threshold
};

// strip a UTF-8 BOM — an editor or PowerShell round-trip can prepend one, and JSON.parse chokes on it
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }

function loadConfig() {
  try {
    const c = readJson(CONFIG_FILE);
    return Object.assign({}, DEFAULT_CONFIG, c, { triggers: Object.assign({}, DEFAULT_CONFIG.triggers, c.triggers || {}), marketHours: Object.assign({}, DEFAULT_CONFIG.marketHours, c.marketHours || {}) });
  } catch (e) { return DEFAULT_CONFIG; }
}

function etParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return { weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === '24' ? 0 : p.hour) };
}

function etTime(ms) {
  if (!ms) return '';
  try { return new Date(Number(ms)).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}

function emit(line) { process.stdout.write(line + '\n'); }

function inMarketHours(cfg) {
  if (process.env.FEED_FORCE) return true; // force a fetch regardless of clock (manual refresh / cloud proof)
  const p = etParts();
  if (cfg.weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  return p.hour >= cfg.marketHours.startHourET && p.hour < cfg.marketHours.endHourET;
}

// fresh state for a new day
function freshState(date) {
  return { date, primed: false, seenPostUrls: [], seenNewsKeys: [], seenThemeKeys: [], seenFilingKeys: [], movedTickers: {}, gaugeRating: {} };
}

function loadState(today) {
  try {
    const s = readJson(STATE_FILE);
    if (s.date === today) return s;
  } catch (e) { /* missing/corrupt */ }
  return freshState(today);
}

function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { /* best-effort */ }
}

// run the fetcher in --light mode; resolve the parsed JSON
function fetchLight(cfg) {
  const today = etParts().date;
  const out = path.join(DIR, 'Briefs', today, 'intraday raw.json');
  return new Promise((resolve, reject) => {
    execFile('node', [FETCH_SCRIPT, '--symbols-file', SYMBOLS_FILE, '--light', '--runtype', 'intraday', '--window-hours', String(cfg.windowHours), '--out', out],
      { cwd: DIR, timeout: 150000, maxBuffer: 1 << 24 },
      (err) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); }
        catch (e) { reject(e); }
      });
  });
}

// run the macro regime engine; resolve its `changes` array (loud flips/stress + quiet voter moves).
// The engine never crashes the caller (it emits a valid JSON envelope on error), so a bad run
// just yields no changes rather than killing the poll.
function runRegime() {
  return new Promise((resolve) => {
    execFile('node', [REGIME_SCRIPT], { cwd: DIR, timeout: 60000, maxBuffer: 1 << 22 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(stdout);
          resolve(Array.isArray(j.changes) ? j.changes : []);
        } catch (e) { resolve([]); }
      });
  });
}

let degraded = false;
let consecutiveFails = 0;
const FAIL_THRESHOLD = 2;
let sleepingNotified = false;
let pollCount = 0;

async function poll() {
  const cfg = loadConfig();
  const today = etParts().date;

  if (!inMarketHours(cfg)) {
    if (!sleepingNotified) { emit(`WATCHER-SLEEPING outside ${cfg.marketHours.startHourET}:00-${cfg.marketHours.endHourET}:00 ET`); sleepingNotified = true; }
    return;
  }
  sleepingNotified = false;

  let raw;
  try {
    raw = await fetchLight(cfg);
  } catch (err) {
    consecutiveFails++;
    if (!degraded && consecutiveFails >= FAIL_THRESHOLD) { degraded = true; emit(`WATCHER-DEGRADED ${err.message}`); }
    return;
  }
  if (degraded) { emit('WATCHER-RECOVERED'); degraded = false; }
  consecutiveFails = 0;

  let state = loadState(today);

  // gather current observations
  const cp = (raw.sources && raw.sources.companyPosts && raw.sources.companyPosts.byTicker) || {};
  const tn = (raw.sources && raw.sources.tickerNews) || {};
  const fg = raw.sources && raw.sources.sentimentGauges;
  const quotes = raw.quotes || {};

  // section lookup (trading/macro/crypto) + theme keywords, for scoping the NEWS trigger
  const sectionOf = {};
  for (const s of raw.symbols || []) sectionOf[s.ticker] = s.section || null;
  const themeFeed = (raw.sources && raw.sources.themeNews && raw.sources.themeNews.byTheme) || [];
  const themeKeywords = themeFeed.flatMap((t) => t.keywords || []).map((k) => k.toLowerCase());
  const newsScope = cfg.newsScope || 'all';
  const matchesTheme = (title) => {
    const t = (title || '').toLowerCase();
    return themeKeywords.some((k) => t.includes(k));
  };

  const curPosts = [];   // {sym, handle, ts, text, url}
  for (const sym in cp) {
    const v = cp[sym];
    if (v && v.posts) for (const p of v.posts) if (p.url) curPosts.push({ sym, handle: v.handle || '', ts: p.ts, text: p.text || '', url: p.url });
  }
  const curNews = [];    // {sym, source, ts, title, key}
  for (const sym in tn) {
    const list = (tn[sym] && tn[sym].deduped) || [];
    for (const h of list) if (h.title) curNews.push({ sym, source: h.source || '', ts: h.ts, title: h.title, key: sym + '::' + h.title });
  }
  const curThemes = []; // {theme, ts, title, key}
  for (const th of themeFeed) {
    for (const it of th.items || []) if (it.title) curThemes.push({ theme: th.name, ts: it.ts, title: it.title, key: th.name + '::' + it.title });
  }
  // SEC filings — only the loud catalyst types alert (deals/dilution/control); insider Form 4s + 'other' are desk-only noise
  const ALERT_FILING_TYPES = new Set(['financing/dilution', 'deal/capacity', 'control']);
  const sf = (raw.sources && raw.sources.secFilings && raw.sources.secFilings.byTicker) || {};
  const curFilings = []; // {sym, type, form, ts, items, url, key}
  for (const sym in sf) {
    for (const f of (sf[sym].filings || [])) if (f.url) curFilings.push({ sym, type: f.type, form: f.form, ts: f.filedAt, label: f.label || f.items || f.desc || '', url: f.url, key: f.url });
  }
  const gauges = [];     // {name, rating, score}
  if (fg && fg.fearGreed) gauges.push({ name: 'Fear&Greed', rating: fg.fearGreed.rating, score: fg.fearGreed.score });
  if (fg && fg.cryptoFearGreed) gauges.push({ name: 'CryptoF&G', rating: fg.cryptoFearGreed.rating, score: fg.cryptoFearGreed.value });

  // ---- prime: record baseline, announce, fire nothing ----
  if (!state.primed) {
    state.seenPostUrls = curPosts.map((p) => p.url);
    state.seenNewsKeys = curNews.map((n) => n.key);
    state.seenThemeKeys = curThemes.map((t) => t.key);
    state.seenFilingKeys = curFilings.map((f) => f.key);
    state.gaugeRating = {}; gauges.forEach((g) => { state.gaugeRating[g.name] = g.rating; });
    state.movedTickers = {}; // price baseline implicit (only future crossings fire)
    state.primed = true;
    saveState(state);
    const triggers = [];
    if (cfg.triggers.posts) triggers.push('posts');
    if (cfg.triggers.news) triggers.push(newsScope === 'all' ? 'news(all)' : 'news(trading)', 'themes');
    if (cfg.triggers.filings) triggers.push('filings');
    if (cfg.triggers.gauges) triggers.push('gauge');
    if (cfg.triggers.regime) triggers.push('regime');
    if (cfg.triggers.price && cfg.movePctThreshold != null) triggers.push('move>=' + cfg.movePctThreshold + '%');
    emit(`WATCHER-READY ${(raw.symbols || []).length} symbols · triggers: ${triggers.join(',') || '(none enabled)'}`);
    return;
  }

  const seenPosts = new Set(state.seenPostUrls);
  const seenNews = new Set(state.seenNewsKeys);

  // ---- POST events ----
  if (cfg.triggers.posts) {
    for (const p of curPosts) if (!seenPosts.has(p.url)) {
      seenPosts.add(p.url);
      const txt = p.text.length > 160 ? p.text.slice(0, 157) + '…' : p.text;
      emit(`POST ${p.sym} @${p.handle} ${etTime(p.ts)} | ${txt.replace(/\s+/g, ' ')}`);
    }
  } else { curPosts.forEach((p) => seenPosts.add(p.url)); }

  // ---- NEWS events (scoped: 'all' = every name; 'trading+themes' = trading names + theme-keyword hits) ----
  const seenThemes = new Set(state.seenThemeKeys || []);
  if (cfg.triggers.news) {
    for (const n of curNews) if (!seenNews.has(n.key)) {
      seenNews.add(n.key);
      const inScope = newsScope === 'all' || sectionOf[n.sym] === 'trading' || matchesTheme(n.title);
      if (inScope) emit(`NEWS ${n.sym} ${n.source} ${etTime(n.ts)} | ${n.title.replace(/\s+/g, ' ')}`);
    }
    // standalone theme-feed headlines (not tied to a watchlist name)
    for (const t of curThemes) if (!seenThemes.has(t.key)) {
      seenThemes.add(t.key);
      emit(`THEME ${t.theme} ${etTime(t.ts)} | ${t.title.replace(/\s+/g, ' ')}`);
    }
  } else {
    curNews.forEach((n) => seenNews.add(n.key));
    curThemes.forEach((t) => seenThemes.add(t.key));
  }

  // ---- FILING events (new material SEC filing on a sector name) ----
  const seenFilings = new Set(state.seenFilingKeys || []);
  if (cfg.triggers.filings) {
    for (const f of curFilings) if (!seenFilings.has(f.key)) {
      seenFilings.add(f.key);
      if (ALERT_FILING_TYPES.has(f.type)) emit(`FILING ${f.sym} ${f.type} ${etTime(f.ts)} | ${f.form} ${String(f.label).replace(/\s+/g, ' ')}`);
    }
  } else { curFilings.forEach((f) => seenFilings.add(f.key)); }

  // ---- GAUGE events (zone/rating flip) ----
  if (cfg.triggers.gauges) {
    for (const g of gauges) {
      const prev = state.gaugeRating[g.name];
      if (prev && prev !== g.rating) emit(`GAUGE ${g.name} ${prev} -> ${g.rating} (${g.score})`);
      state.gaugeRating[g.name] = g.rating;
    }
  } else { gauges.forEach((g) => { state.gaugeRating[g.name] = g.rating; }); }

  // ---- REGIME events (macro risk-on/off engine; runs on the first armed poll then every Nth) ----
  // The engine owns its own state file + diff; it returns one line per change. Loud kinds
  // (REGIME-FLIP, STRESS) toast via intraday-toast.ps1; the quiet REGIME kind logs only.
  if (cfg.triggers.regime) {
    pollCount++;
    if (pollCount === 1 || pollCount % Math.max(1, cfg.regimeEveryNPolls) === 0) {
      const regimeChanges = await runRegime();
      for (const ch of regimeChanges) if (ch && ch.line) emit(ch.line);
    }
  }

  // ---- MOVE events (price crossing your threshold) ----
  if (cfg.triggers.price && cfg.movePctThreshold != null) {
    const thr = Math.abs(cfg.movePctThreshold);
    const step = Math.abs(cfg.reArmStepPct || 0);
    for (const sym in quotes) {
      const q = quotes[sym];
      if (!q || q.pct == null) continue;
      const mag = Math.abs(q.pct);
      const lastFlagged = state.movedTickers[sym];
      if (mag >= thr && (lastFlagged == null || mag >= Math.abs(lastFlagged) + step)) {
        const label = q.marketState === 'PRE' ? 'premarket' : q.marketState === 'POST' ? 'after hours' : 'vs prior close';
        emit(`MOVE ${sym} ${q.pct > 0 ? '+' : ''}${q.pct}% · ${label}`);
        state.movedTickers[sym] = q.pct;
      }
    }
  }

  state.seenPostUrls = [...seenPosts];
  state.seenNewsKeys = [...seenNews];
  state.seenThemeKeys = [...seenThemes];
  state.seenFilingKeys = [...seenFilings];
  saveState(state);
}

(async () => {
  const once = process.argv.includes('--once');
  await poll();
  if (once) return; // single poll for the scheduled task; the loop is for the in-session Monitor run
  const cfg = loadConfig();
  setInterval(poll, Math.max(1, cfg.pollMinutes) * 60 * 1000);
})();
