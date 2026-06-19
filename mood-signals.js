#!/usr/bin/env node
/*
 * mood-signals.js — extra market-mood signals for the live feed / briefs.
 *
 * Sibling of "regime engine.js": same trust model (free public Yahoo data at runtime,
 * no app / login / install), same honesty rules (compare each thing to its OWN recent
 * average or a natural majority/boundary — NO invented cutoffs; a dead feed marks the
 * signal unavailable, never a fabricated value), same history-CSV-so-Jad-sets-thresholds
 * -later pattern.
 *
 * Three plain-language groups (DISPLAY + LOG only — these are NOT regime voters yet):
 *   Risk appetite   racy-vs-steady stocks (SPHB/SPLV), junk-bond demand (HYG/LQD)
 *   Fear hedging    crash-insurance demand (^SKEW), safe-haven scorecard (gold/bonds/yen/dollar)
 *   Crowd breadth   how many of the 11 S&P sectors are above their 200-day / 50-day trend
 *
 * Dropped on purpose: put/call ratio — CBOE blocks it from this network (^SKEW carries the
 * crash-fear read instead).
 *
 * These barely move within a trading day, so they compute ONCE PER ET TRADING DAY and the
 * cached block is reused on every later run (the 15-min cloud cron calls this each cycle but
 * only hits Yahoo once a day). Force a recompute with FEED_FORCE=1 or --force.
 *
 * Output: stdout is ALWAYS a single JSON object (the block the page renders as `moodSignals`).
 * State persists to "mood-signals state.json"; one row per recompute is appended to
 * "mood-signals history.csv".
 *
 * Usage:
 *   node "mood-signals.js"            run once, print the block (cached if already done today)
 *   node "mood-signals.js" --force    ignore the daily cache, recompute now
 *   node "mood-signals.js" --verbose  also print a human breakdown to stderr
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'mood-signals state.json');
const HISTORY_FILE = path.join(DIR, 'mood-signals history.csv');
const FORCE = process.argv.includes('--force') || process.env.FEED_FORCE === '1';
const VERBOSE = process.argv.includes('--verbose');

const UA = 'Mozilla/5.0 (mood-signals; local research tool) AppleWebKit/537.36';
const REQUEST_TIMEOUT_MS = 12000;

// ---- http (mirrors regime engine: AbortController + UA, one retry) ----------
async function getText(url, { headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' });
      const text = await r.text();
      clearTimeout(t);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      return text;
    } catch (e) { clearTimeout(t); lastErr = e; }
  }
  throw lastErr;
}
async function getJson(url, opts) { return JSON.parse(await getText(url, opts)); }

// ---- helpers ----------------------------------------------------------------
const round = (x, d = 2) => (x == null || isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function sma(closes, n) { if (!closes || closes.length < n) return null; return mean(closes.slice(-n)); }
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const etNice = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

// One year of daily closes + the bar date of the newest point (enough for a 200-day average).
async function yahooDaily(sym) {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d';
  const j = await getJson(u, { headers: { Accept: 'application/json' } });
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no chart result for ' + sym);
  const ts = res.timestamp || [];
  const raw = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  const closes = [];
  let lastTs = null;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] != null) { closes.push(raw[i]); if (ts[i]) lastTs = ts[i] * 1000; }
  }
  return { closes, asOfMs: lastTs };
}

// last value of numerator/denominator ratio vs its own trailing n-day average
function ratioVsAvg(numCloses, denCloses, n = 20) {
  const m = Math.min(numCloses.length, denCloses.length);
  const ratio = [];
  for (let i = 0; i < m; i++) ratio.push(numCloses[numCloses.length - m + i] / denCloses[denCloses.length - m + i]);
  const last = ratio[ratio.length - 1];
  const avg = mean(ratio.slice(-n));
  return { last, avg };
}
// 1-bar % change of a close series
function dayChange(closes) {
  if (!closes || closes.length < 2) return null;
  const a = closes[closes.length - 2], b = closes[closes.length - 1];
  return a ? (b / a - 1) : null;
}

// ---- fetch every symbol once (each failure isolated to its own signal) ------
const SECTORS = ['XLP', 'XLU', 'XLV', 'XLE', 'XLF', 'XLK', 'XLI', 'XLY', 'XLB', 'XLRE', 'XLC'];
const SYMS = ['SPHB', 'SPLV', 'HYG', 'LQD', '^SKEW', 'GC=F', 'TLT', 'JPY=X', 'DX-Y.NYB', ...SECTORS];

async function fetchAll() {
  const out = {};
  await Promise.all(SYMS.map(async (s) => {
    try { out[s] = await yahooDaily(s); }
    catch (e) { out[s] = { closes: [], asOfMs: null, err: e.message }; }
  }));
  return out;
}

const ok = (d) => d && d.closes && d.closes.length;
const unavailable = (key, label) => ({ key, label, state: 'unavailable', lean: 'neutral', detail: 'data feed unavailable', status: 'error', raw: {} });

// ---- the five signals -------------------------------------------------------
function sigRacyVsSteady(m) {
  const a = m['SPHB'], b = m['SPLV'];
  if (!ok(a) || !ok(b)) return unavailable('racyVsSteady', 'Racy vs steady stocks');
  const { last, avg } = ratioVsAvg(a.closes, b.closes);
  const on = last > avg;
  return {
    key: 'racyVsSteady', label: 'Racy vs steady stocks',
    state: on ? 'Reaching for risk' : 'Favoring safety',
    lean: on ? 'risk-on' : 'risk-off',
    detail: on ? 'racy stocks beating steady ones lately' : 'steady stocks holding up better',
    status: 'ok', raw: { ratio: round(last, 4), avg: round(avg, 4) },
  };
}
function sigJunkDemand(m) {
  const a = m['HYG'], b = m['LQD'];
  if (!ok(a) || !ok(b)) return unavailable('junkDemand', 'Junk-bond demand');
  const { last, avg } = ratioVsAvg(a.closes, b.closes);
  const on = last > avg;
  return {
    key: 'junkDemand', label: 'Junk-bond demand',
    state: on ? 'Lending freely to risky firms' : 'Backing away from risky debt',
    lean: on ? 'risk-on' : 'risk-off',
    detail: on ? 'junk bonds in demand vs safe bonds' : 'money rotating to safer bonds',
    status: 'ok', raw: { ratio: round(last, 4), avg: round(avg, 4) },
  };
}
function sigCrashInsurance(m) {
  const d = m['^SKEW'];
  if (!ok(d)) return unavailable('crashInsurance', 'Crash-insurance demand');
  const last = d.closes[d.closes.length - 1];
  const avg = mean(d.closes.slice(-20));
  const elevated = last > avg; // higher SKEW = more tail-hedging = more fear
  return {
    key: 'crashInsurance', label: 'Crash-insurance demand',
    state: elevated ? 'Bracing for a drop' : 'Little crash worry',
    lean: elevated ? 'risk-off' : 'risk-on',
    detail: elevated ? 'paying up for crash protection' : 'low demand for crash protection',
    status: 'ok', raw: { skew: round(last, 2), avg: round(avg, 2) },
  };
}
function sigSafeHaven(m) {
  // each haven "bid" = buyers showing up today. Yen is USD/JPY, so yen-bid = USD/JPY DOWN.
  const havens = [
    { name: 'gold', d: m['GC=F'], invert: false },
    { name: 'bonds', d: m['TLT'], invert: false },
    { name: 'yen', d: m['JPY=X'], invert: true },
    { name: 'dollar', d: m['DX-Y.NYB'], invert: false },
  ];
  const present = havens.filter((h) => ok(h.d));
  if (!present.length) return unavailable('safeHaven', 'Safe-haven scorecard');
  const changes = {};
  const bid = [];
  for (const h of present) {
    const chg = dayChange(h.d.closes);
    changes[h.name] = round((chg || 0) * 100, 2);
    const isBid = h.invert ? chg < 0 : chg > 0;
    if (isBid) bid.push(h.name);
  }
  const n = bid.length, total = present.length;
  const lean = n === total ? 'risk-off' : n === 0 ? 'risk-on' : 'neutral';
  return {
    key: 'safeHaven', label: 'Safe-haven scorecard',
    state: `${n} of ${total} safe havens bid`,
    lean,
    detail: n ? `${bid.join(', ')} rising${n === total ? ' — flight to safety' : ''}` : 'no safe havens bid — calm',
    status: 'ok', raw: { bid: n, total, changes },
  };
}
function sectorsAbove(m, n, key, label, trendWord) {
  const present = SECTORS.map((s) => m[s]).filter(ok);
  if (present.length < SECTORS.length) {
    // partial data would understate the count; only report when all 11 are in
    return unavailable(key, label);
  }
  let above = 0;
  for (const s of SECTORS) {
    const c = m[s].closes;
    const avg = sma(c, n);
    if (avg != null && c[c.length - 1] > avg) above++;
  }
  const total = SECTORS.length;
  const lean = above / total > 0.5 ? 'risk-on' : above / total < 0.5 ? 'risk-off' : 'neutral';
  return {
    key, label,
    state: `${above} of ${total} sectors ${trendWord}`,
    lean,
    detail: `above their ${n}-day trend`,
    status: 'ok', raw: { above, total },
  };
}

function buildGroups(m) {
  return [
    {
      key: 'riskAppetite', title: 'Risk appetite', question: 'Reaching for risk, or hiding in safety?',
      signals: [sigRacyVsSteady(m), sigJunkDemand(m)],
    },
    {
      key: 'fearHedging', title: 'Fear hedging', question: 'How hard are people bracing for a drop?',
      signals: [sigCrashInsurance(m), sigSafeHaven(m)],
    },
    {
      key: 'breadth', title: 'Crowd breadth', question: 'Whole market rising, or just the giants?',
      signals: [
        sectorsAbove(m, 200, 'sectorsAbove200', 'Long-term uptrend', 'trending up'),
        sectorsAbove(m, 50, 'sectorsAbove50', 'Short-term uptrend', 'rising'),
      ],
    },
  ];
}

// ---- history ----------------------------------------------------------------
const HISTORY_HEADER = [
  'timestamp', 'asOfET',
  'racy_ratio', 'racy_avg', 'junk_ratio', 'junk_avg', 'skew', 'skew_avg',
  'havens_bid', 'gold_chg', 'bonds_chg', 'yen_chg', 'dollar_chg',
  'sectors_above_200', 'sectors_above_50',
].join(',');

function appendHistory(nowIso, block) {
  const by = {};
  for (const g of block.groups) for (const s of g.signals) by[s.key] = s;
  const r = (k) => (by[k] && by[k].raw) || {};
  const havenChg = (r('safeHaven').changes) || {};
  const row = [
    nowIso, (block.asOfET || '').replace(/,/g, ''),
    r('racyVsSteady').ratio ?? '', r('racyVsSteady').avg ?? '',
    r('junkDemand').ratio ?? '', r('junkDemand').avg ?? '',
    r('crashInsurance').skew ?? '', r('crashInsurance').avg ?? '',
    r('safeHaven').bid ?? '', havenChg.gold ?? '', havenChg.bonds ?? '', havenChg.yen ?? '', havenChg.dollar ?? '',
    r('sectorsAbove200').above ?? '', r('sectorsAbove50').above ?? '',
  ].join(',');
  try {
    if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, HISTORY_HEADER + '\n', 'utf8');
    fs.appendFileSync(HISTORY_FILE, row + '\n', 'utf8');
  } catch (e) { /* best-effort */ }
}

// ---- main -------------------------------------------------------------------
(async () => {
  const nowMs = Date.now();
  const today = etDate(nowMs);

  // daily cache: reuse today's block unless forced
  if (!FORCE) {
    try {
      const st = readJson(STATE_FILE);
      if (st && st.computedET === today && st.block) {
        process.stdout.write(JSON.stringify(st.block) + '\n');
        if (VERBOSE) process.stderr.write('mood-signals: cached (' + today + ')\n');
        return;
      }
    } catch (e) { /* no/invalid cache -> recompute */ }
  }

  const m = await fetchAll();
  const groups = buildGroups(m);
  const asOfMs = Math.max(0, ...Object.values(m).map((d) => (d && d.asOfMs) || 0)) || nowMs;
  const block = { asOfET: etNice(asOfMs), asOfMs, groups };

  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ computedET: today, computedMs: nowMs, block }, null, 2), 'utf8'); } catch (e) { /* best-effort */ }
  appendHistory(new Date(nowMs).toISOString(), block);

  process.stdout.write(JSON.stringify(block) + '\n');
  if (VERBOSE) {
    const L = ['mood-signals: recomputed (' + today + ')  as of ' + block.asOfET];
    for (const g of groups) {
      L.push('  ' + g.title);
      for (const s of g.signals) L.push('    ' + s.label.padEnd(26) + (s.lean || '').padEnd(9) + s.state + (s.status === 'ok' ? '' : '  [' + s.status + ']'));
    }
    process.stderr.write(L.join('\n') + '\n');
  }
})().catch((e) => {
  // never crash the caller: emit a valid (empty) block with the error noted
  process.stdout.write(JSON.stringify({ asOfET: null, asOfMs: null, groups: [], error: e && e.message ? e.message : String(e) }) + '\n');
  process.exit(0);
});
