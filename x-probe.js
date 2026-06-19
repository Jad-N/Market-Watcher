#!/usr/bin/env node
/*
 * x-probe.js — Step 1 of the X-feed improvement plan: MEASURE the real failure.
 *
 * Probes each verified company handle ONCE via the live pipeline's own functions
 * (syndication primary, then nitter independently — not fallback-only, because the
 * plan asks "does nitter return anything from the runner?"). Records per handle:
 * syndication HTTP status + post count + identity match, and nitter status + post
 * count. Stamps each run with the public IP and where it ran (GitHub runner vs
 * local residential), so the baseline table can answer: IS the runner IP the
 * throttle source?
 *
 * No auth, no install, read-only. Respects the 1500ms syndication throttle so the
 * probe itself never trips the IP-wide rate limit (~40 quick calls = persistent 429).
 *
 * Usage:  node x-probe.js [--symbols-file "symbol map.json"]
 * Output: a readable table + one `X-PROBE-RESULT <json>` line, and one CSV row per
 *         handle appended to x-probe-log.csv (runner) / x-probe-log.local.csv (local).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchCompanyPostsSyndication, fetchCompanyPostsNitter, identityMatches, loadSymbols, hoursSinceLastClose } = require('./fetch-feeds.js');

const X_THROTTLE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

// Free IP echo — fetching DATA, not software (same exception as the RSS/JSON feeds).
async function publicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return j.ip || 'unknown';
  } catch (e) { return 'unknown'; }
}

async function probeSyndication(handle, name, windowHours) {
  try {
    const res = await fetchCompanyPostsSyndication(handle, windowHours);
    return { status: 'ok', http: 200, posts: res.posts.length, profileName: res.profileName || null, identity: identityMatches(res.profileName, name) };
  } catch (err) {
    return { status: err.status === 429 ? 'rate_limited(429)' : (err.status ? `http ${err.status}` : `error: ${err.message}`), http: err.status || null, posts: 0, profileName: null, identity: false };
  }
}

async function probeNitter(handle, windowHours) {
  try {
    const res = await fetchCompanyPostsNitter(handle, windowHours);
    return { status: 'ok', posts: res.posts.length };
  } catch (err) {
    return { status: err.status ? `http ${err.status}` : `error: ${err.message}`, posts: 0 };
  }
}

async function main() {
  const symbolsFile = arg('--symbols-file', path.join(__dirname, 'symbol map.json'));
  const { entries } = loadSymbols({ symbolsFile });
  const handles = entries.filter((e) => e.class === 'equity' && e.x && e.x.handle);
  const windowHours = hoursSinceLastClose();

  const onRunner = !!process.env.GITHUB_ACTIONS;
  const env = onRunner ? 'runner' : 'local';
  const ip = await publicIp();
  const tsIso = new Date().toISOString();

  console.error(`X-probe — env=${env} ip=${ip} window=${windowHours}h handles=${handles.length}  ${tsIso}`);
  console.error('handle                synd-status          posts  identity  nitter-status        posts');
  console.error('-------------------------------------------------------------------------------------------');

  const rows = [];
  for (const e of handles) {
    const synd = await probeSyndication(e.x.handle, e.x.name, windowHours);
    await sleep(X_THROTTLE_MS);
    const nit = await probeNitter(e.x.handle, windowHours);
    await sleep(X_THROTTLE_MS);
    rows.push({ ticker: e.ticker, handle: e.x.handle, synd, nit });
    console.error(
      `${(e.x.handle).padEnd(20)}  ${synd.status.padEnd(19)}  ${String(synd.posts).padStart(4)}   ${String(synd.identity).padEnd(7)}  ${nit.status.padEnd(19)}  ${String(nit.posts).padStart(4)}`
    );
  }

  // summary
  const syndOk = rows.filter((r) => r.synd.status === 'ok').length;
  const syndRL = rows.filter((r) => r.synd.status.startsWith('rate_limited')).length;
  const nitOk = rows.filter((r) => r.nit.status === 'ok').length;
  const summary = {
    ts: tsIso, env, ip, windowHours, handles: handles.length,
    syndOk, syndRateLimited: syndRL, syndOther: handles.length - syndOk - syndRL,
    nitOk, nitDead: handles.length - nitOk,
  };
  console.error('-------------------------------------------------------------------------------------------');
  console.error(`SUMMARY  synd ok=${syndOk}/${handles.length} rate_limited=${syndRL}  |  nitter ok=${nitOk}/${handles.length}`);
  console.log('X-PROBE-RESULT ' + JSON.stringify(summary));

  // append CSV (env-specific file so local residential rows never collide with the committed runner log)
  const csvFile = path.join(__dirname, onRunner ? 'x-probe-log.csv' : 'x-probe-log.local.csv');
  const header = 'ts,env,ip,ticker,handle,synd_status,synd_http,synd_posts,identity,nitter_status,nitter_posts\n';
  if (!fs.existsSync(csvFile)) fs.writeFileSync(csvFile, header);
  const csvRows = rows.map((r) =>
    [tsIso, env, ip, r.ticker, r.handle, r.synd.status, r.synd.http ?? '', r.synd.posts, r.synd.identity, r.nit.status, r.nit.posts]
      .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')
  ).join('\n') + '\n';
  fs.appendFileSync(csvFile, csvRows);
  console.error(`Appended ${rows.length} rows to ${path.basename(csvFile)}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
