// kernel.test.mjs — ScopeGuard's kernel: every rule with a positive and a negative example, every parser path and
// every refusal, the fingerprints and the exit codes. Run: node --test kernel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import K, {
  VERSION, RULES, MAX_CHARS, globToRegExp, parseScope, classify, unquotePath, parseDiff, isComment, uncomment, isAssertion,
  assertionShape, closeParen, splitArgs, cutHashComment, claimedPaths, audit, fingerprintInput, fingerprintResult, exitCode,
  DEFAULT_TESTS, DEFAULT_GATES, DEFAULT_SNAPSHOTS, FILE_EXT,
} from './kernel.mjs';

// ─── diff builders: hunk headers are counted from the lines, so a test diff is always well-formed ───────────────
const count = (lines) => ({ old: lines.filter((l) => l[0] !== '+').length, nu: lines.filter((l) => l[0] !== '-').length });
function mod(path, lines, start = 1) {
  const c = count(lines);
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -${start},${c.old} +${start},${c.nu} @@\n${lines.join('\n')}\n`;
}
function add(path, lines) {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
}
function del(path, lines) {
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => '-' + l).join('\n')}\n`;
}
const rules = (r) => r.findings.map((f) => f.rule + '@' + f.line);
const only = (r, id) => r.findings.filter((f) => f.rule === id);
const ruleIds = (r) => r.findings.map((f) => f.rule);

// ─── the rule table ─────────────────────────────────────────────────────────────────────────────────────────────
test('RULES is a closed list: unique ids, two severities, plain descriptions', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(RULES.length, 26);
  for (const r of RULES) { assert.ok(r.severity === 'high' || r.severity === 'review', r.id); assert.ok(r.what.length > 20, r.id); }
  assert.equal(RULES.filter((r) => r.severity === 'high').length, 17);
  const what = (id) => RULES.find((r) => r.id === id).what;
  assert.match(what('matcher-loosened'), /\(toEqual to toBeDefined, == to !=, assertEqual to assertTrue\)/);
  assert.match(what('failure-ignored'), /\(continue-on-error, \|\| true, allow_failure, --passWithNoTests\)/);
  assert.equal(what('scope-file-changed'), 'The scope file (.scopeguard) itself was changed, so the change could have widened its own scope.');
  assert.equal(K.SCOPE_FILE, '.scopeguard');
  assert.ok(Object.isFrozen(RULES));
  assert.equal(VERSION, 'scopeguard/1.2');
  assert.equal(MAX_CHARS, 50000000);
  assert.equal(K.audit, audit);
  assert.ok(DEFAULT_TESTS.includes('**/*.test.*') && DEFAULT_GATES.includes('.github/workflows/**') && DEFAULT_SNAPSHOTS.includes('**/*.snap'));
  assert.ok(FILE_EXT.split('|').includes('mjs'));
});

// ─── globs and scope ───────────────────────────────────────────────────────────────────────────────────────────
test('globToRegExp: ** any folders, * one name, ? one character, anchored', () => {
  const g = (p, s) => globToRegExp(p).test(s);
  assert.ok(g('src/**', 'src/a/b.js'));
  assert.ok(!g('src/**', 'src'), 'a folder pattern matches the files under it');
  assert.ok(!g('src/**', 'srcx/a.js'));
  assert.ok(g('**/*.test.*', 'a.test.js'));
  assert.ok(g('**/*.test.*', 'x/y/a.test.mjs'));
  assert.ok(!g('*.js', 'a/b.js'));
  assert.ok(g('*.js', 'b.js'));
  assert.ok(g('a?.js', 'ab.js'));
  assert.ok(!g('a?.js', 'a/.js'));
  assert.ok(g('docs/', 'docs/x/y.md'), 'a trailing slash means everything under it');
  assert.ok(g('./lib/*.js', 'lib/a.js'), 'a leading ./ is dropped');
  assert.ok(g('/lib/*.js', 'lib/a.js'), 'a leading / is dropped');
  assert.ok(g('a.b+c(d)[e]{f}$^|.js', 'a.b+c(d)[e]{f}$^|.js'), 'regex characters are literal');
  assert.ok(!g('a.js', 'aXjs'));
  assert.ok(g('a**b', 'aXX/YYb'), '** not followed by a slash crosses folders');
  assert.ok(!g('a*b', 'aX/Yb'));
  assert.equal(globToRegExp(''), null);
  assert.equal(globToRegExp('  ./ '), null);
  assert.equal(globToRegExp(7), null);
});

test('parseScope reads allow, deny, tests and gate lines and refuses anything else', () => {
  const s = parseScope('# task scope\r\nallow src/auth/**\n\n  deny  .github/**  \ntests spec2/**\ngate ci/run.sh\n');
  assert.deepEqual(s, { ok: true, allow: ['src/auth/**'], deny: ['.github/**'], tests: ['spec2/**'], gates: ['ci/run.sh'] });
  assert.deepEqual(parseScope(''), { ok: true, allow: [], deny: [], tests: [], gates: [] });
  assert.deepEqual(parseScope(null), { ok: true, allow: [], deny: [], tests: [], gates: [] });
  assert.deepEqual(parseScope(undefined), { ok: true, allow: [], deny: [], tests: [], gates: [] });
  const bad = parseScope('allow a\npermit b/**');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /^scope line 2 is not "allow\|deny\|tests\|gate <pattern>": permit b\/\*\*$/);
  assert.equal(parseScope('allow').ok, false);
  const badPat = parseScope('allow ./');
  assert.equal(badPat.ok, false);
  assert.equal(badPat.why, 'scope line 1 has an unreadable pattern');
  assert.deepEqual(parseScope(42), { ok: false, why: 'the scope must be text' });
});

test('classify: test, snapshot, gate and source, and the scope state', () => {
  const none = parseScope('');
  assert.deepEqual(classify('src/a.js', none), { kind: 'source', scope: 'unscoped' });
  assert.deepEqual(classify('src/a.test.js', none), { kind: 'test', scope: 'unscoped' });
  assert.deepEqual(classify('tests/test_x.py', none), { kind: 'test', scope: 'unscoped' });
  assert.deepEqual(classify('pkg/x_test.go', none), { kind: 'test', scope: 'unscoped' });
  assert.deepEqual(classify('src/__snapshots__/a.snap', none), { kind: 'snapshot', scope: 'unscoped' });
  assert.deepEqual(classify('golden/out.golden', none), { kind: 'snapshot', scope: 'unscoped' });
  assert.deepEqual(classify('.github/workflows/ci.yml', none), { kind: 'gate', scope: 'unscoped' });
  assert.deepEqual(classify('package.json', none), { kind: 'gate', scope: 'unscoped' });
  assert.deepEqual(classify('test/package.json', none), { kind: 'test', scope: 'unscoped' }, 'test wins over gate');
  const s = parseScope('allow src/**\nallow test/**\ndeny src/secret/**\ntests checks/**\ngate ci/**');
  assert.deepEqual(classify('src/a.js', s), { kind: 'source', scope: 'allowed' });
  assert.deepEqual(classify('lib/a.js', s), { kind: 'source', scope: 'outside' });
  assert.deepEqual(classify('src/secret/k.js', s), { kind: 'source', scope: 'denied' }, 'deny wins over allow');
  assert.deepEqual(classify('checks/a.js', s), { kind: 'test', scope: 'outside' });
  assert.deepEqual(classify('ci/run.sh', s), { kind: 'gate', scope: 'outside' });
  assert.deepEqual(classify('x.js', parseScope('deny x.js')), { kind: 'source', scope: 'denied' });
  assert.deepEqual(classify('x.js', { ok: false }), { kind: 'source', scope: 'unscoped' }, 'a refused scope is ignored');
  assert.deepEqual(classify('src/a.test.js', { ok: false }), { kind: 'test', scope: 'unscoped' }, 'and the default classes still apply');
  assert.deepEqual(classify('x.js'), { kind: 'source', scope: 'unscoped' });
  const toxic = { toString() { throw new Error('x'); } };
  assert.deepEqual(classify(toxic, none), { kind: 'source', scope: 'unscoped' });
});

// ─── the parser ────────────────────────────────────────────────────────────────────────────────────────────────
test('unquotePath: git C-quoted paths, UTF-8 octal escapes, malformed quotes refused', () => {
  assert.equal(unquotePath('plain/path.js'), 'plain/path.js');
  assert.equal(unquotePath('"a/t\\303\\251st.txt"'), 'a/tést.txt');
  assert.equal(unquotePath('"a\\tb\\nc\\"d\\\\e"'), 'a\tb\nc"d\\e');
  assert.equal(unquotePath('"\\a\\b\\v\\f\\r"'), '\x07\x08\x0b\x0c\r');
  assert.equal(unquotePath('"a/b c.js"'), 'a/b c.js');
  assert.equal(unquotePath('"unclosed'), null);
  assert.equal(unquotePath('"bad\\qescape"'), null);
  assert.equal(unquotePath('"a" trailing'), null);
  assert.equal(unquotePath('"\\30"'), null, 'an octal escape needs three digits');
  assert.equal(unquotePath('"\\1xab"'), null);
  assert.equal(unquotePath('"a\\""'), 'a"', 'an escaped quote before the closing one');
  assert.equal(unquotePath('"a\\"'), null, 'the closing quote was escaped, so the path never closes');
  assert.equal(unquotePath('"'), null);
  assert.equal(unquotePath('""'), '');
  assert.equal(unquotePath('"a"b"'), null, 'a bare quote inside');
  assert.equal(unquotePath(null), null);
});

test('parseDiff: a modified file with line numbers on both sides', () => {
  const p = parseDiff(mod('src/a.js', [' one', '-two', '+TWO', '+two-b', ' three'], 10));
  assert.equal(p.ok, true);
  assert.equal(p.files.length, 1);
  const f = p.files[0];
  assert.deepEqual([f.oldPath, f.newPath, f.path, f.status, f.binary, f.mode], ['src/a.js', 'src/a.js', 'src/a.js', 'modified', false, false]);
  assert.deepEqual(f.hunks[0].lines, [
    { t: ' ', s: 'one', old: 10, nu: 10 }, { t: '-', s: 'two', old: 11, nu: null },
    { t: '+', s: 'TWO', old: null, nu: 11 }, { t: '+', s: 'two-b', old: null, nu: 12 }, { t: ' ', s: 'three', old: 12, nu: 13 },
  ]);
  assert.deepEqual([f.hunks[0].oldStart, f.hunks[0].newStart], [10, 10]);
});

test('parseDiff: added, deleted, renamed, copied, mode-only and binary files', () => {
  const text = add('n.js', ['x']) + del('d.js', ['y'])
    + 'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n'
    + 'diff --git a/c1.js b/c2.js\nsimilarity index 90%\ncopy from c1.js\ncopy to c2.js\n--- a/c1.js\n+++ b/c2.js\n@@ -1 +1 @@\n-a\n+b\n'
    + 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
    + 'diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n'
    + 'diff --git a/blob.bin b/blob.bin\nindex 1..2 100644\nGIT binary patch\nliteral 5\nMcmZ?wbYkaY0\n\nliteral 0\nHcmV?d00001\n\n'
    + mod('after.js', ['-p', '+q']);
  const p = parseDiff(text);
  assert.equal(p.ok, true, p.why);
  const by = Object.fromEntries(p.files.map((f) => [f.path, f]));
  assert.deepEqual(p.files.map((f) => f.path), ['n.js', 'd.js', 'new.js', 'c2.js', 'run.sh', 'img.png', 'blob.bin', 'after.js']);
  assert.equal(by['n.js'].status, 'added');
  assert.equal(by['d.js'].status, 'deleted');
  assert.equal(by['d.js'].oldPath, 'd.js');
  assert.deepEqual([by['new.js'].status, by['new.js'].oldPath, by['new.js'].hunks.length], ['renamed', 'old.js', 0]);
  assert.deepEqual([by['c2.js'].status, by['c2.js'].oldPath, by['c2.js'].hunks.length], ['copied', 'c1.js', 1]);
  assert.equal(by['run.sh'].mode, true);
  assert.equal(by['img.png'].binary, true);
  assert.equal(by['blob.bin'].binary, true);
  assert.equal(by['blob.bin'].hunks.length, 0, 'the binary patch body is skipped, not read as hunks');
  assert.equal(by['after.js'].hunks[0].lines.length, 2);
});

test('parseDiff: quoted paths and diffs made with --no-prefix', () => {
  const q = parseDiff('diff --git "a/t\\303\\251st.js" "b/t\\303\\251st.js"\nindex 1..2 100644\n--- "a/t\\303\\251st.js"\n+++ "b/t\\303\\251st.js"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(q.ok, true);
  assert.equal(q.files[0].path, 'tést.js');
  const np = parseDiff('diff --git src/x.js src/x.js\nindex 1..2 100644\n--- src/x.js\n+++ src/x.js\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(np.ok, true);
  assert.equal(np.files[0].path, 'src/x.js');
  const ab = parseDiff('diff --git a/a/x.js b/a/x.js\nindex 1..2 100644\n--- a/a/x.js\n+++ b/a/x.js\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(ab.files[0].path, 'a/x.js', 'only the a/ b/ prefix is stripped');
  const sp = parseDiff('diff --git a/my file.js b/my file.js\nindex 1..2 100644\nBinary files a/my file.js and b/my file.js differ\n');
  assert.equal(sp.files[0].path, 'my file.js');
  const ren = parseDiff('diff --git a/x y.js b/z w.js\nsimilarity index 100%\nrename from x y.js\nrename to z w.js\n');
  assert.deepEqual([ren.files[0].oldPath, ren.files[0].path], ['x y.js', 'z w.js']);
  const qmix = parseDiff('diff --git "a/\\303\\251.js" b/e.js\nsimilarity index 100%\nrename from "\\303\\251.js"\nrename to e.js\n');
  assert.deepEqual([qmix.files[0].oldPath, qmix.files[0].path], ['é.js', 'e.js']);
  const dirA = parseDiff('diff --git a/x.js a/x.js\nindex 1..2 100644\n--- a/x.js\n+++ a/x.js\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(dirA.files[0].path, 'a/x.js', 'no b/ side: made with --no-prefix, so a/ is a real folder');
  assert.deepEqual(parseDiff('diff --git "a/x" "b/\\q"\n'), { ok: false, why: 'the diff --git line has no readable paths', line: 1 });
  const bInPath = parseDiff('diff --git a/x b/y.js b/x b/y.js\nindex 1..2 100644\nBinary files a/x b/y.js and b/x b/y.js differ\n');
  assert.equal(bInPath.files[0].path, 'x b/y.js', 'a path that itself contains " b/" is split in the middle');
  const odd = parseDiff('diff --git a/xxxxx b/c b/d\nindex 1..2 100644\nBinary files differ\n');
  assert.deepEqual([odd.files[0].oldPath, odd.files[0].path], ['xxxxx b/c', 'd'], 'two different paths: split at the last " b/"');
});

test('parseDiff: edges of the size limit, a missing final newline, and stray lines', () => {
  assert.deepEqual(parseDiff('x'.repeat(MAX_CHARS)), { ok: false, why: 'no file changes were found in this text', line: 0 }, 'exactly at the limit is read');
  const nofinal = parseDiff(mod('a.js', ['-x', '+y']).slice(0, -1));
  assert.equal(nofinal.ok, true);
  assert.deepEqual(nofinal.files[0].hunks[0].lines.map((l) => l.s), ['x', 'y']);
  assert.deepEqual(parseDiff('diff --git a/x b/x\n\\ No newline at end of file\n'), { ok: false, why: 'an unrecognised header line: \\ No newline at end of file', line: 2 });
  const prose = parseDiff('Some text\n--- not a header\nmore\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(prose.files.map((f) => f.path), ['x.py']);
  const mixed = parseDiff('--- a/x.py\n+++ new/x.py\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual([mixed.files[0].oldPath, mixed.files[0].path], ['a/x.py', 'new/x.py'], 'only strip a/ and b/ when both sides have them');
  const sig = parseDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n-- \n+ not a diff line\n');
  assert.equal(sig.ok, true, 'after a "-- " signature, lines are not read');
  assert.deepEqual(parseDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\njunk\n+z\n'), { ok: false, why: 'a diff line sits outside any hunk (the hunk header count is too small)', line: 7 });
});

test('parseDiff: plain unified diffs with timestamps, several hunks, no-newline markers and blank context', () => {
  const t = 'Only in a: junk\n--- a/x.py\t2024-01-01 10:00:00\n+++ b/x.py\t2024-01-02 10:00:00\n@@ -1,2 +1,2 @@\n-one\n+ONE\n\n@@ -9 +9 @@\n-nine\n\\ No newline at end of file\n+NINE\n\\ No newline at end of file\ndiff -u a/y.py b/y.py\n--- /dev/null\n+++ b/y.py\n@@ -0,0 +1 @@\n+new\n--- a/z.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const p = parseDiff(t);
  assert.equal(p.ok, true, p.why);
  assert.deepEqual(p.files.map((f) => [f.path, f.status, f.hunks.length]), [['x.py', 'modified', 2], ['y.py', 'added', 1], ['z.py', 'deleted', 1]]);
  assert.deepEqual(p.files[0].hunks[0].lines[2], { t: ' ', s: '', old: 2, nu: 2 }, 'an empty line inside a hunk is a blank context line');
  const noPre = parseDiff('--- x.py\n+++ x.py\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(noPre.files[0].path, 'x.py');
  const crlf = parseDiff(mod('w.js', ['-a', '+b']).replace(/\n/g, '\r\n'));
  assert.equal(crlf.ok, true);
  assert.equal(crlf.files[0].hunks[0].lines[1].s, 'b');
});

test('parseDiff: git show, format-patch and git log -p preambles', () => {
  const show = 'commit 0123456789abcdef0123456789abcdef01234567\nAuthor: A <a@example.invalid>\nDate:   Mon\n\n    - a bullet in the message\n    + another\n\n' + mod('a.js', ['-x', '+y']);
  assert.equal(parseDiff(show).ok, true);
  const patch = 'From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n- bullet\n---\n a.js | 2 +-\n 1 file changed\n\n' + mod('a.js', ['-x', '+y']) + '-- \n2.43.0\n\n';
  const pp = parseDiff(patch);
  assert.equal(pp.ok, true, pp.why);
  assert.equal(pp.files.length, 1);
  const log = show + '\ncommit 89abcdef0123456789abcdef0123456789abcdef\nAuthor: B\n\n    second\n\n' + mod('b.js', ['-x', '+y']);
  const lp = parseDiff(log);
  assert.equal(lp.ok, true, lp.why);
  assert.deepEqual(lp.files.map((f) => f.path), ['a.js', 'b.js']);
  assert.equal(parseDiff('').ok, true);
  assert.deepEqual(parseDiff('  \n').files, []);
});

test('parseDiff refuses what it cannot read, with the line', () => {
  const r = (t) => parseDiff(t);
  assert.deepEqual(r('diff --cc a.js\n'), { ok: false, why: 'a combined merge diff cannot be checked: diff against one parent', line: 1 });
  assert.deepEqual(r('diff --combined a.js\n'), { ok: false, why: 'a combined merge diff cannot be checked: diff against one parent', line: 1 });
  assert.deepEqual(r(mod('a.js', ['-x', '+y']) + '+z\n'), { ok: false, why: 'a diff line sits outside any hunk (the hunk header count is too small)', line: 8 });
  assert.deepEqual(r(mod('a.js', ['-x', '+y']) + ' z\n'), { ok: false, why: 'a diff line sits outside any hunk (the hunk header count is too small)', line: 8 });
  assert.deepEqual(r('--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n+z\n'), { ok: false, why: 'a diff line sits outside any hunk (the hunk header count is too small)', line: 6 });
  assert.deepEqual(r('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-x\n-y\n+z\n'), { ok: false, why: 'a hunk has more lines than its @@ header says', line: 6 });
  assert.deepEqual(r('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n+z\n+w\n'), { ok: false, why: 'a hunk has more lines than its @@ header says', line: 6 });
  assert.deepEqual(r('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n-x\n+y\n'), { ok: false, why: 'the diff ends inside a hunk (it was cut off)', line: 6 });
  assert.deepEqual(r('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-x\n?y\n'), { ok: false, why: 'a line inside a hunk does not start with " ", "+" or "-"', line: 6 });
  assert.deepEqual(r('diff --git a/a.js b/a.js\nsomething odd\n'), { ok: false, why: 'an unrecognised header line: something odd', line: 2 });
  assert.deepEqual(r(mod('a.js', ['-x', '+y']) + 'trailing words\n'), { ok: false, why: 'an unexpected line sits between files: trailing words', line: 8 });
  assert.deepEqual(r('just some text\nwith no diff\n'), { ok: false, why: 'no file changes were found in this text', line: 0 });
  assert.deepEqual(r('@@ -1 +1 @@\n-a\n+b\n'), { ok: false, why: 'a hunk has no file header (--- / +++ or diff --git) above it', line: 1 });
  assert.deepEqual(r('diff --git onlyone\n'), { ok: false, why: 'the diff --git line has no readable paths', line: 1 });
  assert.deepEqual(r('diff --git "a/x b/x\n'), { ok: false, why: 'the diff --git line has no readable paths', line: 1 });
  assert.deepEqual(r('--- "bad\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'), { ok: false, why: 'a --- / +++ path is unreadable', line: 1 });
  assert.deepEqual(r('diff --git a/x b/x\n--- "bad\n'), { ok: false, why: 'the --- path is unreadable', line: 2 });
  assert.deepEqual(r('diff --git a/x b/x\n--- a/x\n+++ "bad\n'), { ok: false, why: 'the +++ path is unreadable', line: 3 });
  assert.deepEqual(r('diff --git a/x b/y\nrename from "bad\n'), { ok: false, why: 'the rename path is unreadable', line: 2 });
  assert.deepEqual(r('diff --git a/x b/y\nrename from x\nrename to "bad\n'), { ok: false, why: 'the rename path is unreadable', line: 3 });
  assert.deepEqual(r(7), { ok: false, why: 'the diff must be text', line: 0 });
  assert.deepEqual(r('x'.repeat(MAX_CHARS + 1)), { ok: false, why: 'the diff is larger than 50000000 characters', line: 0 });
  assert.equal(r('x'.repeat(10) + '\n').ok, false);
});

test('parseDiff: a hunk header of 0,0 and the default count of 1', () => {
  const p = parseDiff('diff --git a/e b/e\n--- a/e\n+++ b/e\n@@ -0,0 +0,0 @@\n' + mod('f.js', ['-a', '+b']));
  assert.equal(p.ok, true, p.why);
  assert.equal(p.files[0].hunks[0].lines.length, 0);
  const one = parseDiff('diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -5 +5 @@\n-a\n+b\n');
  assert.deepEqual(one.files[0].hunks[0].lines.map((l) => [l.old, l.nu]), [[5, null], [null, 5]]);
});

// ─── line helpers ────────────────────────────────────────────────────────────────────────────────────────────
test('isComment, uncomment, isAssertion', () => {
  for (const c of ['// x', '  # x', '/* x', ' * x', '<!-- x -->', '### heading']) assert.ok(isComment(c), c);
  for (const c of ['x // y', '#[ignore]', '#!/bin/sh', '*/', 'code']) assert.ok(!isComment(c), c);
  assert.equal(isComment(7), false);
  assert.equal(uncomment('  // expect(a).toBe(1);'), 'expect(a).toBe(1);');
  assert.equal(uncomment('# assert x == 1'), 'assert x == 1');
  assert.equal(uncomment('/* assert.ok(x) */'), 'assert.ok(x)');
  assert.equal(uncomment('<!-- a -->'), 'a');
  assert.equal(uncomment(null), '');
  const yes = ['expect(a).toBe(1)', 'assert x == 1', 'assert(x)', 'assert.equal(a, b)', 'assertEqual(a, b)', 'assert_eq!(a, b)', 'assert_equal 1, x',
    't.assert.equal(a, 1)', 'Assert.AreEqual(a, b)', 'Assertions.assertEquals(a, b)', 'self.assertTrue(x)', 't.is(a, 1)', 't.Errorf("bad")',
    'require.Equal(t, a, b)', 'XCTAssertEqual(a, b)', 'x.should.equal(1)', 'should.exist(x)', '$this->assertSame(a, b)'];
  for (const s of yes) assert.ok(isAssertion(s), s);
  const no = ['// expect(a).toBe(1)', 'it("should assert things", () => {})', 'const assertion = 1', 'require("x")', 'debug_assert!(x)', 'myexpect(x)', 'a.expect(x)', 'reassert(x)'];
  for (const s of no) assert.ok(!isAssertion(s), s);
  assert.equal(isAssertion(null), false);
});

test('closeParen, splitArgs, cutHashComment', () => {
  assert.equal(closeParen('f(a, (b), "c)")) x', 1), 14);
  assert.equal(closeParen("f('\\')', [1, {2: 3}])", 1), 20);
  assert.equal(closeParen('f(`a)b`)', 1), 7);
  assert.equal(closeParen('f(a', 1), -1);
  assert.equal(closeParen('(a)', 0), 2);
  assert.equal(cutHashComment("'a' # c"), "'a' ");
  assert.equal(cutHashComment('"a#b" # c'), '"a#b" ');
  assert.equal(closeParen('x', -1), -1);
  assert.equal(closeParen(null, 0), -1);
  assert.equal(closeParen('()', 1.5), -1);
  assert.deepEqual(splitArgs('a, f(b, c), [d, e], {f: 1, g: 2}, "h, i", \'j\\\', k\', `l, m`'), ['a', 'f(b, c)', '[d, e]', '{f: 1, g: 2}', '"h, i"', "'j\\', k'", '`l, m`']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('a,'), ['a']);
  assert.deepEqual(splitArgs(5), []);
  assert.equal(cutHashComment('x == 1  # note'), 'x == 1  ');
  assert.equal(cutHashComment('x == "#1"'), 'x == "#1"');
  assert.equal(cutHashComment("x == '\\'#'"), "x == '\\'#'");
  assert.equal(cutHashComment(null), '');
});

test('assertionShape: JavaScript expect chains', () => {
  assert.deepEqual(assertionShape('expect(sum(1, 2)).toBe(3);'), { strength: 'strict', matcher: 'toBe', args: ['3'], subjects: ['sum(1, 2)'] });
  assert.deepEqual(assertionShape('expect(r).toBeDefined()'), { strength: 'loose', matcher: 'toBeDefined', args: [], subjects: ['r'] });
  assert.deepEqual(assertionShape('expect(r).not.toBe(4)'), { strength: 'loose', matcher: 'not.toBe', args: ['4'], subjects: ['r'] });
  assert.deepEqual(assertionShape('await expect(p).resolves.toEqual({ a: 1 })'), { strength: 'strict', matcher: 'toEqual', args: ['{ a: 1 }'], subjects: ['p'] });
  assert.deepEqual(assertionShape('expect(fn).toThrow(TypeError)'), { strength: 'strict', matcher: 'toThrow', args: ['TypeError'], subjects: ['fn'] });
  assert.deepEqual(assertionShape('expect(fn).toThrow()'), { strength: 'loose', matcher: 'toThrow', args: [], subjects: ['fn'] });
  assert.deepEqual(assertionShape('expect(o).toHaveProperty("a", 1)'), { strength: 'strict', matcher: 'toHaveProperty', args: ['"a"', '1'], subjects: ['o'] });
  assert.deepEqual(assertionShape('expect(o).toHaveProperty("a")'), { strength: 'loose', matcher: 'toHaveProperty', args: ['"a"'], subjects: ['o'] });
  assert.deepEqual(assertionShape('expect(ok).toBe(true)'), { strength: 'loose', matcher: 'toBe', args: ['true'], subjects: ['ok'] }, 'toBe(true) is a truth check');
  assert.deepEqual(assertionShape('expect(x).to.equal(3)'), { strength: 'strict', matcher: 'equal', args: ['3'], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to.be.ok'), { strength: 'loose', matcher: 'ok', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to.be.null;'), { strength: 'strict', matcher: 'null', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to.not.be.null'), { strength: 'loose', matcher: 'not.null', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to eq(3)'), { strength: 'strict', matcher: 'eq', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).not_to eq(3)'), { strength: 'loose', matcher: 'not.eq', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to_not eq(3)'), { strength: 'loose', matcher: 'not.eq', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(x).to be_truthy'), { strength: 'loose', matcher: 'be_truthy', args: [], subjects: ['x'] });
  assert.deepEqual(assertionShape('expect(r).toEqual({'), { strength: 'strict', matcher: 'toEqual', args: [], subjects: ['r'] }, 'a call that continues on the next line');
  assert.deepEqual(assertionShape('expect(5).toBe(5)'), { strength: 'strict', matcher: 'toBe', args: ['5'], subjects: [] }, 'a literal is never a subject');
  assert.equal(assertionShape('expect(x).toFrobnicate(1)'), null);
  assert.equal(assertionShape('expect(x'), null);
  assert.equal(assertionShape('expect(x).foo'), null);
  assert.equal(assertionShape('// expect(x).toBe(1)'), null);
});

test('assertionShape: Python, unittest, node:assert, JUnit, testify, Rust', () => {
  assert.deepEqual(assertionShape('assert x == 3'), { strength: 'strict', matcher: '==', args: ['x', '3'], subjects: ['x'] });
  assert.deepEqual(assertionShape('assert len(r) > 0, "msg"  # c'), { strength: 'loose', matcher: '>', args: ['len(r)', '0'], subjects: ['len(r)'] });
  assert.deepEqual(assertionShape('assert f(a, "x") == 2'), { strength: 'strict', matcher: '==', args: ['f(a, "x")', '2'], subjects: ['f(a, "x")'] });
  assert.deepEqual(assertionShape('assert x is not None'), { strength: 'loose', matcher: 'is not', args: ['x', 'None'], subjects: ['x'] });
  assert.deepEqual(assertionShape('assert x is None'), { strength: 'strict', matcher: 'is', args: ['x', 'None'], subjects: ['x'] });
  assert.deepEqual(assertionShape('assert k not in d'), { strength: 'loose', matcher: 'not in', args: ['k', 'd'], subjects: ['k', 'd'] });
  assert.deepEqual(assertionShape('assert k in d'), { strength: 'strict', matcher: 'in', args: ['k', 'd'], subjects: ['k', 'd'] });
  assert.deepEqual(assertionShape('assert a != b'), { strength: 'loose', matcher: '!=', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert a >= b'), { strength: 'loose', matcher: '>=', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert a <= b'), { strength: 'loose', matcher: '<=', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert a < b'), { strength: 'loose', matcher: '<', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert ok'), { strength: 'loose', matcher: 'assert', args: ['ok'], subjects: ['ok'] });
  assert.equal(assertionShape('assert # nothing'), null);
  assert.deepEqual(assertionShape('assert >= 3'), { strength: 'loose', matcher: 'assert', args: ['>= 3'], subjects: ['>= 3'] }, 'an operator with nothing on its left is not a comparison');
  for (const s of ['equal(a, b)', 'this.equal(a, b)', '$this->equal(a, b)', 'self.equal(a, b)']) assert.equal(assertionShape(s), null, s);
  assert.deepEqual(assertionShape('this.assertEqual(a, b)'), { strength: 'strict', matcher: 'equal', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('$this->assertSame(a, b)'), { strength: 'strict', matcher: 'same', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('self.assertEqual(a, b)'), { strength: 'strict', matcher: 'equal', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('self.assertTrue(a)'), { strength: 'loose', matcher: 'true', args: ['a'], subjects: ['a'] });
  assert.deepEqual(assertionShape('self.assertRaises(ValueError)'), { strength: 'strict', matcher: 'raises', args: ['ValueError'], subjects: ['ValueError'] });
  assert.deepEqual(assertionShape('assert.strictEqual(a, 1)'), { strength: 'strict', matcher: 'strictequal', args: ['a', '1'], subjects: ['a'] });
  assert.deepEqual(assertionShape('assert.equal(a.length >= 1, true)'), { strength: 'loose', matcher: 'equal', args: ['a.length >= 1', 'true'], subjects: ['a.length >= 1'] }, 'equal(x, true) is a truth check');
  assert.deepEqual(assertionShape('assert.ok(a)'), { strength: 'loose', matcher: 'ok', args: ['a'], subjects: ['a'] });
  assert.deepEqual(assertionShape('assert(a)'), { strength: 'loose', matcher: '', args: ['a'], subjects: ['a'] });
  assert.deepEqual(assertionShape('assert.throws(fn)'), { strength: 'loose', matcher: 'throws', args: ['fn'], subjects: ['fn'] });
  assert.deepEqual(assertionShape('assert.throws(fn, /bad/)'), { strength: 'strict', matcher: 'throws', args: ['fn', '/bad/'], subjects: ['fn', '/bad/'] });
  assert.deepEqual(assertionShape('await assert.rejects(p)'), { strength: 'loose', matcher: 'rejects', args: ['p'], subjects: ['p'] });
  assert.deepEqual(assertionShape('assertEquals(expected, actual);'), { strength: 'strict', matcher: 'equals', args: ['expected', 'actual'], subjects: ['expected', 'actual'] });
  assert.deepEqual(assertionShape('assertNotNull(actual);'), { strength: 'loose', matcher: 'notnull', args: ['actual'], subjects: ['actual'] });
  assert.deepEqual(assertionShape('Assert.AreEqual(e, a)'), { strength: 'strict', matcher: 'areequal', args: ['e', 'a'], subjects: ['e', 'a'] });
  assert.deepEqual(assertionShape('require.Equal(t, want, got)'), { strength: 'strict', matcher: 'equal', args: ['t', 'want', 'got'], subjects: ['want', 'got'] });
  assert.deepEqual(assertionShape('assert.NotNil(t, got)'), { strength: 'loose', matcher: 'notnil', args: ['t', 'got'], subjects: ['got'] });
  assert.deepEqual(assertionShape('t.is(a, 1)'), { strength: 'strict', matcher: 'is', args: ['a', '1'], subjects: ['a'] });
  assert.deepEqual(assertionShape('t.not(a, 1)'), { strength: 'loose', matcher: 'notequal', args: ['a', '1'], subjects: ['a'] });
  assert.deepEqual(assertionShape('t.truthy(a)'), { strength: 'loose', matcher: 'truthy', args: ['a'], subjects: ['a'] });
  assert.deepEqual(assertionShape('assert_eq!(a, b);'), { strength: 'strict', matcher: 'eq', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert_ne!(a, b);'), { strength: 'loose', matcher: 'ne', args: ['a', 'b'], subjects: ['a', 'b'] });
  assert.deepEqual(assertionShape('assert!(a);'), { strength: 'loose', matcher: '', args: ['a'], subjects: ['a'] });
  assert.equal(assertionShape('t.Errorf("x")'), null);
  assert.equal(assertionShape('Frobnicate(a)'), null);
  assert.equal(assertionShape('assertFrobnicated(a)'), null);
  assert.equal(assertionShape('assert.equal(a'), null);
  assert.equal(assertionShape('nothing here'), null);
  assert.equal(assertionShape(null), null);
});

// ─── scope rules ─────────────────────────────────────────────────────────────────────────────────────────────────
test('outside-scope and denied-path, including both sides of a rename', () => {
  const d = mod('src/a.js', ['-x', '+y']) + mod('lib/b.js', ['-x', '+y']) + mod('src/secret.js', ['-x', '+y'])
    + 'diff --git a/lib/c.js b/src/c.js\nsimilarity index 100%\nrename from lib/c.js\nrename to src/c.js\n';
  const r = audit(d, 'allow src/**\ndeny src/secret.js');
  assert.deepEqual(r.findings.map((f) => [f.rule, f.path, f.text]), [
    ['outside-scope', 'lib/b.js', 'lib/b.js'], ['outside-scope', 'src/c.js', 'renamed from lib/c.js'], ['denied-path', 'src/secret.js', 'src/secret.js'],
  ]);
  const ren2 = audit('diff --git a/src/c.js b/src/secret.js\nsimilarity index 100%\nrename from src/c.js\nrename to src/secret.js\n', 'allow src/**\ndeny src/secret.js');
  assert.deepEqual(ren2.findings.map((f) => [f.rule, f.text]), [['denied-path', 'src/secret.js']]);
  const ren3 = audit('diff --git a/src/secret.js b/src/c.js\nsimilarity index 100%\nrename from src/secret.js\nrename to src/c.js\n', 'allow src/**\ndeny src/secret.js');
  assert.deepEqual(ren3.findings.map((f) => [f.rule, f.text]), [['denied-path', 'renamed from src/secret.js']]);
  assert.deepEqual(audit(mod('lib/b.js', ['-x', '+y'])).findings, [], 'no scope: nothing is outside');
  assert.equal(r.verdict, 'flagged');
  assert.deepEqual(r.files.map((f) => f.scope), ['allowed', 'outside', 'denied', 'allowed']);
});

test('unreadable-binary: a binary test, gate or snapshot change is a finding; a binary source file is not', () => {
  const bin = (p) => `diff --git a/${p} b/${p}\nindex 1..2 100644\nBinary files a/${p} and b/${p} differ\n`;
  assert.deepEqual(ruleIds(audit(bin('t/x.test.js'))), ['unreadable-binary']);
  assert.deepEqual(ruleIds(audit(bin('.github/workflows/ci.yml'))), ['unreadable-binary']);
  assert.deepEqual(ruleIds(audit(bin('a/__snapshots__/x.snap'))), ['unreadable-binary', 'snapshot-updated']);
  assert.deepEqual(ruleIds(audit(bin('img/logo.png'))), []);
});

// ─── test rules ─────────────────────────────────────────────────────────────────────────────────────────────────
test('skip-added catches every family of skip marker, and only when it is new', () => {
  const cases = [
    ['a.test.js', 'it.skip("x", () => {})'], ['a.test.js', 'describe.skip("x", () => {})'], ['a.test.ts', 'test.skipIf(win)("x", f)'],
    ['a.test.js', 'xit("x", () => {})'], ['a.test.js', 'xdescribe("x", () => {})'], ['a.test.js', '  this.skip();'],
    ['a.test.mjs', "test('x', { skip: true }, () => {})"], ['a.test.mjs', "test('x', { skip: 'flaky' }, () => {})"],
    ['tests/test_a.py', '@pytest.mark.skip(reason="later")'], ['tests/test_a.py', '@pytest.mark.xfail'], ['tests/test_a.py', '    pytest.skip("no")'],
    ['tests/test_a.py', '@unittest.skip("x")'], ['tests/test_a.py', '        self.skipTest("x")'], ['tests/test_a.py', '    raise unittest.SkipTest("x")'],
    ['a_test.go', '\tt.Skip("flaky")'], ['tests/a.rs', '#[ignore]'], ['src/FooTest.java', '@Disabled'], ['src/FooTest.java', '@Ignore'],
    ['FooTests.cs', '[Ignore("x")]'], ['FooTests.cs', '[Fact(Skip = "x")]'], ['tests/FooTest.php', '$this->markTestSkipped("x");'],
    ['spec/a_spec.rb', '  skip "not ready"'], ['spec/a_spec.rb', '  pending'],
  ];
  for (const [p, line] of cases) assert.deepEqual(rules(audit(mod(p, [' ctx', '+' + line]))), ['skip-added@2'], p + ': ' + line);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-it.skip("x", f)', '+  it.skip("x", f)']))), [], 'a skip that moved is not new');
  assert.deepEqual(rules(audit(mod('a.test.js', ['+// it.skip("x", f)']))), [], 'a skip in a comment is not a skip');
  assert.deepEqual(rules(audit(mod('src/a.js', ['+it.skip("x", f)']))), [], 'only test files');
  assert.deepEqual(rules(audit(mod('a.test.js', ['+skipCount += 1', '+const xitem = 1']))), []);
  assert.equal(audit(mod('a.test.js', ['+it.skip("x", f)'])).findings[0].severity, 'high');
});

test('only-added: it.only, describe.only, { only: true }, and Jasmine fit/fdescribe with a title', () => {
  for (const line of ['it.only("x", f)', 'describe.only("x", f)', "test('x', { only: true }, f)", 'fit("x", f)', "fdescribe('x', f)", 'ftest(`x`, f)'])
    assert.deepEqual(rules(audit(mod('a.test.js', ['+' + line]))), ['only-added@1'], line);
  assert.deepEqual(rules(audit(mod('a.test.js', ['+const m = fit(data, rows);']))), [], 'fit(...) without a title is model fitting');
  assert.deepEqual(rules(audit(mod('test_a.py', ['+fit("x")']))), [], 'Jasmine markers count only in JavaScript files');
  assert.deepEqual(rules(audit(mod('a.test.js', ["+assert.equal(x, 'non-fit (amendment 1)')"]))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-it.only("x", f)', '+it.only("x", f)']))), []);
});

test('assert-commented: a removed assertion that comes back as a comment', () => {
  const r = audit(mod('a.test.js', [' test("z", () => {', '-  expect(sum(0, 0)).toBe(0);', '+  // expect(sum(0, 0)).toBe(0);', ' });']));
  assert.deepEqual(rules(r), ['assert-commented@2']);
  const py = audit(mod('tests/test_a.py', ['-    assert f() == 1', '+    # assert f() == 1']));
  assert.deepEqual(rules(py), ['assert-commented@1']);
  assert.deepEqual(rules(audit(mod('a.test.js', ['+  // expect(sum(0, 0)).toBe(0);']))), [], 'a new comment that quotes an assertion is just a comment');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  x = 1;', '+  // x = 1;']))), [], 'only assertions');
  const twice = audit(mod('a.test.js', ['-  expect(a).toBe(1);', '+  // expect(a).toBe(1);', '+  // expect(a).toBe(1);']));
  assert.deepEqual(rules(twice), ['assert-commented@1'], 'one removed assertion, one finding');
});

test('assert-neutered (high) when a real assertion went; assert-always-true (review) when it was only added', () => {
  const r = audit(mod('a.test.js', ['-  expect(total(cart)).toBe(42);', '+  expect(true).toBe(true);']));
  assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.line]), [['assert-neutered', 'high', 1]]);
  const taut = ['assert.ok(true)', 'assert(true)', 'assertTrue(true)', 'expect(1).toBe(1)', "expect('a').toEqual('a')", 'expect(x).toBe(x)', 'expect(null).not.toBeNull()',
    'assert.equal(a, a)', 'assert.deepStrictEqual(r, r)', 'assertEquals(v, v)', 'assert_eq!(n, n);', 'assert!(true);', 'Assert.AreEqual(q, q)'];
  for (const t of taut) assert.deepEqual(rules(audit(mod('a.test.js', [' ctx', '+  ' + t]))), ['assert-always-true@2'], t);
  for (const t of ['assert True', 'assert 1', 'assert x == x', 'self.assertTrue(True)', 'self.assertEqual(r, r)'])
    assert.deepEqual(rules(audit(mod('tests/test_a.py', ['+    ' + t]))), ['assert-always-true@1'], t);
  assert.equal(audit(mod('a.test.js', ['+  assert.ok(true)'])).findings[0].severity, 'review');
  assert.deepEqual(rules(audit(mod('a.test.js', ['+  assert.ok(x)', '+  expect(x).toBe(y)', '+  assert.equal(a, b)']))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  assert.ok(true)', '+  assert.ok(true)']))), [], 'moved, not added');
  assert.deepEqual(rules(audit(mod('a.test.js', ['+  // assert.ok(true)']))), []);
  const tautRemoved = audit(mod('a.test.js', ['-  assert.ok(true)', '+  assert(true)']));
  assert.deepEqual(rules(tautRemoved), ['assert-always-true@1'], 'removing a tautology is not losing a real assertion');
  const realStays = audit(mod('a.test.js', ['-  expect(a).toBe(1)', '+  expect(a).toBe(1)', '+  assert.ok(true)']));
  assert.deepEqual(rules(realStays), ['assert-always-true@2'], 'a real assertion that is re-added was not lost');
});

test('matcher-loosened: an exact check replaced by a looser one on the same value', () => {
  const cases = [
    ['a.test.js', '  expect(result).toEqual({ a: 1 });', '  expect(result).toBeDefined();'],
    ['a.test.js', '  expect(fn).toThrow(TypeError);', '  expect(fn).toThrow();'],
    ['a.test.js', '  expect(n).toBe(5);', '  expect(n).toBeGreaterThan(0);'],
    ['a.test.js', '  expect(fn).toThrow("bad");', '  expect(fn).not.toThrow();'],
    ['a.test.js', '  assert.strictEqual(total, 42);', '  assert.ok(total);'],
    ['a.test.js', '  assert.deepEqual(rows, [1, 2]);', '  assert(rows);'],
    ['tests/test_a.py', '    assert len(r) == 3', '    assert len(r) > 0'],
    ['tests/test_a.py', '    assert r == expected', '    assert r'],
    ['tests/test_a.py', '    assert r is None', '    assert r is not None'],
    ['tests/test_a.py', '        self.assertEqual(r, 3)', '        self.assertTrue(r)'],
    ['src/FooTest.java', '    assertEquals(42, actual);', '    assertNotNull(actual);'],
    ['a_test.go', '\trequire.Equal(t, want, got)', '\trequire.NotNil(t, got)'],
    ['a.test.js', '  t.is(v, 3);', '  t.truthy(v);'],
  ];
  for (const [p, r, a] of cases) {
    const res = audit(mod(p, ['-' + r, '+' + a]));
    assert.deepEqual(rules(res), ['matcher-loosened@1'], p + ': ' + r);
    assert.equal(res.findings[0].text, r.trim() + ' → ' + a.trim());
  }
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).toBe(true);', '+  expect(x).toBeTruthy();']))), [], 'a truth check to a truth check is the same strength');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  assert.equal(x.length >= 1, true);', '+  assert.ok(x.length >= 1);']))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toEqual(1);', '+  expect(b).toBeDefined();']))), [], 'a different value');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toEqual(1);', '+  expect(a).toBeDefined();', '+  expect(a).toBe(1);']))), [], 'the exact check is still there');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toBeDefined();', '+  expect(a).toEqual(1);']))), [], 'tightened, not loosened');
  assert.deepEqual(rules(audit(mod('src/a.js', ['-  expect(a).toEqual(1);', '+  expect(a).toBeDefined();']))), [], 'only test files');
  const two = audit(mod('a.test.js', ['-  expect(a).toEqual(1);', '-  expect(a).toEqual(2);', '+  expect(a).toBeDefined();']));
  assert.deepEqual(rules(two), ['matcher-loosened@1', 'assert-net-loss@null'], 'one loose line pairs once, and one assertion is gone');
});

test('expected-changed (review): the same exact check with a new expected value', () => {
  const r = audit(mod('a.test.js', ['-  expect(price(2)).toBe(20);', '+  expect(price(2)).toBe(18);']));
  assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.line, f.text]), [['expected-changed', 'review', 1, 'expect(price(2)).toBe(20); → expect(price(2)).toBe(18);']]);
  assert.equal(r.verdict, 'review');
  assert.deepEqual(rules(audit(mod('tests/test_a.py', ['-    assert total(c) == 10', '+    assert total(c) == 11']))), ['expected-changed@1']);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toBe(1);', '+  expect(a).toEqual(2);']))), [], 'a different matcher is not this rule');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toBe(1);', '+    expect(a).toBe(1);']))), [], 're-indented only');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toBe(1)', '+  expect(a).toBe(1);']))), [], 'the same expected value');
  const pair = audit(mod('a.test.js', ['-  expect(a).toBe(1);', '-  expect(a).toBe(2);', '+  expect(a).toBe(3);', '+  expect(a).toBe(4);']));
  assert.deepEqual(rules(pair), ['expected-changed@1', 'expected-changed@2'], 'each added line pairs once');
});

test('tolerance-widened: more delta, fewer places', () => {
  const cases = [
    ['tests/test_a.py', '        self.assertAlmostEqual(a, b, places=7)', '        self.assertAlmostEqual(a, b, places=2)'],
    ['tests/test_a.py', '    np.testing.assert_allclose(a, b, rtol=1e-7)', '    np.testing.assert_allclose(a, b, rtol=1e-2)'],
    ['tests/test_a.py', '    assert a == pytest.approx(b, abs=0.001)', '    assert a == pytest.approx(b, abs=0.5)'],
    ['a.test.js', '  expect(x).toBeCloseTo(0.3, 5);', '  expect(x).toBeCloseTo(0.3, 1);'],
    ['a.test.js', '  expect(x).to.be.closeTo(10, 0.01);', '  expect(x).to.be.closeTo(10, 2);'],
    ['a.test.js', '  const tolerance = 0.001;', '  const tolerance = 0.1;'],
    ['a.test.js', '  near(x, 1, { epsilon: 1e-9 });', '  near(x, 1, { epsilon: 1e-3 });'],
    ['a_test.go', '\tassert.InDelta(t, 1.0, got, 0.01)', '\tassert.InDelta(t, 1.0, got, 0.5)'],
    ['a.test.js', '  check(x, { digits: 6 });', '  check(x, { digits: 2 });'],
  ];
  for (const [p, r, a] of cases) assert.deepEqual(ruleIds(audit(mod(p, ['-' + r, '+' + a]))), ['tolerance-widened'], p + ': ' + r);
  assert.deepEqual(rules(audit(mod('tests/test_a.py', ['-        self.assertAlmostEqual(a, b, places=2)', '+        self.assertAlmostEqual(a, b, places=7)']))), [], 'tightened');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  const tolerance = 0.1;', '+  const tolerance = 0.001;']))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  const timeout = 10;', '+  const timeout = 100;']))), [], 'not a tolerance');
  assert.deepEqual(rules(audit(mod('src/a.js', ['-  const tolerance = 0.001;', '+  const tolerance = 0.1;']))), [], 'only test files');
  const dedupe = audit(mod('tests/test_a.py', ['-    self.assertAlmostEqual(a, b, places=7)', '+    self.assertAlmostEqual(a, b, places=2)']));
  assert.deepEqual(ruleIds(dedupe), ['tolerance-widened'], 'the review finding on the same line is dropped');
});

test('test-file-deleted, test-moved-out, and a rename that stays a test', () => {
  const d = audit(del('t/a.test.js', ['test("x", () => {', '  expect(a).toBe(1);', '  assert.ok(b);', '});']));
  assert.deepEqual(d.findings.map((f) => [f.rule, f.severity, f.text]), [['test-file-deleted', 'high', '2 assertion lines removed']]);
  const mv = audit('diff --git a/t/a.test.js b/t/a.js.bak\nsimilarity index 100%\nrename from t/a.test.js\nrename to t/a.js.bak\n');
  assert.deepEqual(rules(mv), ['test-moved-out@null'], 'renamed so the runner no longer finds it');
  const inTestDir = audit('diff --git a/test/a.test.js b/test/a.js.bak\nsimilarity index 100%\nrename from test/a.test.js\nrename to test/a.js.bak\n');
  assert.deepEqual(rules(inTestDir), [], 'still inside a test folder, so still a test path');
  const mv2 = audit('diff --git a/src/a.test.js b/src/a.disabled.js\nsimilarity index 100%\nrename from src/a.test.js\nrename to src/a.disabled.js\n');
  assert.deepEqual(mv2.findings.map((f) => [f.rule, f.text]), [['test-moved-out', 'src/a.test.js → src/a.disabled.js']]);
  const keep = audit('diff --git a/src/a.test.js b/src/b.test.js\nsimilarity index 100%\nrename from src/a.test.js\nrename to src/b.test.js\n');
  assert.deepEqual(rules(keep), []);
  const snap = audit('diff --git a/src/a.test.js b/src/__snapshots__/a.snap\nsimilarity index 100%\nrename from src/a.test.js\nrename to src/__snapshots__/a.snap\n');
  assert.deepEqual(rules(snap), ['snapshot-updated@null'], 'a moved snapshot is a changed snapshot, and a snapshot is still a test path');
  const copy = audit('diff --git a/src/a.test.js b/src/a.js\nsimilarity index 100%\ncopy from src/a.test.js\ncopy to src/a.js\n');
  assert.deepEqual(rules(copy), [], 'a copy leaves the test where it was');
  assert.deepEqual(rules(audit(del('src/a.js', ['x']))), [], 'a deleted source file is not this rule');
});

test('assert-net-loss (review): a modified test file that lost assertions', () => {
  const r = audit(mod('a.test.js', [' test("x", () => {', '-  expect(a).toBe(1);', '-  expect(b).toBe(2);', '+  expect(a).toBe(1);', ' });']));
  assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.text]), [['assert-net-loss', 'review', '1 fewer assertion lines']]);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(a).toBe(1);', '+  expect(a).toBe(1);']))), []);
  assert.deepEqual(rules(audit(add('a.test.js', ['expect(a).toBe(1);']))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  // expect(a).toBe(1);']))), [], 'a commented assertion was never an assertion');
});

test('swallowed-failure (review): empty catch, .catch(() => {}), except: pass', () => {
  for (const l of ['  try { f(); } catch {}', '  try { f(); } catch (e) { }', '  p.catch(() => {});', '  p.catch((e) => undefined);', '  p.catch(e => null);'])
    assert.deepEqual(rules(audit(mod('a.test.js', ['+' + l]))), ['swallowed-failure@1'], l);
  assert.deepEqual(rules(audit(mod('tests/test_a.py', ['+    except Exception: pass']))), ['swallowed-failure@1']);
  assert.deepEqual(rules(audit(mod('tests/test_a.py', ['+    except: pass']))), ['swallowed-failure@1']);
  assert.deepEqual(rules(audit(mod('a.test.js', ['+  } catch (e) { assert.fail(e); }']))), []);
  assert.deepEqual(rules(audit(mod('src/a.js', ['+  } catch {}']))), [], 'only test files');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  p.catch(() => {});', '+  p.catch(() => {});']))), []);
});

test('snapshot-updated (review): a changed or deleted snapshot; a new one is not', () => {
  assert.deepEqual(audit(mod('src/__snapshots__/a.test.js.snap', ['-exports[`a`] = `1`;', '+exports[`a`] = `2`;'])).findings.map((f) => [f.rule, f.severity, f.text]), [['snapshot-updated', 'review', 'modified snapshot']]);
  assert.deepEqual(audit(del('golden/out.golden', ['x'])).findings.map((f) => f.text), ['deleted snapshot']);
  assert.deepEqual(rules(audit(add('src/__snapshots__/b.snap', ['x']))), []);
  assert.deepEqual(rules(audit(mod('src/__snapshots__/a.snap', ['-expect(a).toBe(1)', '+// expect(a).toBe(1)']))), ['snapshot-updated@null'], 'snapshot files run only this rule');
});

// ─── gate rules ─────────────────────────────────────────────────────────────────────────────────────────────────
test('failure-ignored: every pattern, in gate files only', () => {
  const lines = ['      continue-on-error: true', '  allow_failure: true', '        run: npm test || true', '        run: pytest || exit 0', '        run: make check || :',
    '          set +e', '"test": "jest --passWithNoTests"', '        run: flake8 --exit-zero', '          fail_ci_if_error: false', 'ignore_errors = true',
    '        run: pytest -k "not slow"', '        run: pytest --deselect tests/test_a.py::t', '        run: pytest --ignore=tests/slow', '    if: false', '    if: ${{ false }}',
    '"test": "jest --testPathIgnorePatterns=e2e"'];
  for (const l of lines) assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', [' x', '+' + l]))), ['failure-ignored@2'], l);
  assert.deepEqual(rules(audit(mod('src/a.sh', ['+npm test || true']))), [], 'only gate files');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['+# npm test || true']))), [], 'a comment');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: npm test || true', '+  run: npm test || true']))), [], 'already there');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['+  run: npm ci --ignore-scripts', '+  strategy: { fail-fast: false }', '+  run: pytest -k "slow"']))), []);
  assert.deepEqual(rules(audit(mod('witness.baseline.json', ['+  "reason": "equivalent: a || true is the same as true here"']))), ['baseline-grew@null'], 'a baseline is data');
  assert.equal(audit(mod('.gitlab-ci.yml', ['+  allow_failure: true'])).findings[0].severity, 'high');
});

test('failure-ignored: capture then check is honest', () => {
  const ok = [
    ['          node witness.mjs mutate k.mjs | tee gate.out || true', "          node -e \"const b=require('fs').readFileSync('gate.out','utf8');if(!/clean/.test(b))process.exit(1)\""],
    ['          node w.mjs > "verdict-$k.txt" 2>&1 || true', '          grep -q \'"clean": true\' "verdict-$k.txt" || exit 1'],
    ['          out=$(node judge.mjs --check || true) && echo "$out" && ! echo "$out" | grep -q DRIFT'],
    ['          (node night.mjs --check || true) | tee night1.txt && grep -q "^JUDGED" night1.txt'],
    ['          r=$(npm test || true)', '          echo "${r}" | grep -q "pass 12"'],
  ];
  for (const ls of ok) assert.deepEqual(rules(audit(mod('.github/workflows/gate.yml', ls.map((l) => '+' + l)))), [], ls[0]);
  const notChecked = [
    ['          npm test | tee out.txt || true', '          echo done'],
    ['          npm test > /dev/null || true', '          cat /dev/null'],
    ['          npm test 2>&1 || true'],
    ['          out=$(npm test || true)'],
    ['          npm test | tee out.txt || true'],
  ];
  for (const ls of notChecked) assert.deepEqual(ruleIds(audit(mod('.github/workflows/gate.yml', ls.map((l) => '+' + l)))), ['failure-ignored'], ls.join(' / '));
  const removedCheck = audit(mod('.github/workflows/gate.yml', ['+  npm test | tee out.txt || true', '-  grep -q pass out.txt']));
  assert.deepEqual(ruleIds(removedCheck), ['failure-ignored'], 'a check that was removed does not count');
});

test('test-run-removed: a test command gone from the hunk; a loop that still runs it is fine', () => {
  const cases = ['      - run: npm test', '        run: node --test kernel.test.mjs', '  run: pytest -q', '  run: python -m unittest', '  run: go test ./...', '  run: cargo test',
    '  "test": "jest"', '  "test": "vitest run"', '  "test": "mocha"', '  run: mvn -B verify', '  run: ./gradlew test', '  run: dotnet test', '  run: vendor/bin/phpunit',
    '  run: bundle exec rspec', '  commands = tox', 'test:\n\tmake test', '  run: npx playwright test', '  run: ctest', '      uses: sjgant80-hub/witness@v0.6', '  node witness.mjs mutate k.mjs'];
  for (const c of cases) {
    const l = c.split('\n').pop();
    assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', [' name: ci', '-' + l]))), ['test-run-removed@2'], l);
  }
  const loop = audit(mod('.github/workflows/ci.yml', ['-  node w/witness.mjs mutate a.mjs', '-  node w/witness.mjs mutate b.mjs', '+  for k in a b c; do node w/witness.mjs mutate $k.mjs; done']));
  assert.deepEqual(rules(loop), []);
  const ctx = audit(mod('.github/workflows/ci.yml', [' - run: npm test', '- - run: npm test']));
  assert.deepEqual(rules(ctx), [], 'the same runner is still in the hunk');
  const swap = audit(mod('.github/workflows/ci.yml', ['-  run: npm test', '+  run: npm run lint']));
  assert.deepEqual(rules(swap), ['test-run-removed@1']);
  assert.deepEqual(rules(audit(mod('package.json', ['-    "jest": "^29.0.0",', '-    "vitest": "latest"']))), [], 'a dependency line is not a command');
  assert.deepEqual(rules(audit(mod('pyproject.toml', ['-  "pytest>=7",', '-  pytest-cov = "^4"']))), []);
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  # npm test']))), [], 'a comment');
  assert.deepEqual(rules(audit(mod('scripts/run.sh', ['-npm test']))), [], 'only gate files');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: npm test', '+  run: npm test -- --coverage']))), []);
  const commentKeeps = audit(mod('.github/workflows/ci.yml', [' # npm test', '-  run: npm test']));
  assert.deepEqual(rules(commentKeeps), ['test-run-removed@2'], 'a comment that names the runner does not keep it');
});

test('test-script-noop: the package.json test script replaced by one that does nothing', () => {
  for (const v of ['"test": "echo ok"', '"test": "echo"', '"test": "exit 0",', '"test": "true"', '"test": ":"', '"test": ""'])
    assert.deepEqual(ruleIds(audit(mod('package.json', ['-    "test": "node --test",', '+    ' + v]))).sort(), ['test-run-removed', 'test-script-noop'].sort(), v);
  assert.deepEqual(rules(audit(mod('package.json', ['+    "test": "echo \\"Error: no test specified\\" && exit 1"']))), [], "npm's default fails, it is not a no-op");
  assert.deepEqual(rules(audit(mod('package.json', ['+    "test": "node --test"']))), []);
  assert.deepEqual(rules(audit(mod('web/package.json', ['+    "test": "echo skip"']))), ['test-script-noop@1']);
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['+    "test": "echo skip"']))), [], 'only package.json');
  assert.deepEqual(rules(audit(mod('package.json', ['-    "test": "echo ok"', '+    "test": "echo ok"']))), []);
});

test('threshold-lowered: coverage and mutation-score floors that went down', () => {
  const cases = [['      "lines": 80,', '      "lines": 70,'], ['  --cov-fail-under=90', '  --cov-fail-under=60'], ['fail_under = 95', 'fail_under = 50'],
    ['    thresholds: { high: 90, low: 80, break: 75 }', '    thresholds: { high: 90, low: 80, break: 40 }'], ['  coverageThreshold: { global: { branches: 100 } }', '  coverageThreshold: { global: { branches: 90 } }'],
    ['  minimum_coverage 95', '  minimum_coverage 90'], ['  mutation-score: 0.9', '  mutation-score: 0.5'], ['  statements: 80', '  statements: 79.5'], ['  functions: 80', '  functions: 0']];
  for (const [r, a] of cases) assert.deepEqual(rules(audit(mod('jest.config.js', ['-' + r, '+' + a]))), ['threshold-lowered@1'], r);
  assert.deepEqual(rules(audit(mod('jest.config.js', ['-      "lines": 70,', '+      "lines": 80,']))), [], 'raised');
  assert.deepEqual(rules(audit(mod('.eslintrc.json', ['-  "max-lines": 300', '+  "max-lines": 200']))), [], 'a max going down is stricter');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  node-version: 22', '+  node-version: 20']))), [], 'no threshold word');
  assert.deepEqual(rules(audit(mod('src/a.js', ['-  lines: 80', '+  lines: 70']))), [], 'only gate files');
  assert.deepEqual(rules(audit(mod('jest.config.js', ['-  lines: 80', '+  lines: 80 ']))), [], 'the same number');
});

test('check-turned-off: strict and failure settings switched off, skip and ignore switched on', () => {
  for (const [r, a] of [['    "strict": true,', '    "strict": false,'], ['    "noImplicitAny": true', '    "noImplicitAny": false'], ['    "checkJs": true', '    "checkJs": false'],
    ['    failOnWarnings: true', '    failOnWarnings: false'], ['    verify_ssl: True', '    verify_ssl: False'], ['    "skipLibCheck": false', '    "skipLibCheck": true'],
    ['    ignoreDeprecations: false', '    ignoreDeprecations: true'], ['    "noUnusedLocals": true', '    "noUnusedLocals": false'], ['    lint: true', '    lint: false']])
    assert.deepEqual(rules(audit(mod('tsconfig.json', ['-' + r, '+' + a]))), ['check-turned-off@1'], r);
  for (const [r, a] of [['    "strict": false,', '    "strict": true,'], ['    "skipLibCheck": true', '    "skipLibCheck": false'], ['      fail-fast: true', '      fail-fast: false'],
    ['    "allowJs": true', '    "allowJs": false'], ['    verbose: true', '    verbose: false'], ['    "strict": true,', '    "strict":  true,']])
    assert.deepEqual(rules(audit(mod('tsconfig.json', ['-' + r, '+' + a]))), [], r);
  const coe = audit(mod('.github/workflows/ci.yml', ['-      continue-on-error: false', '+      continue-on-error: true']));
  assert.deepEqual(rules(coe), ['failure-ignored@1'], 'continue-on-error belongs to failure-ignored, once');
  const fc = audit(mod('codecov.yml', ['-  fail_ci_if_error: true', '+  fail_ci_if_error: false']));
  assert.deepEqual(rules(fc), ['failure-ignored@1']);
  const af = audit(mod('.gitlab-ci.yml', ['-  allow_failure: false', '+  allow_failure: true']));
  assert.deepEqual(rules(af), ['failure-ignored@1']);
  assert.deepEqual(rules(audit(mod('src/conf.js', ['-  strict: true', '+  strict: false']))), [], 'only gate files');
});

test('baseline-grew (review) and checker-silenced (review)', () => {
  const b = audit(mod('witness.baseline.json', [' {', '+  "a": 1,', '+  "b": 2', ' }']));
  assert.deepEqual(b.findings.map((f) => [f.rule, f.severity, f.text]), [['baseline-grew', 'review', '2 more lines']]);
  assert.deepEqual(rules(audit(mod('witness.baseline.json', ['-  "a": 1', '+  "b": 2']))), []);
  assert.deepEqual(rules(audit(mod('witness.baseline.json', ['-  "a": 1', '-  "c": 1', '+  "b": 2']))), []);
  for (const l of ['// eslint-disable-next-line', 'x = 1 // @ts-ignore', '// @ts-nocheck', '// @ts-expect-error', 'y = f()  # type: ignore', 'import os  # noqa', 'if x:  # pragma: no cover',
    '/* istanbul ignore next */', '/* c8 ignore next */', '/* v8 ignore next */', 'x := f() //nolint', '#[allow(dead_code)]', '@SuppressWarnings("unchecked")', '# pylint: disable=E1101', '# rubocop:disable Metrics', 'x = 1; // NOSONAR'])
    assert.deepEqual(rules(audit(mod('src/a.js', ['+' + l]))), ['checker-silenced@1'], l);
  assert.deepEqual(rules(audit(mod('src/a.js', ['-// eslint-disable-next-line', '+  // eslint-disable-next-line']))), [], 'moved');
  assert.equal(audit(mod('src/a.js', ['+// @ts-ignore'])).verdict, 'review');
});

// ─── the claim check ─────────────────────────────────────────────────────────────────────────────────────────────
test('claimedPaths reads files and folders from prose, not "and/or" or URLs', () => {
  assert.deepEqual(claimedPaths('Changed src/a.ts and `lib/b` plus kernel.mjs. Also and/or docs/ and https://x.com/a.js and (tests/x.py), "q.yml"'),
    ['lib/b', 'src/a.ts', 'kernel.mjs', 'docs/', 'tests/x.py', 'q.yml']);
  assert.deepEqual(claimedPaths('see ./a/b.js; a/c.js, b/d.js: done'), ['a/b.js', 'a/c.js', 'b/d.js']);
  assert.deepEqual(claimedPaths('`https://x.io/a.js` `notapath` `v1.2` `x.js`'), ['x.js']);
  assert.deepEqual(claimedPaths('version 1.2.3 and www.example.com and e.g. 3.5'), []);
  assert.deepEqual(claimedPaths(null), []);
});

test('unclaimed-change and claimed-untouched compare the summary with the diff', () => {
  const d = mod('src/auth.js', ['-a', '+b']) + mod('src/util/fmt.js', ['-a', '+b']) + mod('.github/workflows/ci.yml', ['-a', '+b']);
  const r = audit(d, '', 'I fixed the login bug in auth.js and tidied src/util/. I also updated README.md.');
  assert.deepEqual(r.findings.map((f) => [f.rule, f.path, f.severity]), [
    ['unclaimed-change', '.github/workflows/ci.yml', 'review'], ['claimed-untouched', 'README.md', 'review'],
  ]);
  const all = audit(d, '', 'Changed `src/auth.js`, src/util/fmt.js and .github/workflows/ci.yml');
  assert.deepEqual(all.findings, []);
  const ren = audit('diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n', '', 'renamed old.js');
  assert.deepEqual(ren.findings, [], 'naming either side of a rename counts');
  assert.deepEqual(audit(d, '', '   ').findings, [], 'an empty summary is no claim');
  assert.deepEqual(audit(d, '', 42).findings, []);
  const sub = audit(mod('pkg/src/auth.js', ['-a', '+b']), '', 'edited src/auth.js');
  assert.deepEqual(sub.findings, [], 'a path that ends the touched path');
  const dirOnly = audit(mod('pkg/src/auth.js', ['-a', '+b']), '', 'edited src/');
  assert.deepEqual(dirOnly.findings, [], 'a folder inside the path');
  const wrong = audit(mod('pkg/src/auth.js', ['-a', '+b']), '', 'edited lib/ and xauth.js');
  assert.deepEqual(wrong.findings.map((f) => f.rule + ':' + f.path), ['unclaimed-change:pkg/src/auth.js', 'claimed-untouched:lib/', 'claimed-untouched:xauth.js']);
});

// ─── the verdict, the order, the fingerprints, the exit codes ─────────────────────────────────────────────────
test('audit: verdict, counts, files, the high-first order and the line clip', () => {
  const long = 'x'.repeat(300);
  const d = mod('src/a.js', ['+// eslint-disable-line ' + long]) + mod('a.test.js', ['-  expect(a).toBe(1);', '+  // expect(a).toBe(1);', '+  it.only("x", f)']);
  const r = audit(d);
  assert.equal(r.ok, true);
  assert.equal(r.v, 'scopeguard/1.2');
  assert.equal(r.verdict, 'flagged');
  assert.deepEqual(r.counts, { files: 2, high: 2, review: 1, added: 3, removed: 1 });
  assert.deepEqual(r.findings.map((f) => f.rule), ['only-added', 'assert-commented', 'checker-silenced'], 'high first, then the rule table order');
  assert.equal(r.findings[2].text.length, 200);
  assert.ok(r.findings[2].text.endsWith('…'));
  assert.deepEqual(r.files, [
    { path: 'src/a.js', oldPath: null, status: 'modified', kind: 'source', scope: 'unscoped', binary: false, added: 1, removed: 0 },
    { path: 'a.test.js', oldPath: null, status: 'modified', kind: 'test', scope: 'unscoped', binary: false, added: 2, removed: 1 },
  ]);
  assert.deepEqual(r.findings[0], { rule: 'only-added', severity: 'high', path: 'a.test.js', line: 2, side: '+', text: 'it.only("x", f)' });
  const clean = audit(mod('src/a.js', ['-a', '+b']));
  assert.equal(clean.verdict, 'clean');
  assert.deepEqual(clean.counts, { files: 1, high: 0, review: 0, added: 1, removed: 1 });
  assert.deepEqual(audit(''), { ok: true, v: 'scopeguard/1.2', verdict: 'clean', counts: { files: 0, high: 0, review: 0, added: 0, removed: 0 }, files: [], findings: [] });
  const rev = audit(mod('src/a.js', ['+// @ts-ignore']));
  assert.deepEqual([rev.verdict, rev.counts.high, rev.counts.review], ['review', 0, 1]);
  const exactly200 = audit(mod('src/a.js', ['+// @ts-ignore ' + 'y'.repeat(200 - 14)]));
  assert.equal(exactly200.findings[0].text.length, 200);
  assert.ok(!exactly200.findings[0].text.endsWith('…'));
});

test('audit passes refusals through and refuses a bad scope', () => {
  assert.deepEqual(audit('diff --cc x\n'), { ok: false, why: 'a combined merge diff cannot be checked: diff against one parent', line: 1 });
  assert.deepEqual(audit(mod('a.js', ['-a', '+b']), 'nonsense here'), { ok: false, why: 'scope line 1 is not "allow|deny|tests|gate <pattern>": nonsense here', line: 0 });
  assert.deepEqual(audit(null), { ok: false, why: 'the diff must be text', line: 0 });
});

test('a review finding on the same line as a high one is dropped; a high one never is', () => {
  const r = audit(mod('a.test.js', ['-  expect(n).toBe(5);', '-  expect(m).toBe(1);', '+  expect(n).toBeGreaterThan(0);', '+  expect(m).toBe(2);']));
  assert.deepEqual(rules(r), ['matcher-loosened@1', 'expected-changed@2']);
  const two = audit(mod('a.test.js', ['+  describe.only("x", () => { it.skip("y", f) })']));
  assert.deepEqual(rules(two), ['skip-added@1', 'only-added@1'], 'two high findings on one line both stay');
  const fileLevel = audit(mod('a.test.js', ['-  expect(a).toBe(1);', '-  expect(b).toBe(1);', '+  it.skip("x", f)']));
  assert.deepEqual(rules(fileLevel), ['skip-added@1', 'assert-net-loss@null'], 'a file-level finding has no line to share');
});

test('scope-file-changed: a change to the scope file itself, at the repository root', () => {
  const r = audit(mod('.scopeguard', ['-allow src/**', '+allow **']));
  assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.text]), [['scope-file-changed', 'high', 'modified .scopeguard']]);
  assert.deepEqual(ruleIds(audit(add('.scopeguard', ['allow **']), 'allow src/**')), ['outside-scope', 'scope-file-changed']);
  assert.deepEqual(audit('diff --git a/.scopeguard b/scope.txt\nsimilarity index 100%\nrename from .scopeguard\nrename to scope.txt\n').findings.map((f) => f.text), ['renamed .scopeguard']);
  assert.deepEqual(rules(audit(mod('sub/.scopeguard', ['-a', '+b']))), [], 'only the root scope file is read, so only it is guarded');
});

test('v1.1 · test-run-removed: dropping one gated file from a list is a finding; the same files run another way are not', () => {
  const drop = audit(mod('.github/workflows/ci.yml', ['   node .witness/witness.mjs mutate seed.mjs --test node seed.test.mjs', '-  node .witness/witness.mjs mutate verify-wire.mjs --test node verify-wire.test.mjs', '   node .witness/witness.mjs mutate kard.mjs --test node kard.test.mjs']));
  assert.deepEqual(rules(drop), ['test-run-removed@2'], 'witness still runs, verify-wire is no longer gated');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['   run: node --test a.test.mjs', '-  run: node --test b.test.mjs']))), ['test-run-removed@2']);
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test kernel.test.mjs', '+  run: node --test kernel.test.mjs extra.test.mjs']))), [], 'the same file still runs');
  const loop = audit(mod('.github/workflows/ci.yml', ['-  node w/witness.mjs mutate socket.mjs --test node --test socket.test.mjs', '-  node w/witness.mjs mutate recycle.mjs --test node --test recycle.test.mjs', '+  for k in socket recycle costcase; do', '+    node w/witness.mjs mutate $k.mjs --test node --test $k.test.mjs', '+  done']));
  assert.deepEqual(rules(loop), [], 'a loop that names every file still runs them');
  const loopDrops = audit(mod('.github/workflows/ci.yml', ['-  node w/witness.mjs mutate socket.mjs --test node --test socket.test.mjs', '-  node w/witness.mjs mutate recycle.mjs --test node --test recycle.test.mjs', '+  for k in socket costcase; do', '+    node w/witness.mjs mutate $k.mjs --test node --test $k.test.mjs', '+  done']));
  assert.deepEqual(rules(loopDrops), ['test-run-removed@2'], 'the loop left recycle out');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['   # node --test recycle.test.mjs', '-  run: node --test recycle.test.mjs']))), ['test-run-removed@2'], 'a comment naming it does not keep it');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['   - name: test recycle', '   run: node --test kernel.test.mjs', '-  run: node --test recycle.test.mjs']))), ['test-run-removed@3'], 'a step name naming it does not keep it');
  assert.deepEqual(K.targetsOf('node .witness/witness.mjs mutate verify-wire.mjs --test node verify-wire.test.mjs tests/test_api.py a_spec.rb x.spec.ts'), ['verify-wire.test.mjs', 'test_api.py', 'a_spec.rb', 'x.spec.ts', 'verify-wire.mjs']);
  assert.deepEqual(K.targetsOf('"test": "node --test test/*.test.mjs", "start": "node run.mjs"'), [], 'a glob names no file, and a script is not a test');
  assert.deepEqual(K.targetsOf('node w.mjs mutate "src/$k.mjs" --test node --test "test/$k.test.mjs"'), [], 'a name built from a variable');
  assert.deepEqual(K.targetsOf('npm test'), []);
  assert.deepEqual(K.targetsOf(null), []);
  assert.deepEqual(['socket.test.mjs', 'socket.mjs', 'a_spec.rb', 'test_api.py', 'verify-wire.mjs'].map(K.stemOf), ['socket', 'socket', 'a', 'test_api', 'verify-wire']);
  assert.equal(K.stemOf(null), '');
  // the honest shapes met on real commits
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-        run: node --test pass.test.mjs tier.test.mjs client.test.mjs', '+        run: node --test *.test.mjs']))), [], 'a glob of the same runner runs them all');
  assert.deepEqual(rules(audit(mod('package.json', ['-    "test": "node --test tier.test.mjs pass.test.mjs",', '+    "test": "node --test",']))), [], 'node --test alone finds every test file');
  assert.deepEqual(rules(audit(mod('package.json', ['-  "scripts": { "start": "node run.mjs", "test": "node --test test/nest.test.mjs", "gate": "node konomi/run-gate.mjs" },', '+  "scripts": {', '+    "test": "node --test test/nest.test.mjs",', '+    "start": "node run.mjs"', '+  },']))), [], 'a one-line scripts block split into lines');
  const dead = audit(mod('.github/workflows/gate.yml', ['           node .witness/witness.mjs mutate safe.mjs --test node --test safe.test.mjs | tee -a gate.out', '-          node .witness/witness.mjs mutate bridge.mjs --test node --test | tee -a gate.out', '           node .witness/witness.mjs mutate trial.mjs --test node --test trial.test.mjs | tee -a gate.out']));
  assert.deepEqual(rules(dead), ['test-run-removed@2'], 'a diff cannot tell that bridge.mjs no longer exists: a reviewer reads it');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['   node w/witness.mjs mutate $k.mjs', '-  node w/witness.mjs mutate seed.mjs']))), ['test-run-removed@2'], 'a loop body with no list does not sweep');
  // patterns: a removed pattern is kept only by the same pattern or by a command that names nothing
  assert.deepEqual(rules(audit(mod('.github/workflows/kards.yml', ['-        run: node --test kards/*.test.mjs', '         run: node --test kernel.test.mjs']))), ['test-run-removed@1'], 'kards/*.test.mjs no longer runs');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test test/*.test.mjs', '+  run: node --test test/*.test.mjs --test-reporter=spec']))), [], 'the same pattern');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test *.test.mjs', '+  run: node --test']))), [], 'a bare node --test finds everything');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test kards/*.test.mjs', '+  run: node --test *.test.mjs']))), ['test-run-removed@1'], 'another pattern does not cover it');
  assert.deepEqual(K.globsOf('"test": "node --test test/*.test.mjs", x: jest "src/**/*.spec.ts" a.js *.md'), ['test/*.test.mjs', 'src/**/*.spec.ts']);
  assert.deepEqual(K.globsOf('node --test *.test.mjs'), ['*.test.mjs']);
  assert.deepEqual(K.globsOf(null), []);
  assert.deepEqual(K.targetsOf('node --test kards/kardart.smoke.test.mjs a.b_spec.rb'), ['kardart.smoke.test.mjs', 'a.b_spec.rb'], 'names with dots');
  assert.deepEqual(rules(audit(mod('.github/workflows/kards.yml', ['         run: node --test kards/*.test.mjs', '-        run: node --test kards/kardart.smoke.test.mjs']))), [], 'the pattern still runs the file');
  assert.deepEqual(rules(audit(mod('.github/workflows/kards.yml', ['-        run: node --test kards/*.test.mjs', '         run: node --test kards/kardart.smoke.test.mjs']))), ['test-run-removed@1'], 'one named file does not run the whole pattern');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test a.test.mjs', '   run: node --test --test-reporter=spec']))), [], 'a bare command with options still finds everything');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  run: node --test a.test.mjs', '   run: node --test tools/check.mjs']))), ['test-run-removed@1'], 'a command naming another file is not bare');
  assert.equal(K.hasWord('for k in socket recycle; do', 'socket'), true);
  assert.equal(K.hasWord('for k in sockets; do', 'socket'), false);
  assert.equal(K.hasWord('node a-socket.mjs', 'socket'), false, 'a hyphen joins a name');
  assert.equal(K.hasWord('mutate verify-wire.mjs', 'verify-wire'), true);
  assert.equal(K.hasWord('x.y', 'x.y'), true, 'a name is matched literally');
  assert.equal(K.hasWord('xzy', 'x.y'), false);
  assert.equal(K.hasWord(null, 'x'), false);
  assert.equal(K.hasWord('x', null), false);
});

test('v1.1 · matcher-loosened: a loosened check is found even when the same value gets other exact checks', () => {
  const generic = audit(mod('tests/store.test.mjs', ['-  assert.match(r.why, /shield does not match/);', '+  assert.ok(r.why);', '+  assert.match(r.why, /another reason/);']));
  assert.deepEqual(rules(generic), ['matcher-loosened@1']);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  assert.equal(a, 1);', '+  assert.equal( a, 1 )', '+  assert.ok(a);']))), [], 'the same check reformatted is still there');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).toEqual({ a: 1 });', '+  expect(x).toStrictEqual({ a: 1 });', '+  expect(x).toBeDefined();']))), [], 'the same expected value under a stricter matcher');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).toEqual({ a: 1 });', '+  expect(x).toStrictEqual({ a: 2 });']))), [], 'a different matcher and a different value: neither rule');
});

test('v1.1 · assert-neutered: judged in the hunk where the always-true line was added', () => {
  const two = 'diff --git a/kernel.test.mjs b/kernel.test.mjs\nindex 1..2 100644\n--- a/kernel.test.mjs\n+++ b/kernel.test.mjs\n'
    + '@@ -1,2 +1,2 @@\n test("a", () => {\n-  assert.strictEqual(result.ok, false);\n+  expect(true).toBe(true);\n'
    + '@@ -20,1 +20,2 @@\n test("b", () => {\n+  assert.strictEqual(result.ok, false);\n';
  assert.deepEqual(rules(audit(two)), ['assert-neutered@2'], 'an identical line in another hunk does not hide the replacement');
  const elsewhere = 'diff --git a/kernel.test.mjs b/kernel.test.mjs\nindex 1..2 100644\n--- a/kernel.test.mjs\n+++ b/kernel.test.mjs\n'
    + '@@ -1,2 +1,1 @@\n test("a", () => {\n-  assert.equal(x, 1);\n'
    + '@@ -20,1 +19,2 @@\n test("b", () => {\n+  assert.ok(true);\n';
  assert.deepEqual(rules(audit(elsewhere)), ['assert-always-true@20'], 'a real assertion lost in another hunk is not a replacement here');
});

test('line rules count lines, so two new copies of one marker are two findings when one was removed', () => {
  assert.deepEqual(rules(audit(mod('a.test.js', ['-it.skip("x", f)', '+it.skip("x", f)', '+it.skip("x", f)']))), ['skip-added@2']);
});

test('pairing by shape: each removed line pairs with its own added line, and only with one of the same shape', () => {
  assert.deepEqual(rules(audit(mod('jest.config.js', ['-  coverage: 80', '-  coverage: 90', '+  coverage: 70', '+  coverage: 95']))), ['threshold-lowered@1']);
  assert.deepEqual(rules(audit(mod('jest.config.js', ['-  lines: 80', '+  branches: 60']))), [], 'a different setting is not the same threshold');
  assert.deepEqual(rules(audit(mod('jest.config.js', ['-  thresholds: { high: 90, low: 80 }', '+  thresholds: { high: 95, low: 80 }']))), [], 'raised, with one number unchanged');
});

test('tolerance edges: a changed expected value next to an unchanged tolerance is not a widening', () => {
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).toBeCloseTo(0.3, 5);', '+  expect(x).toBeCloseTo(0.4, 5);']))), ['expected-changed@1']);
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).toBeCloseTo(0.3, 5);', '+  expect(x).toBeCloseTo(0.4, 6);']))), ['expected-changed@1'], 'value changed, tolerance tightened');
  assert.deepEqual(rules(audit(mod('a.test.js', ['-  expect(x).to.be.closeTo(10, 0.5);', '+  expect(x).to.be.closeTo(11, 0.5);']))), []);
});

test('switch edges: every setting on a one-line config is compared, each with its own name', () => {
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-  { "strict": true, "noImplicitAny": true }', '+  { "strict": true, "noImplicitAny": false }']))), ['check-turned-off@1'], 'the second setting switched off');
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-  { "skipLibCheck": true, "strict": false }', '+  { "skipLibCheck": true, "strict": true }']))), [], 'the second switched on: stricter');
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-  { "verbose": true, "skipLibCheck": false }', '+  { "verbose": false, "skipLibCheck": true }']))), ['check-turned-off@1'], 'a later setting decides when the first is not a check');
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-  { "strict": false, "skipLibCheck": true }', '+  { "strict": true, "skipLibCheck": false }']))), [], 'both moved the strict way');
  assert.deepEqual(rules(audit(mod('.github/workflows/ci.yml', ['-  { continue-on-error: false, verbose: true }', '+  { continue-on-error: true, verbose: false }']))), ['failure-ignored@1'], 'continue-on-error is its own rule');
});

test('switch edges: adding a comma to a setting is not switching it', () => {
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-    "skipLibCheck": true', '+    "skipLibCheck": true,']))), []);
  assert.deepEqual(rules(audit(mod('tsconfig.json', ['-    "strict": true', '+    "strict": true,']))), []);
});

test('claimedPaths ignores an empty path and a web address with a slash', () => {
  assert.deepEqual(claimedPaths('see ./ here and www.example.com/ there'), []);
});

test('a review finding on the same line as a high one is dropped, whichever came first', () => {
  assert.deepEqual(rules(audit(mod('a.test.js', ['+  it.skip("x", f) // eslint-disable-line']))), ['skip-added@1']);
});

test('fingerprintInput and fingerprintResult are fixed JSON recipes', () => {
  assert.equal(fingerprintInput('a\r\nb', 'allow x', 'did it'), '{"diff":"a\\nb","scope":"allow x","claim":"did it"}');
  assert.equal(fingerprintInput('d'), '{"diff":"d","scope":"","claim":""}');
  assert.equal(fingerprintInput(1, 2, 3), '{"diff":"","scope":"","claim":""}');
  const r = audit(mod('a.test.js', ['+it.only("x", f)']));
  assert.equal(fingerprintResult(r), JSON.stringify({ v: r.v, verdict: r.verdict, files: r.files, findings: r.findings }));
  assert.equal(fingerprintResult({ ok: false, why: 'no' }), '{"ok":false,"why":"no"}');
  assert.equal(fingerprintResult(null), '{"ok":false,"why":""}');
  assert.equal(fingerprintResult({ ok: true, v: 1n }), '');
  assert.equal(fingerprintResult({ ok: 'true' }), '{"ok":false,"why":""}');
  assert.equal(fingerprintResult({ ok: false, why: 7 }), '{"ok":false,"why":"7"}');
});

test('exitCode: 0 clean, 2 flagged, review fails only when asked, 1 unreadable', () => {
  const flagged = audit(mod('a.test.js', ['+it.only("x", f)']));
  const review = audit(mod('src/a.js', ['+// @ts-ignore']));
  const clean = audit(mod('src/a.js', ['-a', '+b']));
  assert.equal(exitCode(flagged), 2);
  assert.equal(exitCode(flagged, 'review'), 2);
  assert.equal(exitCode(review), 0);
  assert.equal(exitCode(review, 'high'), 0);
  assert.equal(exitCode(review, 'review'), 2);
  assert.equal(exitCode(clean), 0);
  assert.equal(exitCode(clean, 'review'), 0);
  assert.equal(exitCode(audit('diff --cc x')), 1);
  assert.equal(exitCode(null), 1);
  assert.equal(exitCode({ ok: 1 }), 1);
});

test('total: no exported function throws on hostile input', () => {
  const circular = {}; circular.self = circular;
  const toxic = { toString() { throw new Error('t'); }, get ok() { throw new Error('g'); } };
  const inputs = [null, undefined, NaN, '', '   ', [], {}, true, 10n, () => {}, 'x'.repeat(5000), circular, toxic, -1, 0, '\u0000\u0001', 'diff --git a/x b/x\n@@ -1 +1 @@\n'];
  const fns = [globToRegExp, parseScope, classify, unquotePath, parseDiff, isComment, uncomment, isAssertion, assertionShape, splitArgs, cutHashComment, claimedPaths, audit, fingerprintInput, fingerprintResult];
  for (const fn of fns) for (const x of inputs) assert.doesNotThrow(() => fn(x, x, x), fn.name);
  for (const x of inputs) assert.doesNotThrow(() => closeParen(x, 0));
  for (const x of inputs) { let v; assert.doesNotThrow(() => { v = exitCode(x); }); assert.ok(v === 1 || x === toxic); }
  assert.equal(audit(toxic).ok, false);
  assert.equal(parseScope(toxic).ok, false);
});

test('v1.2 · a marker or an assertion inside a string literal is data, not code', () => {
  const fixtures = [
    "+const SKIP = 'diff --git a/t.test.js b/t.test.js\\n+it.skip(\"adds\", () => {\\n';",
    "+  writeFileSync(join(d, 'x.test.js'), 'it.only(\"x\", () => {});\\n');",
    "+  const taut = `expect(true).toBe(true)`;",
    "+  const sw = 'try { f(); } catch {}';",
    "+  const fx = \"  @pytest.mark.skip(reason='x')\";",
  ];
  assert.deepEqual(rules(audit(mod('cli.test.mjs', fixtures))), []);
  assert.deepEqual(rules(audit(mod('a.test.js', ["-  expect(r.pence).toBe(2500);", "+  const s = '  expect(r.pence).toBeDefined();';"]))), ['assert-net-loss@null'], 'a quoted assertion is not an added assertion, so one was lost');
  assert.deepEqual(rules(audit(mod('a.test.js', ["+it.skip('real title', () => {})", "+test('x', { skip: 'flaky' }, () => {})"]))), ['skip-added@1', 'skip-added@2'], 'a real marker is outside the quotes');
  assert.deepEqual(rules(audit(mod('a.test.js', ["-  expect(a).toEqual(1);", "+  expect(a).toBeDefined(); // it's fine"]))), ['matcher-loosened@1'], 'a quote after the code does not hide it');
  assert.deepEqual(rules(audit(mod('package.json', ['+    "test": "jest --passWithNoTests"']))), ['failure-ignored@1'], 'a config value is a string and still counts');
  assert.equal(K.inString("a 'b' c", 3), true);
  assert.equal(K.inString("a 'b' c", 5), false);
  assert.equal(K.inString('a "x\\"y" z', 6), true, 'an escaped quote does not close the string');
  assert.equal(K.inString('a `t` b', 3), true);
  assert.equal(K.inString(null, 1), false);
  assert.equal(K.inCode(/x/, "'x' x"), true);
  assert.equal(K.inCode(/x/, "'x'"), false);
  assert.equal(K.inCode('x', 'x'), false);
  assert.equal(K.inCode(/x/g, 'x'), true, 'a global pattern works the same');
  assert.equal(K.inCode(/x/, null), false);
});

test('v1.2 · checker-silenced: a suppression inside a string is data', () => {
  assert.deepEqual(rules(audit(mod('src/a.js', ["+const IGNORE = 'x = 1 // @ts-ignore';"]))), []);
  assert.deepEqual(rules(audit(mod('src/a.js', ["+x = f('a'); // @ts-ignore"]))), ['checker-silenced@1']);
  assert.deepEqual(rules(audit(mod('src/a.js', ["-x = f('a'); // @ts-ignore", "+x = f('a');  // @ts-ignore"]))), [], 'moved');
});

test('v1.2 · an assertion whose first argument is a string is still an assertion', () => {
  assert.deepEqual(assertionShape("expect('abc').toEqual(x)"), { strength: 'strict', matcher: 'toEqual', args: ['x'], subjects: [] });
  assert.deepEqual(assertionShape("assert.equal('a', x)"), { strength: 'strict', matcher: 'equal', args: ["'a'", 'x'], subjects: ['x'] });
  assert.deepEqual(assertionShape("const s = 'assert.equal(a, b)'"), null, 'one inside a string is not');
});
