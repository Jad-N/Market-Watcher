// current picture.js — the deterministic fusion assembler.
//
// Reads what the sensors already wrote (no new fetching) and co-locates it into one
// facts-only snapshot: current picture.json. One macro block + one card per trading-section
// name. FACTS ONLY — no scores, no thresholds, no stance. A missing input is OMITTED, never
// defaulted to null/0/"" (an absent field is honest; a fabricated one silently lies).
//
// The briefs read this file, then Claude writes the one-line Positioning judgment on top and
// logs it to read history.csv. This file is the facts half of that hybrid.
//
//   node "current picture.js"                 (uses now as the as-of stamp)
//   node "current picture.js" 2026-06-11T20:00:00Z   (explicit as-of)

const fs = require('fs');
const path = require('path');

// --- tiny standalone helpers (kept local on purpose; see system map.md "what's not glued") ---
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}
function readCsv(p) {
  let txt;
  try { txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; }
  const lines = txt.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return null;
  const headers = lines[0].split(',');
  const noteIdx = headers.length - 1; // last column (note) may contain commas — join the tail
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = i < noteIdx ? (parts[i] ?? '') : parts.slice(noteIdx).join(',');
    });
    return row;
  });
  return { headers, rows };
}
function num(v) { return v === '' || v == null ? undefined : Number(v); }
function iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined; }
// drop undefined keys so absent sources never render as null/0/""
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
}

function assemble(opts) {
  const dir = opts.dir;
  const sectorDir = opts.sectorDir;
  const asOf = opts.asOf;
  const asOfDate = (asOf || '').slice(0, 10);

  const symbolMap = readJson(path.join(dir, 'symbol map.json')) || { symbols: [] };
  const regime = readJson(path.join(dir, 'regime state.json'));
  const desk = readJson(path.join(sectorDir, 'sector-desk-summary.json'));
  const cikMap = readJson(path.join(sectorDir, 'ticker-to-sec-id.json'));
  const intraday = readJson(path.join(dir, 'intraday state.json'));
  const stories = readJson(path.join(dir, 'running stories.json'));
  const sentiment = readCsv(path.join(dir, 'sentiment history.csv'));
  const raw = latestRawPulls(path.join(dir, 'Briefs'));

  const tradingNames = (symbolMap.symbols || []).filter((s) => s.section === 'trading');

  // ---- macro block ----
  const macro = compact({
    regime: regime && regime.regime ? compact({
      label: regime.regime.label,
      tally: regime.regime.tally,
      drivers: regime.regime.drivers,
    }) : undefined,
    stress: regime && regime.stress ? regime.stress : undefined,
    gauges: buildGauges(regime, intraday, asOfDate),
    sectorDesk: desk ? compact({ leader: desk.leader, laggard: desk.laggard, avgCorr: desk.avgCorr }) : undefined,
  });

  // ---- per-name lookups ----
  const latestSentByTicker = latestSentiment(sentiment);
  const catalystByTicker = catalystsByTicker(desk);
  const fired = firedToday(intraday, symbolMap, cikMap, asOfDate);
  const liveStories = (stories && Array.isArray(stories.stories) ? stories.stories : [])
    .filter((s) => s && s.status === 'live');

  const names = tradingNames.map((sym) => {
    const t = sym.ticker;
    const q = raw && raw.data.quotes ? raw.data.quotes[t] : undefined;
    const sent = latestSentByTicker[t];
    const cat = catalystByTicker[t];
    const story = liveStories.find((s) => Array.isArray(s.tickers) && s.tickers.includes(t));
    return compact({
      ticker: t,
      price: q ? compact({ last: q.last, pct: q.pct, asOf: raw.asOf }) : undefined,
      sentiment: sent ? compact({
        bullRatio: num(sent.st_bull_ratio),
        sampleSize: num(sent.st_tagged),
        velocity: num(sent.st_msgs_per_hour),
        newsCount: num(sent.news_unique),
      }) : undefined,
      latestCatalyst: cat ? compact({
        type: cat.type, label: cat.label, form: cat.form, filedAt: iso(cat.filedAt), url: cat.url,
      }) : undefined,
      firedToday: fired[t] && fired[t].length ? fired[t] : undefined,
      story: story ? compact({ title: story.title, latest: story.latest }) : undefined,
    });
  });

  return compact({
    asOf,
    source: compact({
      rawPulls: raw ? raw.file : undefined,
      regimeUpdated: regime ? iso(regime.updatedMs) : undefined,
      sectorDeskGenerated: desk ? iso(desk.generatedAtMs) : undefined,
    }),
    macro,
    names,
  });
}

// pick the raw pulls file with the latest generatedAt across the most recent date folder(s)
function latestRawPulls(briefsDir) {
  let dates;
  try { dates = fs.readdirSync(briefsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); }
  catch { return null; }
  for (let i = dates.length - 1; i >= 0; i--) {
    const folder = path.join(briefsDir, dates[i]);
    let files;
    try { files = fs.readdirSync(folder).filter((f) => /^raw pulls \(.*\)\.json$/.test(f)); }
    catch { continue; }
    let best = null;
    for (const f of files) {
      const data = readJson(path.join(folder, f));
      if (!data) continue;
      const ts = Date.parse(data.generatedAt || '') || 0;
      if (!best || ts > best.ts) best = { ts, data, file: `Briefs/${dates[i]}/${f}`, asOf: data.asOfET || data.generatedAt };
    }
    if (best) return best;
  }
  return null;
}

function buildGauges(regime, intraday, asOfDate) {
  const out = [];
  const fg = regime && regime.components && regime.components.sentiment && regime.components.sentiment.raw;
  if (fg && (fg.score != null || fg.rating)) out.push(compact({ name: 'Fear&Greed', score: fg.score, rating: fg.rating }));
  // crypto fear/greed: only a label exists (no score) — and only if it's today's intraday state
  const cryptoFG = intraday && intraday.gaugeRating && intraday.gaugeRating['CryptoF&G'];
  if (intraday && intraday.date === asOfDate && cryptoFG) {
    out.push({ name: 'CryptoF&G', rating: cryptoFG });
  }
  return out.length ? out : undefined;
}

// latest row per real ticker (skip pseudo-rows: benchmarks, _RUN_, gauges)
function latestSentiment(sentiment) {
  const by = {};
  if (!sentiment) return by;
  for (const r of sentiment.rows) {
    const t = r.ticker;
    if (!t || t.startsWith('_') || r.run_type === 'benchmark') continue;
    const ts = Date.parse(r.timestamp || '') || 0;
    if (!by[t] || ts >= by[t]._ts) { by[t] = r; by[t]._ts = ts; }
  }
  return by;
}

// most-recent catalyst per ticker from the sector desk's top list
function catalystsByTicker(desk) {
  const by = {};
  if (!desk || !Array.isArray(desk.topCatalysts)) return by;
  for (const c of desk.topCatalysts) {
    if (!c.ticker) continue;
    if (!by[c.ticker] || (c.filedAt || 0) > (by[c.ticker].filedAt || 0)) by[c.ticker] = c;
  }
  return by;
}

// what fired today, per ticker: company X posts + material SEC filings (Form 4 / insider excluded)
function firedToday(intraday, symbolMap, cikMap, asOfDate) {
  const out = {};
  if (!intraday || intraday.date !== asOfDate) return out;
  const push = (t, chip) => { (out[t] = out[t] || []); if (!out[t].includes(chip)) out[t].push(chip); };

  // posts: nitter handle -> ticker via the verified X handle in symbol map
  const handleToTicker = {};
  for (const s of (symbolMap.symbols || [])) {
    if (s.x && s.x.handle) handleToTicker[s.x.handle.toLowerCase()] = s.ticker;
  }
  for (const url of (intraday.seenPostUrls || [])) {
    const m = /nitter\.net\/([^/]+)\/status/i.exec(url);
    if (!m) continue;
    const t = handleToTicker[m[1].toLowerCase()];
    if (t) push(t, `POST @${m[1]}`);
  }

  // filings: EDGAR CIK -> ticker; skip insider Form 4 / ownership filings (system never alerts those)
  const cikToTicker = {};
  if (cikMap && cikMap.names) {
    for (const [t, info] of Object.entries(cikMap.names)) cikToTicker[String(Number(info.cik))] = t;
  }
  for (const url of (intraday.seenFilingKeys || [])) {
    if (/form4|ownership/i.test(url)) continue;
    const m = /\/data\/(\d+)\//.exec(url);
    if (!m) continue;
    const t = cikToTicker[String(Number(m[1]))];
    if (t) push(t, 'FILING');
  }
  return out;
}

module.exports = { assemble };

// --- CLI ---
if (require.main === module) {
  const dir = __dirname;
  const sectorDir = path.join(__dirname, '..', 'Sector Desk');
  const asOf = process.argv[2] || new Date().toISOString();
  const picture = assemble({ dir, sectorDir, asOf });
  const outPath = path.join(dir, 'current picture.json');
  fs.writeFileSync(outPath, JSON.stringify(picture, null, 2), 'utf8');
  const n = (picture.names || []).length;
  console.log(`current picture.json written — as of ${asOf} — ${n} name card(s), macro block ${picture.macro ? 'present' : 'ABSENT'}.`);
}
