#!/usr/bin/env node
/*
 * regime engine.js — the market-context layer for the brief/intraday system.
 *
 * Synthesizes 7 self-referential macro voters into one risk-on / risk-off read with named
 * drivers. Same trust model as the brief scripts: pulls free public data at runtime (Yahoo
 * chart API, treasury.gov CSV, FRED keyless CSV, CNN Fear&Greed) — no app, no login, no install.
 *
 * The 7 voters (each votes on / off / abstain — NO weights, NO invented cutoffs):
 *   curve     10y-2y < 0 (inverted)                    inverted   -> off    treasury.gov daily CSV
 *   dollar    DXY vs its own 20-day avg                above avg  -> off    Yahoo DX-Y.NYB
 *   vol       VIX > VIX3M (backwardation)              backward.  -> off    Yahoo ^VIX ^VIX3M
 *   credit    HY spread vs its own trailing 20-obs avg above avg  -> off    FRED BAMLH0A0HYM2
 *   rotation  defensives (XLP/XLU/XLV) 5d vs other 8   def. lead  -> off    Yahoo sector SPDRs
 *   breadth   RSP/SPY ratio vs its own 20-day avg      below avg  -> off    Yahoo RSP SPY
 *   sentiment CNN Fear&Greed zone                      fear off / greed on  CNN dataviz
 *
 * Regime label = plurality of on vs off votes; "Mixed" on a tie / all-abstain. Drivers = the
 * components voting the winning side. A feed that fails makes its voter abstain (status carried),
 * never a fabricated value.
 *
 * Non-voting context (named, never scored): overnight ^N225/^GDAXI/^HSI last % change;
 * rate expectations from ZQ=F (implied = 100 - price).
 *
 * Stress flags (independent of the vote, compared to the prior run): VIX backwardation trips,
 * curve sign flip, HY spread at a new 20-obs high. A trip is a loud STRESS change; a clear is
 * digest-only.
 *
 * Output: stdout is ALWAYS a single JSON object { regime, components, context, stress, changes }.
 * The `changes` array is what intraday-watch.js maps to event lines. First run primes silently
 * (records the baseline, emits an empty changes array). State persists to "regime state.json";
 * one row per run is appended to "regime history.csv" (the distribution Jad reads before ever
 * setting a numeric cutoff).
 *
 * Usage:
 *   node "regime engine.js"            run once, print JSON
 *   node "regime engine.js" --verbose  also print a human breakdown to stderr
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'regime state.json');
const HISTORY_FILE = path.join(DIR, 'regime history.csv');
const VERBOSE = process.argv.includes('--verbose');
const CHANGELOG_CAP = 200;

const UA = 'Mozilla/5.0 (regime-engine; local research tool) AppleWebKit/537.36';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CNN_FNG_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.cnn.com/markets/fear-and-greed',
  Origin: 'https://www.cnn.com',
};
const REQUEST_TIMEOUT_MS = 12000;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

// ---- http (mirrors Sector Desk getJson: AbortController + UA, one retry on failure) ---------
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
function median(a) {
  const v = a.filter((x) => x != null).slice().sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
// 5-trading-day return (matches Sector Desk ret())
function retN(closes, back) {
  if (!closes || closes.length <= back) return null;
  const a = closes[closes.length - 1 - back], b = closes[closes.length - 1];
  if (!a || !b) return null;
  return (b / a) - 1;
}

// Yahoo daily closes + the bar date of the last point (for as-of stamping).
async function yahooDaily(sym) {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=2mo&interval=1d';
  const j = await getJson(u);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no chart result for ' + sym);
  const ts = res.timestamp || [];
  const rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  const closes = [];
  let lastTs = null;
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null) { closes.push(rawCloses[i]); if (ts[i]) lastTs = ts[i] * 1000; }
  }
  return { closes, asOfMs: lastTs };
}

// ---- voter computations -----------------------------------------------------
// Each returns { state, vote, detail, asOfMs, status, raw } where vote ∈ on|off|abstain.
// On any fetch failure the voter abstains with a status string — never a fabricated value.

async function voteCurve() {
  try {
    const yr = new Date().getFullYear();
    const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
      + yr + '/all?type=daily_treasury_yield_curve&field_tdr_date_value=' + yr + '&page&_format=csv';
    const txt = await getText(url);
    const lines = txt.trim().split(/\r?\n/);
    const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
    const i2 = header.indexOf('2 Yr'), i10 = header.indexOf('10 Yr'), iDate = 0;
    const row = lines[1].split(',');                 // CSV is newest-first
    const y2 = Number(row[i2]), y10 = Number(row[i10]);
    const spread = y10 - y2;
    const inverted = spread < 0;
    const asOfMs = Date.parse(row[iDate]) || null;
    return { state: inverted ? 'inverted' : 'normal', vote: inverted ? 'off' : 'on',
      detail: '10y-2y ' + round(spread, 2) + 'pp (2y ' + round(y2, 2) + ', 10y ' + round(y10, 2) + ')',
      asOfMs, status: 'ok', raw: { spread: round(spread, 2), y2: round(y2, 2), y10: round(y10, 2) } };
  } catch (e) { return abstain('curve', e); }
}

async function voteDollar() {
  try {
    const { closes, asOfMs } = await yahooDaily('DX-Y.NYB');
    const win = closes.slice(-20);
    const avg = mean(win), last = closes[closes.length - 1];
    const above = last > avg;
    return { state: above ? 'above 20d avg' : 'below 20d avg', vote: above ? 'off' : 'on',
      detail: 'DXY ' + round(last, 2) + ' vs 20d avg ' + round(avg, 2),
      asOfMs, status: 'ok', raw: { last: round(last, 2), avg: round(avg, 2), gap: round(last - avg, 2) } };
  } catch (e) { return abstain('dollar', e); }
}

async function voteVol() {
  try {
    const [vix, vix3m] = await Promise.all([yahooDaily('^VIX'), yahooDaily('^VIX3M')]);
    const a = vix.closes[vix.closes.length - 1], b = vix3m.closes[vix3m.closes.length - 1];
    const back = a > b; // VIX above 3-month VIX = backwardation = stress
    return { state: back ? 'backwardation' : 'contango', vote: back ? 'off' : 'on',
      detail: 'VIX ' + round(a, 2) + ' vs VIX3M ' + round(b, 2),
      asOfMs: Math.max(vix.asOfMs || 0, vix3m.asOfMs || 0) || null, status: 'ok',
      raw: { vix: round(a, 2), vix3m: round(b, 2), diff: round(a - b, 2) } };
  } catch (e) { return abstain('vol', e); }
}

async function voteCredit() {
  try {
    const txt = await getText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2');
    const lines = txt.trim().split(/\r?\n/).slice(1); // drop header (observation_date,BAMLH0A0HYM2)
    const obs = [];
    for (const ln of lines) {
      const [d, v] = ln.split(',');
      const n = Number(v);
      if (!isNaN(n) && v !== '.') obs.push({ date: d, v: n });
    }
    const last = obs[obs.length - 1];
    const win = obs.slice(-20).map((o) => o.v);
    const avg = mean(win);
    const above = last.v > avg;
    const newHigh = last.v >= Math.max(...win); // for the stress flag
    return { state: above ? 'above 20-obs avg' : 'below 20-obs avg', vote: above ? 'off' : 'on',
      detail: 'HY spread ' + round(last.v, 2) + 'pp vs 20-obs avg ' + round(avg, 2) + 'pp (as of ' + last.date + ')',
      asOfMs: Date.parse(last.date) || null, status: 'ok',
      raw: { spread: round(last.v, 2), avg: round(avg, 2), newHigh } };
  } catch (e) { return abstain('credit', e); }
}

async function voteRotation() {
  const DEF = ['XLP', 'XLU', 'XLV'];
  const OTH = ['XLE', 'XLF', 'XLK', 'XLI', 'XLY', 'XLB', 'XLRE', 'XLC'];
  try {
    const all = await Promise.all([...DEF, ...OTH].map((s) => yahooDaily(s).then((d) => ({ s, r: retN(d.closes, 5), asOfMs: d.asOfMs }))));
    const by = Object.fromEntries(all.map((x) => [x.s, x.r]));
    const defMed = median(DEF.map((s) => by[s]));
    const othMed = median(OTH.map((s) => by[s]));
    const defLead = defMed > othMed; // defensives outrunning cyclicals = risk-off rotation
    return { state: defLead ? 'defensives leading' : 'cyclicals leading', vote: defLead ? 'off' : 'on',
      detail: 'defensives 5d ' + round(defMed * 100, 1) + '% vs others ' + round(othMed * 100, 1) + '%',
      asOfMs: Math.max(...all.map((x) => x.asOfMs || 0)) || null, status: 'ok',
      raw: { defMedPct: round(defMed * 100, 1), othMedPct: round(othMed * 100, 1), diffPct: round((defMed - othMed) * 100, 1) } };
  } catch (e) { return abstain('rotation', e); }
}

async function voteBreadth() {
  try {
    const [rsp, spy] = await Promise.all([yahooDaily('RSP'), yahooDaily('SPY')]);
    const n = Math.min(rsp.closes.length, spy.closes.length);
    const ratio = [];
    for (let i = 0; i < n; i++) ratio.push(rsp.closes[rsp.closes.length - n + i] / spy.closes[spy.closes.length - n + i]);
    const last = ratio[ratio.length - 1];
    const avg = mean(ratio.slice(-20));
    const above = last >= avg; // equal-weight keeping up with cap-weight = broad participation
    return { state: above ? 'above 20d avg' : 'below 20d avg', vote: above ? 'on' : 'off',
      detail: 'RSP/SPY ' + round(last, 4) + ' vs 20d avg ' + round(avg, 4),
      asOfMs: Math.max(rsp.asOfMs || 0, spy.asOfMs || 0) || null, status: 'ok',
      raw: { ratio: round(last, 4), avg: round(avg, 4), gap: round(last - avg, 4) } };
  } catch (e) { return abstain('breadth', e); }
}

async function voteSentiment() {
  try {
    const j = await getJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: CNN_FNG_HEADERS });
    const fg = j.fear_and_greed;
    if (!fg) throw new Error('empty fear_and_greed');
    const rating = String(fg.rating || '');
    const r = rating.toLowerCase();
    const vote = r.includes('fear') ? 'off' : r.includes('greed') ? 'on' : 'abstain';
    return { state: rating, vote, detail: 'Fear&Greed ' + Math.round(fg.score) + ' (' + rating + ')',
      asOfMs: typeof fg.timestamp === 'number' ? fg.timestamp : Date.parse(fg.timestamp) || null,
      status: 'ok', raw: { score: Math.round(fg.score), rating } };
  } catch (e) { return abstain('sentiment', e); }
}

function abstain(name, e) {
  return { state: 'unknown', vote: 'abstain', detail: name + ' feed unavailable',
    asOfMs: null, status: 'error: ' + (e && e.message ? e.message : 'unknown'), raw: {} };
}

// ---- non-voting context -----------------------------------------------------
async function getContext() {
  const ctx = { overnight: [], rates: null };
  const idx = [['^N225', 'Nikkei'], ['^GDAXI', 'DAX'], ['^HSI', 'Hang Seng']];
  await Promise.all(idx.map(async ([sym, name]) => {
    try {
      const { closes, asOfMs } = await yahooDaily(sym);
      const last = closes[closes.length - 1], prev = closes[closes.length - 2];
      const pct = prev ? round(((last / prev) - 1) * 100, 1) : null;
      ctx.overnight.push({ name, pct, asOfMs });
    } catch (e) { ctx.overnight.push({ name, pct: null, status: 'error' }); }
  }));
  try {
    const { closes, asOfMs } = await yahooDaily('ZQ=F');
    const last = closes[closes.length - 1], prev = closes[closes.length - 2];
    ctx.rates = { impliedRate: round(100 - last, 2), changeBp: prev ? round((last - prev) * 100, 1) : null, asOfMs };
  } catch (e) { ctx.rates = { status: 'error' }; }
  return ctx;
}

// ---- synthesis --------------------------------------------------------------
const VOTER_ORDER = ['curve', 'dollar', 'vol', 'credit', 'rotation', 'breadth', 'sentiment'];
// plain-words driver label per voter, used in the REGIME-FLIP drivers list
const DRIVER_WORD = {
  curve: (c) => 'curve ' + (c.state === 'inverted' ? 'inverted' : 'positive'),
  dollar: (c) => 'dollar ' + (c.vote === 'off' ? 'strong' : 'soft'),
  vol: (c) => 'VIX ' + (c.state === 'backwardation' ? 'backwardated' : 'in contango'),
  credit: (c) => 'credit spreads ' + (c.vote === 'off' ? 'widening' : 'tight'),
  rotation: (c) => (c.vote === 'off' ? 'defensives leading' : 'cyclicals leading'),
  breadth: (c) => 'breadth ' + (c.vote === 'on' ? 'broad' : 'narrow'),
  sentiment: (c) => 'sentiment ' + (c.state || '').toLowerCase(),
};

function synthesize(components) {
  let on = 0, off = 0;
  for (const k of VOTER_ORDER) {
    if (components[k].vote === 'on') on++;
    else if (components[k].vote === 'off') off++;
  }
  let label, winSide;
  if (on > off) { label = 'risk-on'; winSide = 'on'; }
  else if (off > on) { label = 'risk-off'; winSide = 'off'; }
  else { label = 'Mixed'; winSide = null; }
  const drivers = winSide
    ? VOTER_ORDER.filter((k) => components[k].vote === winSide).map((k) => DRIVER_WORD[k](components[k]))
    : [];
  const tally = winSide ? Math.max(on, off) + '-' + Math.min(on, off) : on + '-' + off;
  return { label, tally, drivers, on, off };
}

function computeStress(components) {
  return {
    vixBackwardation: components.vol.state === 'backwardation',
    curveInverted: components.curve.state === 'inverted',
    hySpreadNew20High: !!(components.credit.raw && components.credit.raw.newHigh),
  };
}

// ---- state + history --------------------------------------------------------
function loadState() {
  try { return readJson(STATE_FILE); } catch (e) { return null; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { /* best-effort */ }
}

const HISTORY_HEADER = [
  'timestamp', 'label', 'tally',
  'curve_state', 'curve_spread',
  'dollar_state', 'dollar_last', 'dollar_avg',
  'vol_state', 'vix', 'vix3m', 'vol_diff',
  'credit_state', 'hy_spread', 'hy_avg',
  'rotation_state', 'def_5d_pct', 'oth_5d_pct', 'rotation_diff_pct',
  'breadth_state', 'rsp_spy', 'breadth_avg',
  'sentiment_state', 'fng_score',
].join(',');

function appendHistory(nowIso, regime, c) {
  const g = (o, k) => (o && o[k] != null ? o[k] : '');
  const row = [
    nowIso, regime.label, regime.tally,
    c.curve.state, g(c.curve.raw, 'spread'),
    c.dollar.state, g(c.dollar.raw, 'last'), g(c.dollar.raw, 'avg'),
    c.vol.state, g(c.vol.raw, 'vix'), g(c.vol.raw, 'vix3m'), g(c.vol.raw, 'diff'),
    c.credit.state, g(c.credit.raw, 'spread'), g(c.credit.raw, 'avg'),
    c.rotation.state, g(c.rotation.raw, 'defMedPct'), g(c.rotation.raw, 'othMedPct'), g(c.rotation.raw, 'diffPct'),
    c.breadth.state, g(c.breadth.raw, 'ratio'), g(c.breadth.raw, 'avg'),
    c.sentiment.state, g(c.sentiment.raw, 'score'),
  ].map((v) => (typeof v === 'string' && v.includes(',') ? '"' + v + '"' : v)).join(',');
  try {
    if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, HISTORY_HEADER + '\n', 'utf8');
    fs.appendFileSync(HISTORY_FILE, row + '\n', 'utf8');
  } catch (e) { /* best-effort */ }
}

// ---- main -------------------------------------------------------------------
(async () => {
  const components = {};
  const [curve, dollar, vol, credit, rotation, breadth, sentiment] = await Promise.all([
    voteCurve(), voteDollar(), voteVol(), voteCredit(), voteRotation(), voteBreadth(), voteSentiment(),
  ]);
  Object.assign(components, { curve, dollar, vol, credit, rotation, breadth, sentiment });
  const context = await getContext();

  const regime = synthesize(components);
  const stress = computeStress(components);

  const prior = loadState();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const changes = [];

  // changeLog carries every change (loud + quiet) for the on-demand digest
  const changeLog = (prior && Array.isArray(prior.changeLog)) ? prior.changeLog.slice() : [];
  const logChange = (kind, line) => { changeLog.push({ ts: nowMs, kind, line }); };

  if (!prior || !prior.primed) {
    // prime: record baseline, fire nothing
    const state = {
      regime, components, context, stress,
      macroSeen: [], changeLog: changeLog.slice(-CHANGELOG_CAP),
      lastDigestMs: nowMs, primed: true, updatedMs: nowMs,
    };
    saveState(state);
    appendHistory(nowIso, regime, components);
    output(regime, components, context, stress, []);
    return;
  }

  // per-voter quiet REGIME changes (skip abstain<->known noise: only fire on a real state change
  // between two known states)
  for (const k of VOTER_ORDER) {
    const was = prior.components && prior.components[k];
    if (was && was.state !== components[k].state && was.vote !== 'abstain' && components[k].vote !== 'abstain') {
      const line = 'REGIME ' + k + ' ' + was.state + ' -> ' + components[k].state;
      changes.push({ kind: 'REGIME', line });
      logChange('REGIME', line);
    }
  }

  // loud REGIME-FLIP on label change
  if (prior.regime && prior.regime.label !== regime.label) {
    const line = 'REGIME-FLIP ' + prior.regime.label + ' -> ' + regime.label + ' · ' + regime.tally
      + ' · drivers: ' + (regime.drivers.join(', ') || 'none');
    changes.push({ kind: 'REGIME-FLIP', line });
    logChange('REGIME-FLIP', line);
  }

  // stress flags: a trip (false->true) is loud; a clear (true->false) is digest-only
  const STRESS_DETAIL = {
    vixBackwardation: () => 'VIX backwardation | ' + components.vol.detail,
    curveInverted: () => 'curve inverted | ' + components.curve.detail,
    hySpreadNew20High: () => 'HY spread 20-obs high | ' + components.credit.detail,
  };
  const priorStress = prior.stress || {};
  for (const flag of Object.keys(stress)) {
    if (stress[flag] && !priorStress[flag]) {
      const line = 'STRESS ' + STRESS_DETAIL[flag]();
      changes.push({ kind: 'STRESS', line });
      logChange('STRESS', line);
    } else if (!stress[flag] && priorStress[flag]) {
      logChange('STRESS-CLEAR', 'STRESS-CLEAR ' + flag); // digest-only, not in loud changes
    }
  }

  const state = {
    regime, components, context, stress,
    macroSeen: prior.macroSeen || [],
    changeLog: changeLog.slice(-CHANGELOG_CAP),
    lastDigestMs: prior.lastDigestMs || nowMs,
    primed: true, updatedMs: nowMs,
  };
  saveState(state);
  appendHistory(nowIso, regime, components);
  output(regime, components, context, stress, changes);
})().catch((e) => {
  // never crash the caller: emit a valid (empty-changes) JSON envelope with the error noted
  process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e), changes: [] }) + '\n');
  process.exit(0);
});

function output(regime, components, context, stress, changes) {
  process.stdout.write(JSON.stringify({ regime, components, context, stress, changes }) + '\n');
  if (VERBOSE) {
    const L = [];
    L.push('REGIME: ' + regime.label + ' (' + regime.tally + ')  drivers: ' + (regime.drivers.join(', ') || 'none'));
    for (const k of VOTER_ORDER) {
      const c = components[k];
      const asOf = c.asOfMs ? new Date(c.asOfMs).toISOString().slice(0, 10) : 'n/a';
      L.push('  ' + k.padEnd(10) + (c.vote || '').padEnd(8) + c.detail + '  [as of ' + asOf + (c.status === 'ok' ? '' : ', ' + c.status) + ']');
    }
    const tripped = Object.entries(stress).filter(([, v]) => v).map(([k]) => k);
    L.push('  stress: ' + (tripped.length ? tripped.join(', ') : 'none'));
    L.push('  context: ' + context.overnight.map((o) => o.name + ' ' + (o.pct == null ? 'n/a' : o.pct + '%')).join(', ')
      + (context.rates && context.rates.impliedRate != null ? ' | fed-funds implied ' + context.rates.impliedRate + '%' : ''));
    if (changes.length) L.push('  changes: ' + changes.map((c) => c.line).join(' || '));
    process.stderr.write(L.join('\n') + '\n');
  }
}
