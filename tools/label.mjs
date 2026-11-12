// tools/label.mjs — turn hand labels into data/labels-<half>.json, taking every commit hash from the calibration file
// itself (a label never carries a typed hash). A hand label names repo, rule and path; it applies to every high finding
// with that repo, rule and path. Any high finding left without a label is listed and the tool exits 1.
//   node tools/label.mjs tune data/annotations-tune.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [half, annFile] = process.argv.slice(2);
const cal = JSON.parse(readFileSync(join(root, 'data', 'calibration-' + half + '.json'), 'utf8'));
const ann = JSON.parse(readFileSync(join(root, annFile), 'utf8'));
const items = []; const missing = [];
for (const rec of cal.records) for (const f of (rec.findings || []).filter((x) => x.severity === 'high')) {
  const a = ann.items.find((x) => x.repo === rec.repo && x.rule === f.rule && x.path === f.path);
  if (!a) { missing.push(rec.repo + ' ' + rec.sha + ' ' + f.rule + ' ' + f.path + ' | ' + f.text); continue; }
  items.push({ repo: rec.repo, sha: rec.sha, rule: f.rule, path: f.path, label: a.label, why: a.why });
}
if (missing.length) { console.error('unlabelled high findings:\n' + missing.join('\n')); process.exit(1); }
writeFileSync(join(root, 'data', 'labels-' + half + '.json'), JSON.stringify({ kind: 'kar-scopeguard.labels', half, how: ann.how, items }, null, 1) + '\n');
console.log(items.length + ' labels written for the ' + half + ' half');
