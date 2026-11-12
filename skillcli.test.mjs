// skillcli.test.mjs — the skill's command line as a pure step: the report, the fingerprints, every exit code and
// every refusal. This is the file the mutation gate runs against skillcli.mjs (skill.test.mjs checks the shipped script).
// Run: node --test skillcli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { skillRun, readInput } from './skillcli.mjs';
import { audit, fingerprintInput, fingerprintResult } from './kernel.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const SKIP = 'diff --git a/t/a.test.js b/t/a.test.js\nindex 1..2 100644\n--- a/t/a.test.js\n+++ b/t/a.test.js\n@@ -1,1 +1,1 @@\n-it("adds", () => {\n+it.skip("adds", () => {\n';

test('skillRun: the report, the fingerprints, every exit code and every refusal', () => {
  const files = { 'c.diff': SKIP, 's.txt': 'allow src/**\n', 'm.txt': 'changed t/a.test.js' };
  const read = (p) => { if (!(p in files)) throw new Error('ENOENT: ' + p); return files[p]; };
  const r = skillRun(['c.diff', '--scope', 's.txt', '--claim', 'm.txt'], read);
  assert.equal(r.code, 2);
  assert.equal(r.err, '');
  const j = JSON.parse(r.out);
  const res = audit(SKIP, 'allow src/**\n', 'changed t/a.test.js');
  assert.deepEqual(j, { verdict: 'flagged', ...res, fingerprints: { input: sha(fingerprintInput(SKIP, 'allow src/**\n', 'changed t/a.test.js')), result: sha(fingerprintResult(res)) } });
  assert.equal(skillRun(['c.diff'], read).code, 2);
  const scopeFirst = skillRun(['--scope', 's.txt', 'c.diff'], read);
  assert.deepEqual(JSON.parse(scopeFirst.out).findings.map((f) => f.rule), ['outside-scope', 'skip-added'], 'options may come before the diff');
  const claimAfter = skillRun(['c.diff', '--claim', 'm.txt'], read);
  assert.deepEqual([claimAfter.code, JSON.parse(claimAfter.out).verdict], [2, 'flagged'], 'the claim file is not read as the diff');
  const clean = skillRun(['x.diff'], () => 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual([clean.code, JSON.parse(clean.out).verdict], [0, 'clean']);
  const review = skillRun(['x.diff'], () => 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b // @ts-ignore\n');
  assert.deepEqual([review.code, JSON.parse(review.out).verdict], [0, 'review']);
  const bad = skillRun(['x.diff'], () => 'diff --cc x\n');
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out).verdict, 'unreadable');
  assert.equal(bad.err, 'could not read the diff: a combined merge diff cannot be checked: diff against one parent\n');
  const usage = 'usage: node kar-scopeguard.mjs <diff-file|-> [--scope FILE] [--claim FILE]\n';
  assert.deepEqual(skillRun([], read), { code: 1, out: '', err: usage });
  assert.deepEqual(skillRun(['c.diff', '--scope'], read), { code: 1, out: '', err: usage });
  assert.deepEqual(skillRun(['c.diff', '--claim'], read), { code: 1, out: '', err: usage });
  assert.deepEqual(skillRun(null, read), { code: 1, out: '', err: usage });
  assert.deepEqual(skillRun(['--scope', 's.txt'], read), { code: 1, out: '', err: usage }, 'the scope file is not the diff');
  assert.deepEqual(skillRun(['nope.diff'], read), { code: 1, out: '', err: 'could not read the input: ENOENT: nope.diff\n' });
  assert.deepEqual(skillRun(['c.diff'], () => { throw 'plain'; }), { code: 1, out: '', err: 'could not read the input: plain\n' });
});

test('readInput reads a named file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'sg-read-'));
  writeFileSync(join(d, 'x.diff'), 'hello');
  assert.equal(readInput(join(d, 'x.diff')), 'hello');
});
