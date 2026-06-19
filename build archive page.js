#!/usr/bin/env node
/*
 * build archive page.js — regenerates "archive.html" at the Market briefs root.
 *
 * No dependencies. Scans the Briefs/ folder for dated day-folders (YYYY-MM-DD),
 * groups them by week (newest first), and lists each day with links to its morning
 * brief / evening recap and a one-line summary. Run it after every brief build so the
 * archive stays current; a big story from Monday is one click away on Wednesday.
 *
 * Summary source, in order: evening data's meta.summary -> morning data's meta.summary
 * -> first sentence of the market read -> blank. Days that predate meta.summary degrade
 * gracefully to the read sentence.
 *
 * Usage:
 *   node "build archive page.js"                       (defaults: Briefs/ -> archive.html)
 *   node "build archive page.js" --briefs Briefs --out archive.html
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { briefs: 'Briefs', out: 'archive.html' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--briefs') a.briefs = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// pure UTC date math — no locale/TZ ambiguity. Returns {y,m,d, weekday, mondayKey}
function dateInfo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun
  const backToMon = (dow === 0 ? 6 : dow - 1);
  const mon = new Date(dt.getTime() - backToMon * 86400000);
  const monKey = `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, '0')}-${String(mon.getUTCDate()).padStart(2, '0')}`;
  return { y, m, d, weekday: WEEKDAYS[dow], mondayKey: monKey, monObj: mon };
}

function weekLabel(monKey) {
  const [y, m, d] = monKey.split('-').map(Number);
  return `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
}

function dayLabel(info) {
  return `${info.weekday} ${MONTHS[info.m - 1]} ${info.d}`;
}

// read a data json's summary safely; never throws
function readSummary(dir, which) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `data (${which}).json`), 'utf8'));
    if (j.meta && j.meta.summary) return j.meta.summary;
    const read = j.market && j.market.read;
    if (read) {
      const first = String(read).split(/(?<=[.!?])\s/)[0];
      return first.length > 150 ? first.slice(0, 147) + '…' : first;
    }
  } catch (e) { /* missing or corrupt -> no summary */ }
  return '';
}

function fileExists(dir, name) {
  try { return fs.existsSync(path.join(dir, name)); } catch (e) { return false; }
}

function main() {
  const args = parseArgs(process.argv);
  const briefsDir = args.briefs;
  let dirs = [];
  try {
    dirs = fs.readdirSync(briefsDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
  } catch (e) { console.error('No Briefs folder at ' + briefsDir); }
  dirs.sort().reverse(); // newest first

  const days = dirs.map((dateStr) => {
    const dir = path.join(briefsDir, dateStr);
    const hasMorning = fileExists(dir, 'morning brief.html');
    const hasEvening = fileExists(dir, 'evening recap.html');
    const summary = readSummary(dir, 'evening') || readSummary(dir, 'morning');
    return { dateStr, info: dateInfo(dateStr), hasMorning, hasEvening, summary };
  });

  // group by week (already newest-first, so weeks come out newest-first too)
  const weeks = [];
  const byKey = {};
  for (const day of days) {
    const k = day.info.mondayKey;
    if (!byKey[k]) { byKey[k] = { key: k, days: [] }; weeks.push(byKey[k]); }
    byKey[k].days.push(day);
  }

  const link = (dateStr, file, label) => {
    const href = `Briefs/${encodeURIComponent(dateStr)}/${encodeURIComponent(file)}`;
    return `<a class="lnk" href="${href}">${label}</a>`;
  };

  const rows = weeks.map((w) => {
    const dayRows = w.days.map((day) => {
      const morning = day.hasMorning ? link(day.dateStr, 'morning brief.html', 'morning') : '<span class="muted">—</span>';
      const evening = day.hasEvening ? link(day.dateStr, 'evening recap.html', 'evening') : '<span class="muted">—</span>';
      const summary = day.summary ? esc(day.summary) : (day.hasMorning || day.hasEvening ? '' : '<span class="muted">(run did not complete)</span>');
      return `      <div class="day">
        <div class="dlabel">${esc(dayLabel(day.info))}</div>
        <div class="dlinks">${morning} · ${evening}</div>
        <div class="dsum">${summary}</div>
      </div>`;
    }).join('\n');
    return `  <section class="week">
    <h2>${esc(weekLabel(w.key))}</h2>
${dayRows}
  </section>`;
  }).join('\n');

  const generatedAt = (process.env.ARCHIVE_STAMP || new Date().toISOString());
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Brief — Archive</title>
<style>
  :root {
    --bg:#0b0e13; --bg-grid:#11151d; --panel:#141923; --panel-2:#1b212d;
    --line:#262d3a; --line-soft:#1d232f; --ink:#e8ecf3; --ink-dim:#9aa4b6; --ink-faint:#5e6675;
    --amber:#f2b441; --amber-dim:#8a6a23; --accent:#5aa9ff;
    --mono:"Cascadia Mono","Consolas","SFMono-Regular",monospace;
    --head:"Bahnschrift","DIN Alternate","Segoe UI Semibold",sans-serif;
    --body:"Segoe UI","Corbel",system-ui,sans-serif;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    background:var(--bg);
    background-image:linear-gradient(var(--bg-grid) 1px,transparent 1px),linear-gradient(90deg,var(--bg-grid) 1px,transparent 1px);
    background-size:44px 44px;
    color:var(--ink); font-family:var(--body); font-size:15px; line-height:1.5; padding:0 0 64px;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:1080px; margin:0 auto; padding:0 28px; }
  header { border-bottom:1px solid var(--line); background:linear-gradient(180deg,rgba(20,25,35,0.9),rgba(11,14,19,0.4)); }
  .topbar { display:flex; align-items:baseline; justify-content:space-between; padding:18px 0 16px; gap:12px 20px; flex-wrap:wrap; }
  .brand { font-family:var(--head); font-weight:700; letter-spacing:0.18em; text-transform:uppercase; font-size:22px; }
  .brand .tag { font-size:11px; letter-spacing:0.2em; color:var(--bg); background:var(--amber); padding:3px 8px 2px; border-radius:2px; margin-left:10px; }
  .stamp { font-family:var(--mono); font-size:12px; color:var(--ink-faint); }
  .week { margin-top:36px; }
  .week h2 {
    font-family:var(--head); font-weight:600; text-transform:uppercase; letter-spacing:0.14em;
    font-size:13px; color:var(--amber); padding-bottom:8px; border-bottom:1px solid var(--line); margin-bottom:4px;
  }
  .day {
    display:grid; grid-template-columns:148px 150px 1fr; gap:16px; align-items:baseline;
    padding:11px 4px; border-bottom:1px solid var(--line-soft);
  }
  @media (max-width:680px){ .day { grid-template-columns:1fr; gap:3px; } }
  .dlabel { font-family:var(--mono); font-size:13px; color:var(--ink); }
  .dlinks { font-family:var(--mono); font-size:12.5px; color:var(--ink-faint); }
  .dsum { font-size:14px; color:var(--ink-dim); line-height:1.45; }
  a.lnk { color:var(--accent); text-decoration:none; }
  a.lnk:hover { color:#fff; text-decoration:underline; }
  .muted { color:var(--ink-faint); }
  .foot { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); font-family:var(--mono); font-size:11.5px; color:var(--ink-faint); }
</style>
</head>
<body>
<header>
  <div class="wrap topbar">
    <div class="brand">Market Brief <span class="tag">ARCHIVE</span></div>
    <div class="stamp">${esc(days.length)} day${days.length === 1 ? '' : 's'} · ${esc(weeks.length)} week${weeks.length === 1 ? '' : 's'}</div>
  </div>
</header>
<main class="wrap">
${rows || '  <p class="muted" style="margin-top:36px">No briefs yet.</p>'}
  <div class="foot">regenerated ${esc(generatedAt)}</div>
</main>
</body>
</html>
`;

  fs.writeFileSync(args.out, html, 'utf8');
  console.error(`Wrote ${args.out} (${days.length} days, ${weeks.length} weeks)`);
}

main();
