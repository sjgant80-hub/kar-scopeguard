// cli.test.mjs — the command line: options, the report, every exit code it promises, --git on a real repository,
// and the Claude Code Stop hook (blocks once per set of findings). Run: node --test cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, formatReport, hookMessage, hookDecision, blockKey, committedScope, run, workingDiff, sha256, EMPTY_TREE, USAGE } from './cli.mjs';
import { audit, fingerprintInput, fingerprintResult } from './kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'cli.mjs');
const SKIP = 'diff --git a/t/a.test.js b/t/a.test.js\nindex 1..2 100644\n--- a/t/a.test.js\n+++ b/t/a.test.js\n@@ -1,1 +1,1 @@\n-it("adds", () => {\n+it.skip("adds", () => {\n';
const IGNORE = 'diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x = 1\n+x = 1 // @ts-ignore\n';
const CLEAN = 'diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x = 1\n+x = 2\n';

function tmp() { return mkdtempSync(join(tmpdir(), 'scopeguard-')); }
function repo() {
  const d = tmp();
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'test@example.invalid'); g('config', 'user.name', 'test'); g('config', 'core.autocrlf', 'false');
  mkdirSync(join(d, 't'));
  writeFileSync(join(d, 't', 'a.test.js'), 'it("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n');
  writeFileSync(join(d, 'a.js'), 'export const a = 1;\n');
  g('add', '-A'); g('commit', '-q', '-m', 'one');
  return { d, g };
}

test('parseArgs: files, stdin, --git with and without a ref, --staged, --hook, and every refusal', () => {
  assert.deepEqual(parseArgs(['x.diff']), { input: 'x.diff', git: false, ref: 'HEAD', staged: false, hook: false, scope: null, claim: null, failOn: 'high', json: false });
  assert.deepEqual(parseArgs(['-', '--scope', 's', '--claim', 'c', '--fail-on', 'review', '--json']), { input: '-', git: false, ref: 'HEAD', staged: false, hook: false, scope: 's', claim: 'c', failOn: 'review', json: true });
  assert.equal(parseArgs(['--git']).ref, 'HEAD');
  assert.equal(parseArgs(['--git', 'main']).ref, 'main');
  assert.deepEqual([parseArgs(['--git', '--staged']).ref, parseArgs(['--git', '--staged']).staged], ['HEAD', true]);
  assert.equal(parseArgs(['--hook']).hook, true);
  assert.deepEqual(parseArgs([]), { error: 'no diff given' });
  assert.deepEqual(parseArgs(['--scope']), { error: '--scope needs a value' });
  assert.deepEqual(parseArgs(['x', '--claim']), { error: '--claim needs a value' });
  assert.deepEqual(parseArgs(['x', '--fail-on']), { error: '--fail-on needs a value' });
  assert.deepEqual(parseArgs(['x', '--fail-on', 'low']), { error: '--fail-on must be high or review' });
  assert.deepEqual(parseArgs(['x', '--bogus']), { error: 'unknown option --bogus' });
  assert.deepEqual(parseArgs(['x', 'y']), { error: 'only one diff file at a time' });
  assert.deepEqual(parseArgs(['--git', 'main', 'x']), { error: 'give a diff file or --git/--hook, not both' });
  assert.deepEqual(parseArgs(['--hook', 'x']), { error: 'give a diff file or --git/--hook, not both' });
  assert.deepEqual(parseArgs(null), { error: 'no diff given' });
});

test('formatReport: the verdict line, one line per finding, the fingerprints', () => {
  const r = audit(SKIP + IGNORE);
  assert.equal(formatReport(r, { input: 'I', result: 'R' }),
    'ScopeGuard: FLAGGED - 1 high, 1 review, 2 files (+2 -2)\n'
    + '  HIGH   skip-added         t/a.test.js:1  it.skip("adds", () => {\n'
    + '  review checker-silenced   src/a.js:1  x = 1 // @ts-ignore\n'
    + 'input  sha256 I\nresult sha256 R\n');
  assert.equal(formatReport(audit(CLEAN), null), 'ScopeGuard: CLEAN - 0 high, 0 review, 1 file (+1 -1)\n');
  assert.equal(formatReport(audit(IGNORE), null).split('\n')[0], 'ScopeGuard: REVIEW - 0 high, 1 review, 1 file (+1 -1)');
  assert.equal(formatReport(audit('diff --cc x\n')), 'ScopeGuard: could not check this input: a combined merge diff cannot be checked: diff against one parent (line 1)\n');
  assert.equal(formatReport({ ok: false, why: 'w', line: 0 }), 'ScopeGuard: could not check this input: w\n');
  assert.equal(formatReport(null), 'ScopeGuard: could not check this input: unknown\n');
  const fileLevel = audit('diff --git a/t/x.test.js b/t/x.test.js\ndeleted file mode 100644\n--- a/t/x.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-expect(a).toBe(1)\n');
  assert.equal(formatReport(fileLevel, null).split('\n')[1], '  HIGH   test-file-deleted  t/x.test.js  1 assertion lines removed');
});

test('hookMessage and hookDecision: block on high findings, once per set of findings', () => {
  const r = audit(SKIP + IGNORE);
  assert.equal(hookMessage(r), 'ScopeGuard stopped this finish: the change has 1 high finding a reviewer must read.\n- skip-added at t/a.test.js:1: it.skip("adds", () => {\n'
    + 'Fix the code instead of the check where you can. If a finding is an honest change, say so and why in your final message. ScopeGuard does not stop you twice for the same findings.');
  const two = audit(SKIP + 'diff --git a/t/b.test.js b/t/b.test.js\ndeleted file mode 100644\n--- a/t/b.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
  assert.match(hookMessage(two), /^ScopeGuard stopped this finish: the change has 2 high findings a reviewer/);
  assert.match(hookMessage(two), /\n- test-file-deleted at t\/b\.test\.js: 0 assertion lines removed\n/);
  const d = hookDecision(r, null);
  assert.deepEqual([d.code, d.remember], [2, blockKey(r)]);
  assert.equal(d.note, hookMessage(r));
  assert.deepEqual(hookDecision(r, blockKey(r)), { code: 0, note: 'ScopeGuard: the same findings were already shown once; not stopping again.' });
  assert.equal(hookDecision(r, 'some other key').code, 2);
  assert.deepEqual(hookDecision(audit(IGNORE), null), { code: 0, note: null });
  assert.deepEqual(hookDecision(audit(CLEAN), null), { code: 0, note: null });
  assert.deepEqual(hookDecision(audit('diff --cc x'), null), { code: 0, note: 'ScopeGuard could not read this change, so it did not check it: a combined merge diff cannot be checked: diff against one parent' });
  assert.deepEqual(hookDecision(null, null), { code: 0, note: 'ScopeGuard could not read this change, so it did not check it: unknown' });
});

test('blockKey: the high findings without line numbers; review findings do not change it', () => {
  const at = (n) => 'diff --git a/t/a.test.js b/t/a.test.js\nindex 1..2 100644\n--- a/t/a.test.js\n+++ b/t/a.test.js\n@@ -' + n + ',1 +' + n + ',1 @@\n-it("adds", () => {\n+it.skip("adds", () => {\n';
  assert.equal(blockKey(audit(at(1))), blockKey(audit(at(40))), 'the same finding on another line is the same finding');
  assert.equal(blockKey(audit(SKIP)), blockKey(audit(SKIP + IGNORE)), 'a review finding does not change the key');
  assert.notEqual(blockKey(audit(SKIP)), blockKey(audit(SKIP.replace(/adds/g, 'sums'))), 'changed text is a new finding');
  assert.equal(blockKey(audit(SKIP)), sha256(JSON.stringify([['skip-added', 't/a.test.js', 'it.skip("adds", () => {']])));
  assert.equal(blockKey(audit(CLEAN)), sha256('[]'));
  assert.equal(blockKey(null), null);
  assert.equal(blockKey({ ok: false }), null);
});

test('run: files, stdin, scope and claim files, --json, and the fingerprints', () => {
  const d = tmp();
  writeFileSync(join(d, 'c.diff'), SKIP);
  writeFileSync(join(d, 'scope'), 'allow src/**\n');
  writeFileSync(join(d, 'claim.txt'), 'I fixed t/a.test.js');
  const r = run(['c.diff', '--json'], { cwd: d });
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.equal(j.result.verdict, 'flagged');
  assert.equal(j.fingerprints.input, sha256(fingerprintInput(SKIP, '', '')));
  assert.equal(j.fingerprints.result, sha256(fingerprintResult(audit(SKIP))));
  const s = JSON.parse(run(['c.diff', '--json', '--scope', 'scope', '--claim', 'claim.txt'], { cwd: d }).stdout);
  assert.deepEqual(s.result.findings.map((f) => f.rule), ['outside-scope', 'skip-added']);
  assert.equal(s.fingerprints.input, sha256(fingerprintInput(SKIP, 'allow src/**\n', 'I fixed t/a.test.js')));
  const viaStdin = run(['-'], { stdin: CLEAN, cwd: d });
  assert.equal(viaStdin.code, 0);
  assert.equal(viaStdin.stdout, formatReport(audit(CLEAN), { input: sha256(fingerprintInput(CLEAN, '', '')), result: sha256(fingerprintResult(audit(CLEAN))) }));
  assert.equal(viaStdin.stderr, '');
  rmSync(d, { recursive: true, force: true });
});

test('run: exit codes 0, 2, 1 and the review switch', () => {
  assert.equal(run(['-'], { stdin: CLEAN }).code, 0);
  assert.equal(run(['-'], { stdin: SKIP }).code, 2);
  assert.equal(run(['-'], { stdin: IGNORE }).code, 0, 'review passes by default');
  assert.equal(run(['-', '--fail-on', 'review'], { stdin: IGNORE }).code, 2);
  assert.equal(run(['-', '--fail-on', 'review'], { stdin: CLEAN }).code, 0);
  const bad = run(['-'], { stdin: 'diff --cc x\n' });
  assert.deepEqual([bad.code, bad.stdout], [1, 'ScopeGuard: could not check this input: a combined merge diff cannot be checked: diff against one parent (line 1)\n']);
  const usage = run([]);
  assert.deepEqual([usage.code, usage.stdout, usage.stderr], [1, '', 'no diff given\n' + USAGE + '\n']);
  const missing = run(['no-such-file.diff'], { cwd: tmp() });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^ScopeGuard: ENOENT/);
  const badScope = run(['-', '--json'], { stdin: CLEAN, cwd: tmp() });
  assert.equal(badScope.code, 0);
});

test('workingDiff and --git: tracked changes, new files, staged only, a missing ref, a repository with no commits', () => {
  const { d, g } = repo();
  writeFileSync(join(d, 't', 'a.test.js'), 'it.skip("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n');
  writeFileSync(join(d, 'new.js'), 'export const n = 1;\n');
  const text = workingDiff(d);
  assert.match(text, /\+it\.skip\("adds"/);
  assert.match(text, /\+\+\+ b\/new\.js/);
  assert.equal(audit(text).files.map((f) => f.path).join(','), 't/a.test.js,new.js');
  const r = run(['--git', '--json'], { cwd: d });
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.stdout).result.findings.map((f) => f.rule), ['skip-added']);
  assert.equal(workingDiff(d, 'HEAD', true), '', 'nothing staged yet');
  g('add', 't/a.test.js');
  assert.match(workingDiff(d, 'HEAD', true), /\+it\.skip/);
  assert.doesNotMatch(workingDiff(d, 'HEAD', true), /new\.js/, 'staged mode leaves untracked files out');
  assert.equal(run(['--git', '--staged'], { cwd: d }).code, 2);
  assert.equal(run(['--git', 'main'], { cwd: d }).code, 2);
  const nope = run(['--git', 'no-such-ref'], { cwd: d });
  assert.deepEqual([nope.code, nope.stderr], [1, 'ScopeGuard: unknown ref no-such-ref\n']);
  assert.throws(() => workingDiff(d, 'no-such-ref'), /unknown ref no-such-ref/);
  const fresh = tmp();
  execFileSync('git', ['-C', fresh, 'init', '-q']);
  writeFileSync(join(fresh, 'x.test.js'), 'it.only("x", f)\n');
  assert.equal(EMPTY_TREE, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const fr = run(['--git', '--json'], { cwd: fresh });
  assert.deepEqual(JSON.parse(fr.stdout).result.findings.map((f) => f.rule), ['only-added'], 'no commits yet: everything is new');
  rmSync(d, { recursive: true, force: true }); rmSync(fresh, { recursive: true, force: true });
});

test('committedScope reads the scope as committed, never the working copy', () => {
  const { d, g } = repo();
  assert.equal(committedScope(d), '', 'none committed');
  writeFileSync(join(d, '.scopeguard'), 'allow t/**\n');
  assert.equal(committedScope(d), '', 'an uncommitted scope is not read');
  g('add', '.scopeguard'); g('commit', '-q', '-m', 'scope');
  writeFileSync(join(d, '.scopeguard'), 'allow **\n');
  assert.equal(committedScope(d), 'allow t/**\n');
  assert.equal(committedScope(d, 'HEAD~1'), '');
  assert.equal(committedScope(join(d, 'no-such-dir')), '');
  rmSync(d, { recursive: true, force: true });
});

test('--hook: blocks a finish with high findings once, uses the committed scope, ignores review-only and non-git folders', () => {
  const { d, g } = repo();
  const ev = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', stop_hook_active: false, cwd: d });
  assert.deepEqual(run(['--hook'], { stdin: ev }), { code: 0, stdout: '', stderr: '' }, 'nothing changed');
  writeFileSync(join(d, 't', 'a.test.js'), 'it.skip("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n');
  const first = run(['--hook'], { stdin: ev });
  assert.equal(first.code, 2);
  assert.match(first.stderr, /^ScopeGuard stopped this finish: the change has 1 high finding/);
  const markFile = join(d, '.git', 'scopeguard-last-block');
  assert.ok(existsSync(markFile));
  assert.equal(readFileSync(markFile, 'utf8'), blockKey(audit(workingDiff(d))) + '\n');
  const second = run(['--hook'], { stdin: ev });
  assert.deepEqual(second, { code: 0, stdout: '', stderr: 'ScopeGuard: the same findings were already shown once; not stopping again.\n' });
  writeFileSync(join(d, 't', 'a.test.js'), '// a comment above\nit.skip("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n');
  assert.equal(run(['--hook'], { stdin: ev }).code, 0, 'the same finding on a moved line is not shown again');
  writeFileSync(join(d, 't', 'b.test.js'), 'it.only("x", () => {});\n');
  const third = run(['--hook'], { stdin: ev });
  assert.equal(third.code, 2, 'a new high finding stops it again');
  assert.match(third.stderr, /only-added at t\/b\.test\.js:1/);
  // a committed scope: a change outside it stops the agent, and editing the scope does not help
  writeFileSync(join(d, 't', 'a.test.js'), 'it("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n');
  rmSync(join(d, 't', 'b.test.js'));
  writeFileSync(join(d, '.scopeguard'), 'allow t/**\n');
  g('add', '-A'); g('commit', '-q', '-m', 'scope');
  writeFileSync(join(d, 'a.js'), 'export const a = 2;\n');
  const scoped = run(['--hook'], { stdin: ev });
  assert.equal(scoped.code, 2);
  assert.match(scoped.stderr, /outside-scope at a\.js: a\.js/);
  writeFileSync(join(d, '.scopeguard'), 'allow **\n');
  const widened = run(['--hook'], { stdin: ev });
  assert.equal(widened.code, 2);
  assert.match(widened.stderr, /scope-file-changed at \.scopeguard/, 'widening the scope is itself a finding');
  assert.match(widened.stderr, /outside-scope at a\.js/, 'and the committed scope still applies');
  g('checkout', '--', '.scopeguard', 'a.js');
  writeFileSync(join(d, 't', 'helper.js'), 'export const h = 1; // @ts-ignore\n');
  assert.deepEqual(run(['--hook'], { stdin: ev }), { code: 0, stdout: '', stderr: '' }, 'review findings never stop the agent');
  writeFileSync(join(d, 't', 'c.test.js'), 'it.only("c", () => {});\n');
  assert.equal(run(['--hook'], { stdin: JSON.stringify({ cwd: 5 }), cwd: d }).code, 2, 'a cwd that is not text falls back to the working folder');
  rmSync(join(d, 't', 'c.test.js'));
  const viaCwd = run(['--hook'], { stdin: 'not json', cwd: d });
  assert.equal(viaCwd.code, 0, 'unreadable hook input falls back to the working folder');
  const outside = tmp();
  assert.deepEqual(run(['--hook'], { stdin: JSON.stringify({ cwd: outside }) }), { code: 0, stdout: '', stderr: 'ScopeGuard: not a git folder, nothing to check.\n' });
  assert.deepEqual(run(['--hook'], { stdin: '', cwd: outside }), { code: 0, stdout: '', stderr: 'ScopeGuard: not a git folder, nothing to check.\n' });
  rmSync(d, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

test('the real process: exit codes and standard input, as a shell or CI sees them', () => {
  const p = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
  const a = p(['-'], CLEAN);
  assert.deepEqual([a.status, a.stdout.split('\n')[0]], [0, 'ScopeGuard: CLEAN - 0 high, 0 review, 1 file (+1 -1)']);
  const b = p(['-'], SKIP);
  assert.deepEqual([b.status, b.stdout.split('\n')[0]], [2, 'ScopeGuard: FLAGGED - 1 high, 0 review, 1 file (+1 -1)']);
  assert.equal(p(['-', '--fail-on', 'review'], IGNORE).status, 2);
  assert.equal(p(['-'], 'diff --cc x\n').status, 1);
  const u = p([], '');
  assert.deepEqual([u.status, u.stderr.split('\n')[0]], [1, 'no diff given']);
  const { d } = repo();
  writeFileSync(join(d, 't', 'a.test.js'), 'it.only("adds", () => {});\n');
  const h = p(['--hook'], JSON.stringify({ cwd: d, stop_hook_active: false }));
  assert.equal(h.status, 2);
  assert.match(h.stderr, /only-added at t\/a\.test\.js:1/);
  rmSync(d, { recursive: true, force: true });
});
