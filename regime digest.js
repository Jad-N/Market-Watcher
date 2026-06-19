#!/usr/bin/env node
/*
 * regime digest.js — on-demand "what changed in the regime since I last looked".
 *
 * Reads the changeLog in "regime state.json", prints everything since lastDigestMs grouped by
 * kind (loud flips/stress first, quiet voter moves after, stress clears last), then advances
 * lastDigestMs to now so the next digest only shows newer items.
 *
 * Usage:
 *   node "regime digest.js"          print the digest and advance the marker
 *   node "regime digest.js" --peek   print the digest WITHOUT advancing (preview)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = path.join(__dirname, 'regime state.json');
const PEEK = process.argv.includes('--peek');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

const etTime = (ms) => {
  try { return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
};

let state;
try { state = readJson(STATE_FILE); }
catch (e) { console.log('No regime state yet — run "regime engine.js" first.'); process.exit(0); }

const since = state.lastDigestMs || 0;
const log = (state.changeLog || []).filter((c) => c.ts > since);

if (!log.length) {
  console.log('No regime changes since ' + (since ? etTime(since) : 'the start') + '.');
} else {
  const ORDER = ['REGIME-FLIP', 'STRESS', 'REGIME', 'STRESS-CLEAR'];
  const TITLE = { 'REGIME-FLIP': 'Regime flips', STRESS: 'Stress flags tripped', REGIME: 'Component moves', 'STRESS-CLEAR': 'Stress flags cleared' };
  console.log('Regime changes since ' + (since ? etTime(since) : 'the start') + ':');
  for (const kind of ORDER) {
    const items = log.filter((c) => c.kind === kind);
    if (!items.length) continue;
    console.log('\n' + TITLE[kind] + ':');
    for (const it of items) console.log('  ' + etTime(it.ts) + ' — ' + it.line);
  }
}

if (!PEEK) {
  state.lastDigestMs = Date.now();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) { /* best-effort */ }
}
