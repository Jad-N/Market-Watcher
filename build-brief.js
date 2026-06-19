#!/usr/bin/env node
/*
 * build-brief.js — injects a day's data object into the HTML template, producing the
 * finished brief. The skill assembles the data object (market read, per-symbol takes,
 * merged feed data) and passes it here; this only does the template substitution so the
 * skill never hand-edits HTML.
 *
 * Usage:
 *   node build-brief.js --template brief-template.html --data "data.json" --out "brief.html"
 *
 * The template carries a single block between <!-- BRIEF_DATA_START --> and
 * <!-- BRIEF_DATA_END -->; everything between is replaced with the new data.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--template') a.template = argv[++i];
    else if (k === '--data') a.data = argv[++i];
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.template || !args.data || !args.out) {
    console.error('Required: --template <html> --data <json> --out <html>');
    process.exit(1);
  }
  const html = fs.readFileSync(args.template, 'utf8');
  const data = JSON.parse(fs.readFileSync(args.data, 'utf8'));

  const START = '<!-- BRIEF_DATA_START -->';
  const END = '<!-- BRIEF_DATA_END -->';
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  if (i === -1 || j === -1 || j < i) {
    console.error('Template markers not found.');
    process.exit(1);
  }

  // </script> inside the JSON must be broken up so it can't close the data block early.
  const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  const block = START + '\n<script>\nwindow.BRIEF_DATA = ' + json + ';\n</script>\n' + END;

  const out = html.slice(0, i) + block + html.slice(j + END.length);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, out, 'utf8');
  console.error('Wrote ' + args.out);
}

main();
