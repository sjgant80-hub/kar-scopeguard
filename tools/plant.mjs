// tools/plant.mjs — S5 in CLAIMS.md: plant each high rule's weakening into the real held-out diffs and count how often
// the kernel flags it on the planted file. Reads the diffs again with git (the calibration file names the commits).
//
//   node tools/plant.mjs [--cal data/calibration-held.json] [--root C:/Users/sjgan] [--out data/planted.json]
//
// A plant edits the diff text only: it inserts or rewrites lines inside an existing hunk of a file of the right kind
// and adjusts that hunk's @@ header, or appends one whole file block (a deleted test, a renamed test, a binary test).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, parseDiff, classify, parseScope, isAssertion, assertionShape } from '../kernel.mjs';

const NO_SCOPE = parseScope('');
const JS = /\.(?:[cm]?[jt]sx?)$/i;
const lang = (p) => (JS.test(p) ? 'js' : /\.py$/.test(p) ? 'py' : /\.go$/.test(p) ? 'go' : 'other');

// the text of one file block in the diff, and the 0-based line index of each of its hunk headers
function blocks(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (l.startsWith('diff --git ')) { cur = { start: i, hunks: [] }; out.push(cur); }
    else if (cur && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l)) cur.hunks.push(i);
  });
  return { lines, blocks: out };
}
const HDR = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function bump(lines, h, dOld, dNew) {
  const m = lines[h].match(HDR);
  const oc = (m[2] === undefined ? 1 : +m[2]) + dOld; const nc = (m[4] === undefined ? 1 : +m[4]) + dNew;
  lines[h] = '@@ -' + m[1] + ',' + oc + ' +' + m[3] + ',' + nc + ' @@' + m[5];
}
// the hunk body lines (indices) of the hunk whose header is at h
function body(lines, h) {
  const m = lines[h].match(HDR);
  let o = m[2] === undefined ? 1 : +m[2]; let n = m[4] === undefined ? 1 : +m[4];
  const idx = [];
  for (let i = h + 1; i < lines.length && (o > 0 || n > 0); i++) {
    const c = lines[i][0];
    if (c === '\\') continue;
    idx.push(i);
    if (c === '-') o--; else if (c === '+') n--; else { o--; n--; }
  }
  return idx;
}

const looser = (s) => {
  const sh = assertionShape(s);
  if (!sh || sh.strength !== 'strict' || sh.subjects.length === 0) return null;
  const ind = s.match(/^\s*/)[0];
  const subj = sh.subjects[0];
  if (/(?:^|[^\w.$])expect\s*\(/.test(s)) return ind + 'expect(' + subj + ').toBeDefined();';
  if (/^\s*assert\s/.test(s)) return ind + 'assert ' + subj;
  if (/\bself\.assert/.test(s)) return ind + 'self.assertTrue(' + subj + ')';
  return ind + 'assert.ok(' + subj + ');';
};

/** each plant: { rule, kinds, apply(lines, fileBlock, hunkHeader) -> boolean (true when it planted) } */
export const PLANTS = [
  { rule: 'skip-added', kind: 'test', insert: (p) => ({ js: "it.skip('planted', () => {});", py: '@pytest.mark.skip(reason="planted")', go: '\tt.Skip("planted")' })[lang(p)] },
  { rule: 'only-added', kind: 'test', insert: (p) => (lang(p) === 'js' ? "it.only('planted', () => {});" : null) },
  { rule: 'assert-commented', kind: 'test', rewrite: (s, p) => (isAssertion(s) ? s.replace(/^(\s*)/, lang(p) === 'py' ? '$1# ' : '$1// ') : null) },
  { rule: 'assert-neutered', kind: 'test', rewrite: (s, p) => (isAssertion(s) ? s.match(/^\s*/)[0] + (lang(p) === 'py' ? 'assert True' : 'expect(true).toBe(true);') : null) },
  { rule: 'matcher-loosened', kind: 'test', rewrite: (s) => looser(s) },
  { rule: 'tolerance-widened', kind: 'test', pair: (p) => (lang(p) === 'py' ? ['    self.assertAlmostEqual(a, b, places=7)', '    self.assertAlmostEqual(a, b, places=1)'] : ['  expect(x).toBeCloseTo(0.3, 6);', '  expect(x).toBeCloseTo(0.3, 1);']) },
  { rule: 'failure-ignored', kind: 'gate', insert: (p) => (/\.ya?ml$/.test(p) ? '        continue-on-error: true' : /package\.json$/.test(p) ? '    "posttest": "npm run x || true",' : null) },
  { rule: 'test-run-removed', kind: 'gate', remove: (s) => /\bnpm\s+(?:run\s+)?test\b|\bnode\s+(?:--\S+\s+)*--test\b|\/witness@|\bwitness(?:-bench)?\.mjs\b|\bpytest\b/.test(s) },
  { rule: 'threshold-lowered', kind: 'gate', pair: () => ['      "lines": 90,', '      "lines": 50,'] },
  { rule: 'check-turned-off', kind: 'gate', pair: () => ['    "strict": true,', '    "strict": false,'] },
  { rule: 'test-script-noop', kind: 'gate', only: /(?:^|\/)package\.json$/, insert: () => '    "test": "echo ok",' },
  { rule: 'test-file-deleted', block: () => 'diff --git a/test/planted.test.js b/test/planted.test.js\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/test/planted.test.js\n+++ /dev/null\n@@ -1,3 +1,0 @@\n-test(\'planted\', () => {\n-  expect(f()).toBe(1);\n-});', path: 'test/planted.test.js' },
  { rule: 'test-moved-out', block: () => 'diff --git a/src/planted.test.js b/src/planted.js.off\nsimilarity index 100%\nrename from src/planted.test.js\nrename to src/planted.js.off', path: 'src/planted.js.off' },
  { rule: 'unreadable-binary', block: () => 'diff --git a/test/planted.test.bin b/test/planted.test.bin\nindex 1111111..2222222 100644\nBinary files a/test/planted.test.bin and b/test/planted.test.bin differ', path: 'test/planted.test.bin' },
];

/** plant one rule into one diff text: { text, path } or null when the diff has no place for it */
export function plant(text, P) {
  const { lines, blocks: bs } = blocks(text.replace(/\r\n/g, '\n'));
  if (P.block) {
    const t = text.replace(/\r\n/g, '\n').replace(/\n?$/, '\n') + P.block() + '\n';
    return { text: t, path: P.path };
  }
  const parsed = parseDiff(text);
  if (!parsed.ok) return null;
  for (let b = 0; b < bs.length && b < parsed.files.length; b++) {
    const f = parsed.files[b];
    if (f.binary || f.status === 'deleted' || bs[b].hunks.length === 0) continue;
    if (classify(f.path, NO_SCOPE).kind !== P.kind) continue;
    if (P.only && !P.only.test(f.path)) continue;
    const h = bs[b].hunks[0];
    if (P.insert) {
      const ins = P.insert(f.path);
      if (!ins) continue;
      const at = body(lines, h)[0] ?? h + 1;
      lines.splice(at, 0, '+' + ins); bump(lines, h, 0, 1);
      return { text: lines.join('\n'), path: f.path };
    }
    if (P.pair) {
      const [r, a] = P.pair(f.path);
      const at = body(lines, h)[0] ?? h + 1;
      lines.splice(at, 0, '-' + r, '+' + a); bump(lines, h, 1, 1);
      return { text: lines.join('\n'), path: f.path };
    }
    for (const hh of bs[b].hunks) {
      for (const i of body(lines, hh)) {
        if (lines[i][0] !== ' ') continue;
        const s = lines[i].slice(1);
        if (P.remove) {
          if (!P.remove(s)) continue;
          lines[i] = '-' + s; bump(lines, hh, 0, -1);
          return { text: lines.join('\n'), path: f.path };
        }
        const rw = P.rewrite(s, f.path);
        if (!rw) continue;
        lines.splice(i, 1, '-' + s, '+' + rw);
        return { text: lines.join('\n'), path: f.path };
      }
    }
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const cal = JSON.parse(readFileSync(opt('--cal', join(here, '..', 'data', 'calibration-held.json')), 'utf8'));
  const root = opt('--root', 'C:/Users/sjgan');
  const out = opt('--out', join(here, '..', 'data', 'planted.json'));
  const repos = new Map(JSON.parse(readFileSync(join(here, 'repos.json'), 'utf8')).map((r) => [r.repo, r.d]));
  const tally = new Map(PLANTS.map((p) => [p.rule, { rule: p.rule, copies: 0, caught: 0, missed: [] }]));
  for (const rec of cal.records) {
    if (rec.refused || rec.error) continue;
    const diff = execFileSync('git', ['-C', join(root, repos.get(rec.repo)), 'show', '--format=', '--no-color', '--no-ext-diff', '-M', rec.sha], { encoding: 'utf8', maxBuffer: 1 << 28 });
    for (const P of PLANTS) {
      const p = plant(diff, P);
      if (!p) continue;
      const r = audit(p.text);
      const t = tally.get(P.rule);
      t.copies++;
      if (r.ok && r.findings.some((f) => f.rule === P.rule && f.path === p.path)) t.caught++;
      else t.missed.push({ repo: rec.repo, sha: rec.sha, path: p.path, why: r.ok ? 'no finding' : r.why });
    }
  }
  const rules = [...tally.values()].map((t) => ({ rule: t.rule, copies: t.copies, caught: t.caught, missed: t.missed.slice(0, 5) }));
  const res = { kind: 'kar-scopeguard.planted', from: 'held-out half', rules, copies: rules.reduce((s, r) => s + r.copies, 0), caught: rules.reduce((s, r) => s + r.caught, 0) };
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  for (const r of rules) console.log(r.rule.padEnd(20), r.caught + '/' + r.copies, r.missed.length ? JSON.stringify(r.missed[0]) : '');
  console.log('all', res.caught + '/' + res.copies);
}
