// test-current-picture.js — standalone assertion test for the assembler (no test framework).
//   node "test-current-picture.js"   → prints PASS/FAIL lines, exits 0 on all-pass, 1 otherwise.
//
// Builds two throwaway fixture dirs in the OS temp folder and checks the two load-bearing
// invariants: a missing source is OMITTED (never defaulted), and a present source is shaped right.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assemble } = require('./current picture.js');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// makes a fresh fixture: dir (briefs side) + sectorDir, with only the files you pass in
function fixture(name, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cp-${name}-`));
  const dir = path.join(root, 'briefs');
  const sectorDir = path.join(root, 'sector');
  fs.mkdirSync(dir); fs.mkdirSync(sectorDir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rel.startsWith('sector/') ? sectorDir : dir, rel.replace(/^sector\//, ''));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return { dir, sectorDir };
}

// ---- Case 1: only a symbol map with one trading name + one regime file. Everything else missing. ----
{
  const f = fixture('sparse', {
    'symbol map.json': { symbols: [{ ticker: 'IREN', section: 'trading' }, { ticker: 'NVDA', section: 'macro' }] },
    'regime state.json': { regime: { label: 'risk-off', tally: '4-3', drivers: ['x'] }, stress: { a: false } },
  });
  const p = assemble({ dir: f.dir, sectorDir: f.sectorDir, asOf: '2026-06-11T20:00:00Z' });
  check('sparse: one card per trading name only', p.names.length === 1 && p.names[0].ticker === 'IREN',
    `${p.names.length} card(s)`);
  check('sparse: regime present from file', !!(p.macro && p.macro.regime && p.macro.regime.label === 'risk-off'), '');
  check('sparse: sectorDesk OMITTED (no file)', !(p.macro && p.macro.sectorDesk), '');
  check('sparse: name has no price/sentiment/catalyst (no sources)',
    !p.names[0].price && !p.names[0].sentiment && !p.names[0].latestCatalyst, '');
  check('sparse: no null anywhere in output', !JSON.stringify(p).includes('null'), '');
}

// ---- Case 2: full sources for one name → every block shaped right. ----
{
  const f = fixture('full', {
    'symbol map.json': { symbols: [{ ticker: 'IREN', section: 'trading', x: { handle: 'IRENco' } }] },
    'regime state.json': {
      regime: { label: 'risk-off', tally: '4-3', drivers: ['dollar strong'] },
      stress: { vixBackwardation: false },
      components: { sentiment: { raw: { score: 30, rating: 'fear' } } },
      updatedMs: 1781200000000,
    },
    'intraday state.json': { date: '2026-06-11', gaugeRating: { 'CryptoF&G': 'Extreme Fear' },
      seenPostUrls: ['https://nitter.net/IRENco/status/1#m'],
      seenFilingKeys: ['https://www.sec.gov/Archives/edgar/data/1878848/000/deal_8k.htm',
        'https://www.sec.gov/Archives/edgar/data/1878848/000/form4.xml'] },
    'running stories.json': { stories: [{ title: 'AI capex', latest: 'still hot', status: 'live', tickers: ['IREN'] }] },
    'sentiment history.csv':
      'timestamp,date,run_type,ticker,st_window_msgs,st_msgs_per_hour,st_bullish,st_bearish,st_tagged,st_bull_ratio,reddit_relevant,news_unique,price_pct,note\n' +
      '2026-06-11T15:00:00.000Z,2026-06-11,morning,IREN,90,4.7,30,3,33,0.909,0,5,-0.2,\n' +
      '2026-06-11T15:00:00.000Z,2026-06-11,benchmark,SPY,,,,,,,,,-1.3,\n',
    'sector/sector-desk-summary.json': { leader: 'WULF', laggard: 'NBIS', avgCorr: 0.71, generatedAtMs: 1781200000000,
      topCatalysts: [{ ticker: 'IREN', type: 'financing/dilution', label: 'Stock offering', form: '424B3', filedAt: 1780000000000, url: 'http://x' }] },
    'sector/ticker-to-sec-id.json': { names: { IREN: { cik: '0001878848' } } },
  });
  // a raw pulls file so price resolves
  fs.mkdirSync(path.join(f.dir, 'Briefs', '2026-06-11'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'Briefs', '2026-06-11', 'raw pulls (evening).json'),
    JSON.stringify({ generatedAt: '2026-06-11T22:00:00.000Z', asOfET: '2026-06-11 22:00 ET', quotes: { IREN: { last: 56.7, pct: 5 } } }));

  const p = assemble({ dir: f.dir, sectorDir: f.sectorDir, asOf: '2026-06-11T20:00:00Z' });
  const n = p.names[0];
  check('full: price block shaped', !!(n.price && n.price.last === 56.7 && n.price.pct === 5), JSON.stringify(n.price));
  check('full: sentiment block shaped', !!(n.sentiment && n.sentiment.bullRatio === 0.909 && n.sentiment.sampleSize === 33), JSON.stringify(n.sentiment));
  check('full: catalyst block shaped', !!(n.latestCatalyst && n.latestCatalyst.type === 'financing/dilution'), '');
  check('full: firedToday has post + filing, NO form4', JSON.stringify(n.firedToday) === JSON.stringify(['POST @IRENco', 'FILING']), JSON.stringify(n.firedToday));
  check('full: live story attached', !!(n.story && n.story.title === 'AI capex'), '');
  check('full: gauges = Fear&Greed(score+rating) + CryptoF&G(rating only)',
    p.macro.gauges.length === 2 && p.macro.gauges[0].score === 30 && p.macro.gauges[1].score === undefined, JSON.stringify(p.macro.gauges));
  check('full: no null anywhere', !JSON.stringify(p).includes('null'), '');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
