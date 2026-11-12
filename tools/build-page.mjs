// tools/build-page.mjs — write the measured figures into index.html, at build time, so the page needs no network.
//   node tools/build-page.mjs           (rewrite the data block)
//   node tools/build-page.mjs --check   (exit 1 if the page's block is not what the data files give)
// Every high finding in a calibration file must carry a hand label in data/labels-<half>.json, or this refuses.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
export const LABELS = Object.freeze(['real weakening', 'false alarm', 'cannot read']);
const key = (x) => [x.repo, x.sha, x.rule, x.path].join('|');

/** the figures for one half: counts, and each flagged commit's label (real beats false alarm beats cannot read) */
export function half(cal, labels) {
  const lab = new Map(labels.items.map((x) => [key(x), x]));
  for (const x of labels.items) if (!LABELS.includes(x.label)) throw new Error('unknown label ' + x.label + ' for ' + key(x));
  const s = cal.summary;
  const counts = { real: 0, falseAlarm: 0, cannotRead: 0 };
  const items = [];
  let reviewAny = 0;
  for (const rec of cal.records) {
    const fs = rec.findings || [];
    if (fs.some((f) => f.severity === 'review')) reviewAny++;
    const high = fs.filter((f) => f.severity === 'high');
    if (high.length === 0) continue;
    const ls = high.map((f) => {
      const l = lab.get(key({ repo: rec.repo, sha: rec.sha, rule: f.rule, path: f.path }));
      if (!l) throw new Error('no label for ' + rec.repo + ' ' + rec.sha + ' ' + f.rule + ' ' + f.path);
      items.push({ repo: rec.repo, sha: rec.sha, rule: f.rule, path: f.path, label: l.label, why: l.why });
      return l.label;
    });
    if (ls.includes('real weakening')) counts.real++; else if (ls.includes('false alarm')) counts.falseAlarm++; else counts.cannotRead++;
  }
  return { repos: s.repos, commitsSeen: s.commitsSeen, checked: s.checked, refused: s.refused, clean: s.clean, review: s.review, flagged: s.flagged, reviewAny, labels: counts, items };
}

const plantedOf = (p) => ({ rules: p.rules.map((r) => ({ rule: r.rule, copies: r.copies, caught: r.caught })), copies: p.copies, caught: p.caught });

export function measured() {
  const tune = half(read('data/calibration-tune.json'), read('data/labels-tune.json'));
  const held = half(read('data/calibration-held.json'), read('data/labels-held.json'));
  delete tune.items;
  // the sealed record: the held-out half read once, on the frozen v1 kernel (CLAIMS.md S4)
  const v1cal = read('data/v1/calibration-held.json');
  const v1 = {
    kernelSha256: v1cal.kernelSha256, commit: '9e580e8',
    tune: half(read('data/v1/calibration-tune.json'), read('data/v1/labels-tune.json')),
    held: half(v1cal, read('data/v1/labels-held.json')),
    planted: plantedOf(read('data/v1/planted.json')),
  };
  delete v1.tune.items;
  const planted = read('data/planted.json');
  const w = read('receipts/witness.json');
  const b = read('vendor/sovereign-enterprise/data/basis.json');
  const pick = (k) => ({ value: b[k].value, unit: b[k].unit || '', what: b[k].what, source: b[k].source });
  return {
    generated: read('data/calibration-held.json').at || w.at,
    v1, tune, held,
    planted: plantedOf(planted),
    witness: { gates: w.gates.map((g) => ({ file: g.file, total: g.total, killed: g.killed, survived: g.survived, baselined: g.baselined, clean: g.clean })) },
    basis: { wageMedianHourly: pick('wageMedianHourly'), cpi: pick('cpi') },
  };
}

const OPEN = '<script type="application/json" id="measured">';
export function withBlock(html, m) {
  const i = html.indexOf(OPEN); const j = html.indexOf('</script>', i);
  if (i < 0 || j < 0) throw new Error('no measured block in the page');
  return html.slice(0, i + OPEN.length) + JSON.stringify(m).replace(/</g, '\\u003c') + html.slice(j);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const page = join(root, 'index.html');
  const html = readFileSync(page, 'utf8');
  const next = withBlock(html, measured());
  if (process.argv.includes('--check')) { if (next !== html) { console.error('index.html: the measured block is stale; run node tools/build-page.mjs'); process.exit(1); } console.log('index.html measured block is current'); }
  else { writeFileSync(page, next); console.log('index.html measured block written'); }
}
