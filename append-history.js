#!/usr/bin/env node
/*
 * append-history.js — appends deterministic rows per run to "sentiment history.csv".
 * Schema v2. Built for the knowledge base's deterministic-backtest goal: a timestamped
 * sentiment-and-attention-vs-price record, with no LLM judgment in the numbers.
 *
 * Reads everything it needs from the raw feed JSON (which now carries Yahoo quotes),
 * so prices come from one source. --prices can still override per ticker if a run wants
 * TradingView's numbers in the history instead.
 *
 * Per run it writes:
 *   - one row per ticker (sentiment + attention + price)
 *   - one benchmark row per index (SPY, QQQ) so relative strength is computable later
 *   - gauge rows (_FEARGREED_, _CRYPTOFNG_): market-wide sentiment. score normalized 0-1
 *     in st_bull_ratio; full detail (rating, prior values) as key=value in note. Schema v2.
 *   - one _RUN_ status row, so a missing run is distinguishable from a quiet day
 *
 * Usage:
 *   node append-history.js --raw "Briefs/2026-06-11/raw pulls (morning).json" --csv "sentiment history.csv"
 *   [--runtype morning|evening] [--prices '{"TSLA":-2.1}']
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--raw') a.raw = argv[++i];
    else if (k === '--runtype') a.runtype = argv[++i];
    else if (k === '--prices') a.prices = argv[++i];
    else if (k === '--csv') a.csv = argv[++i];
  }
  return a;
}

const COLUMNS = [
  'timestamp', 'date', 'run_type', 'ticker',
  'st_window_msgs', 'st_msgs_per_hour', 'st_bullish', 'st_bearish', 'st_tagged', 'st_bull_ratio',
  'reddit_relevant', 'news_unique', 'price_pct', 'note',
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowToLine(obj) {
  return COLUMNS.map((c) => csvCell(obj[c])).join(',');
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.raw || !args.csv) { console.error('Required: --raw <json> --csv <path>'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(args.raw, 'utf8'));
  const priceOverride = args.prices ? JSON.parse(args.prices) : {};
  const ts = raw.generatedAt || new Date().toISOString();
  const dateStr = ts.slice(0, 10);
  const runType = args.runtype || raw.runType || 'adhoc';
  const tickers = (raw.symbols || []).map((s) => (typeof s === 'string' ? s : s.ticker));

  const rows = [];

  for (const ticker of tickers) {
    const st = raw.sources?.stocktwits?.byTicker?.[ticker] || {};
    const rd = raw.sources?.reddit?.tickerMentions?.[ticker] || {};
    const news = raw.sources?.tickerNews?.[ticker] || {};
    const quote = raw.quotes?.[ticker] || {};
    const price = ticker in priceOverride ? Number(priceOverride[ticker]) : (quote.pct ?? null);

    rows.push({
      timestamp: ts, date: dateStr, run_type: runType, ticker,
      st_window_msgs: st.windowMessages ?? '',
      st_msgs_per_hour: st.msgsPerHour ?? '',
      st_bullish: st.bullish ?? '',
      st_bearish: st.bearish ?? '',
      st_tagged: st.tagged ?? '',
      st_bull_ratio: st.bullRatio ?? '',
      reddit_relevant: rd.count ?? '',
      news_unique: news.unique ?? '',
      price_pct: price === null || price === undefined ? '' : Math.round(price * 10) / 10,
      note: '',
    });
  }

  // benchmark rows (index relative-strength baseline)
  for (const b of raw.marketState?.benchmarks || []) {
    rows.push({
      timestamp: ts, date: dateStr, run_type: 'benchmark', ticker: b.ticker,
      st_window_msgs: '', st_msgs_per_hour: '', st_bullish: '', st_bearish: '', st_tagged: '', st_bull_ratio: '',
      reddit_relevant: '', news_unique: '',
      price_pct: b.pct === null || b.pct === undefined ? '' : Math.round(b.pct * 10) / 10,
      note: '',
    });
  }

  // market-wide sentiment gauges — dedicated rows (NOT new columns: the CSV is append-only,
  // widening the header would ragged-pad every prior row). score normalized 0-1 in st_bull_ratio
  // (it IS a bullishness ratio); full detail as key=value in note. Still schema v2.
  const g = raw.sources?.sentimentGauges || {};
  if (g.fearGreed) {
    rows.push({
      timestamp: ts, date: dateStr, run_type: runType, ticker: '_FEARGREED_',
      st_window_msgs: '', st_msgs_per_hour: '', st_bullish: '', st_bearish: '', st_tagged: '',
      st_bull_ratio: Math.round(g.fearGreed.score) / 100,
      reddit_relevant: '', news_unique: '', price_pct: '',
      note: `score=${g.fearGreed.score};rating=${g.fearGreed.rating};prev_close=${g.fearGreed.previousClose};week_ago=${g.fearGreed.previous1Week};month_ago=${g.fearGreed.previous1Month}`,
    });
  }
  if (g.cryptoFearGreed) {
    rows.push({
      timestamp: ts, date: dateStr, run_type: runType, ticker: '_CRYPTOFNG_',
      st_window_msgs: '', st_msgs_per_hour: '', st_bullish: '', st_bearish: '', st_tagged: '',
      st_bull_ratio: Math.round(g.cryptoFearGreed.value) / 100,
      reddit_relevant: '', news_unique: '', price_pct: '',
      note: `value=${g.cryptoFearGreed.value};rating=${g.cryptoFearGreed.rating};yesterday=${g.cryptoFearGreed.yesterdayValue}`,
    });
  }

  // _RUN_ status row — proves a run happened; a date gap means a missed run, not a calm market
  const ss = raw.sourceStatus || {};
  const degraded = Object.entries(ss)
    .filter(([, v]) => Array.isArray(v) ? v.some((x) => !/: ok$/.test(x)) : (v !== 'ok' && v !== 'n/a'))
    .map(([k]) => k);
  rows.push({
    timestamp: ts, date: dateStr, run_type: runType, ticker: '_RUN_',
    st_window_msgs: '', st_msgs_per_hour: '', st_bullish: '', st_bearish: '', st_tagged: '', st_bull_ratio: '',
    reddit_relevant: '', news_unique: tickers.length, price_pct: '',
    note: 'window=' + (raw.windowHours ?? '?') + 'h; sources_ok=' + (degraded.length ? 'no(' + degraded.join('|') + ')' : 'yes'),
  });

  const csvPath = args.csv;
  if (!fs.existsSync(csvPath)) {
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, COLUMNS.join(',') + '\n', 'utf8');
  }
  fs.appendFileSync(csvPath, rows.map(rowToLine).join('\n') + '\n', 'utf8');
  console.error(`Appended ${rows.length} rows (${tickers.length} tickers + benchmarks + run status) to ${csvPath}`);
}

main();
