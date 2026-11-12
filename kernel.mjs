// kernel.mjs — ScopeGuard: did a code change stay inside the files it was allowed to touch, and did it make the
// tests easier to pass instead of making the code right?
//
// Reads a unified diff (git diff, git show, git format-patch, a pull request's .diff) and an optional scope file,
// classifies every touched path, and runs a closed list of rules over the added and removed lines. Every finding
// names its rule, its file and the line it came from. No AI judge, no network, no clock, no randomness.
//
// Pure and total: every exported function returns a value for any input and never throws.

export const VERSION = 'scopeguard/1.1';
export const SCOPE_FILE = '.scopeguard';
export const MAX_CHARS = 50_000_000;

// ─── the closed rule list ─────────────────────────────────────────────────────────────────────────────────────────
// severity high: a reviewer must not merge without reading it. review: worth a look, often honest.
export const RULES = Object.freeze([
  { id: 'outside-scope', severity: 'high', on: 'scope', what: 'A file outside the paths the scope file allows was changed.' },
  { id: 'denied-path', severity: 'high', on: 'scope', what: 'A file the scope file denies was changed.' },
  { id: 'scope-file-changed', severity: 'high', on: 'scope', what: 'The scope file (.scopeguard) itself was changed, so the change could have widened its own scope.' },
  { id: 'unreadable-binary', severity: 'high', on: 'test or gate', what: 'A binary test or gate file changed, so its content cannot be checked.' },
  { id: 'skip-added', severity: 'high', on: 'test', what: 'A test was marked to be skipped (it.skip, xit, @pytest.mark.skip, t.Skip, @Disabled and the like).' },
  { id: 'only-added', severity: 'high', on: 'test', what: 'A test was focused (it.only, fit, { only: true }), so the rest of the file stops running.' },
  { id: 'assert-commented', severity: 'high', on: 'test', what: 'An assertion was turned into a comment.' },
  { id: 'assert-neutered', severity: 'high', on: 'test', what: 'A real assertion was removed and one that can never fail was added in its place (assert(true), expect(x).toBe(x)).' },
  { id: 'matcher-loosened', severity: 'high', on: 'test', what: 'An exact check on a value was replaced by a looser one on the same value (toEqual to toBeDefined, == to !=, assertEqual to assertTrue).' },
  { id: 'tolerance-widened', severity: 'high', on: 'test', what: 'A numeric tolerance was made looser (more delta, fewer decimal places).' },
  { id: 'test-file-deleted', severity: 'high', on: 'test', what: 'A test file was deleted.' },
  { id: 'test-moved-out', severity: 'high', on: 'test', what: 'A test file was renamed to a path the test runner no longer treats as a test.' },
  { id: 'failure-ignored', severity: 'high', on: 'gate', what: 'A CI or test config was told to ignore failures (continue-on-error, || true, allow_failure, --passWithNoTests).' },
  { id: 'test-run-removed', severity: 'high', on: 'gate', what: 'A command that runs the tests was removed from CI or a build script.' },
  { id: 'test-script-noop', severity: 'high', on: 'gate', what: 'The test script was replaced with one that does nothing.' },
  { id: 'threshold-lowered', severity: 'high', on: 'gate', what: 'A coverage or mutation-score threshold was lowered.' },
  { id: 'check-turned-off', severity: 'high', on: 'gate', what: 'A strictness or failure setting was switched off (strict: true to false, skip: false to true).' },
  { id: 'assert-net-loss', severity: 'review', on: 'test', what: 'A test file lost more assertions than it gained.' },
  { id: 'expected-changed', severity: 'review', on: 'test', what: 'The expected value in an exact check was changed (the test was moved to match the code).' },
  { id: 'assert-always-true', severity: 'review', on: 'test', what: 'An assertion that can never fail was added next to real ones (often a harmless "got here" marker).' },
  { id: 'swallowed-failure', severity: 'review', on: 'test', what: 'An empty catch or except: pass was added to a test, which can hide a failing assertion.' },
  { id: 'snapshot-updated', severity: 'review', on: 'test', what: 'A stored snapshot or golden file was changed or deleted.' },
  { id: 'baseline-grew', severity: 'review', on: 'gate', what: 'A baseline of accepted failures (mutation survivors, known issues) grew.' },
  { id: 'checker-silenced', severity: 'review', on: 'any', what: 'A lint, type or coverage checker was told to ignore a line (eslint-disable, @ts-ignore, # noqa, pragma: no cover).' },
  { id: 'unclaimed-change', severity: 'review', on: 'claim', what: 'The agent\'s own summary never names a file the change touches.' },
  { id: 'claimed-untouched', severity: 'review', on: 'claim', what: 'The agent\'s own summary names a file the change never touches.' },
]);
const SEVERITY = Object.fromEntries(RULES.map((r) => [r.id, r.severity]));

// ─── path classes ─────────────────────────────────────────────────────────────────────────────────────────────────
export const DEFAULT_TESTS = Object.freeze([
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**',
  '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*_spec.rb', '**/conftest.py',
  '**/*Test.java', '**/*Tests.java', '**/*Test.kt', '**/*Tests.cs', '**/*Test.php',
]);
export const DEFAULT_SNAPSHOTS = Object.freeze(['**/__snapshots__/**', '**/*.snap', '**/*.golden', '**/*.approved.*']);
export const DEFAULT_GATES = Object.freeze([
  '.github/workflows/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml', '.travis.yml', 'bitbucket-pipelines.yml',
  '**/Jenkinsfile', '**/package.json', '**/Makefile', '**/tox.ini', '**/pytest.ini', '**/setup.cfg', '**/pyproject.toml',
  '**/noxfile.py', '**/jest.config.*', '**/vitest.config.*', '**/karma.conf.*', '**/.mocharc*', '**/playwright.config.*',
  '**/cypress.config.*', '**/.nycrc*', '**/.c8rc*', '**/codecov.yml', '**/.codecov.yml', '**/.coveragerc',
  '**/stryker.conf.*', '**/witness.bench.json', '**/*baseline*.json', '.pre-commit-config.yaml', '**/phpunit.xml*',
  '**/tsconfig*.json', '**/.eslintrc*', '**/eslint.config.*',
]);

/** a path pattern to a RegExp: `**` any number of folders, `*` within one name, `?` one character; anchored. */
export function globToRegExp(pattern) {
  try {
    if (typeof pattern !== 'string') return null;
    let p = pattern.trim().replace(/^\.?\/+/, '');
    if (p === '') return null;
    if (p.endsWith('/')) p += '**';
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*' && p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        if (slashAfter) { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  } catch { return null; }
}

const compileAll = (list) => list.map(globToRegExp).filter(Boolean);
const DEF_TESTS_RE = compileAll(DEFAULT_TESTS);
const DEF_SNAP_RE = compileAll(DEFAULT_SNAPSHOTS);
const DEF_GATES_RE = compileAll(DEFAULT_GATES);
const anyMatch = (res, path) => res.some((r) => r.test(path));

/** parse a scope file. Lines: `allow <pattern>`, `deny <pattern>`, `tests <pattern>`, `gate <pattern>`; # comments. */
export function parseScope(text) {
  try {
    const out = { ok: true, allow: [], deny: [], tests: [], gates: [] };
    if (text === undefined || text === null || text === '') return out;
    if (typeof text !== 'string') return { ok: false, why: 'the scope must be text' };
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '' || line.startsWith('#')) continue;
      const m = line.match(/^(allow|deny|tests|gate)\s+(\S.*)$/);
      if (!m) return { ok: false, why: 'scope line ' + (i + 1) + ' is not "allow|deny|tests|gate <pattern>": ' + line.slice(0, 80) };
      const key = m[1] === 'gate' ? 'gates' : m[1];
      const pat = m[2].trim();
      if (!globToRegExp(pat)) return { ok: false, why: 'scope line ' + (i + 1) + ' has an unreadable pattern' };
      out[key].push(pat);
    }
    return out;
  } catch { return { ok: false, why: 'the scope could not be read' }; }
}

/** the class and scope state of one path under a parsed scope */
export function classify(path, scope) {
  try {
    const s = scope && scope.ok ? scope : { allow: [], deny: [], tests: [], gates: [] };
    const p = String(path);
    const snapshot = anyMatch(DEF_SNAP_RE, p);
    const test = snapshot || anyMatch(DEF_TESTS_RE, p) || anyMatch(compileAll(s.tests), p);
    const gate = !test && (anyMatch(DEF_GATES_RE, p) || anyMatch(compileAll(s.gates), p));
    const kind = snapshot ? 'snapshot' : test ? 'test' : gate ? 'gate' : 'source';
    let state = 'unscoped';
    if (anyMatch(compileAll(s.deny), p)) state = 'denied';
    else if (s.allow.length > 0) state = anyMatch(compileAll(s.allow), p) ? 'allowed' : 'outside';
    return { kind, scope: state };
  } catch { return { kind: 'source', scope: 'unscoped' }; }
}

// ─── the diff parser ──────────────────────────────────────────────────────────────────────────────────────────────
/** git's C-style quoted path ("a/t\303\251st") to a string; null when malformed */
export function unquotePath(s) {
  try {
    if (typeof s !== 'string') return null;
    if (!s.startsWith('"')) return s;
    const end = s.length - 1;
    if (end < 1 || s[end] !== '"') return null;
    const bytes = [];
    const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    for (let i = 1; i < end; i++) {
      const c = s[i];
      if (c === '"') return null;
      if (c === '\\') {
        const n = s[i + 1];
        if (/^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; continue; }
        if (n in esc && i + 1 !== end) { bytes.push(esc[n]); i += 1; continue; }
        return null;
      }
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch { return null; }
}

function stripPrefix(p, prefixed) {
  if (p === '/dev/null') return null;
  if (prefixed && /^[ab]\//.test(p)) return p.slice(2);
  return p;
}

// the path from a "--- " / "+++ " line: drop a trailing tab and timestamp, unquote
function headerPath(rest) {
  const raw = rest.startsWith('"') ? rest : rest.split('\t')[0].trimEnd();
  return unquotePath(raw);
}

// "diff --git a/X b/Y" when both sides are the same path (the only case with no rename lines)
function gitLinePaths(rest) {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S.*)$/);
    if (!m) return null;
    const a = unquotePath(m[1]); const b = unquotePath(m[2]);
    return a === null || b === null ? null : [a, b];
  }
  // the same path twice: split in the middle (a path may itself contain " b/"); an even length has no middle
  const half = (rest.length - 1) / 2;
  if (rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) return [rest.slice(0, half), rest.slice(half + 1)];
  const k = rest.lastIndexOf(' b/');
  if (k !== -1) return [rest.slice(0, k), rest.slice(k + 1)];
  const parts = rest.split(' ');
  return parts.length === 2 ? parts : null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const COMMIT_RE = /^(?:commit [0-9a-f]{7,64}\b|From [0-9a-f]{7,64} )/;

/**
 * parse a unified diff. Returns { ok: true, files } or { ok: false, why, line } (line is 1-based).
 * file: { oldPath, newPath, path, status, binary, mode, hunks: [{ oldStart, newStart, lines: [{ t, s, old, nu }] }] }
 */
export function parseDiff(text) {
  try {
    if (typeof text !== 'string') return { ok: false, why: 'the diff must be text', line: 0 };
    if (text.length > MAX_CHARS) return { ok: false, why: 'the diff is larger than ' + MAX_CHARS + ' characters', line: 0 };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const gitMode = lines.some((l) => l.startsWith('diff --git '));
    const files = [];
    let f = null;              // the current file
    let state = 'pre';         // pre | header | between | hunk | binary
    let h = null; let remOld = 0; let remNew = 0; let oldNo = 0; let newNo = 0;
    const fail = (why, i) => ({ ok: false, why, line: i + 1 });
    const startFile = (oldPath, newPath, prefixed) => {
      f = { oldPath, newPath, path: newPath ?? oldPath, status: 'modified', binary: false, mode: false, hunks: [], prefixed };
      files.push(f);
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (state === 'hunk') {
        const c = l[0];
        if (c === '\\') continue;
        if (c === ' ' || l === '') { remOld--; remNew--; h.lines.push({ t: ' ', s: l.slice(1), old: oldNo++, nu: newNo++ }); }
        else if (c === '-') { remOld--; h.lines.push({ t: '-', s: l.slice(1), old: oldNo++, nu: null }); }
        else if (c === '+') { remNew--; h.lines.push({ t: '+', s: l.slice(1), old: null, nu: newNo++ }); }
        else return fail('a line inside a hunk does not start with " ", "+" or "-"', i);
        if (remOld < 0 || remNew < 0) return fail('a hunk has more lines than its @@ header says', i);
        if (remOld === 0 && remNew === 0) state = 'between';
        continue;
      }
      if (l.startsWith('diff --cc ') || l.startsWith('diff --combined ')) return fail('a combined merge diff cannot be checked: diff against one parent', i);
      if (gitMode && l.startsWith('diff --git ')) {
        const pair = gitLinePaths(l.slice(11));
        if (!pair) return fail('the diff --git line has no readable paths', i);
        const prefixed = /^"?a\//.test(l.slice(11)) && /\s"?b\//.test(l.slice(11));
        startFile(stripPrefix(pair[0], prefixed), stripPrefix(pair[1], prefixed), prefixed);
        state = 'header';
        continue;
      }
      if (state === 'binary') continue;
      if (state === 'between' && l.startsWith('@@')) { state = 'header'; i--; continue; }
      if (state === 'between' && l.startsWith('\\')) continue;
      if (state === 'pre' || (!gitMode && state === 'between')) {
        if (!gitMode && l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
          const a = headerPath(l.slice(4)); const b = headerPath(lines[i + 1].slice(4));
          if (a === null || b === null) return fail('a --- / +++ path is unreadable', i);
          const prefixed = (a === '/dev/null' || /^a\//.test(a)) && (b === '/dev/null' || /^b\//.test(b));
          startFile(stripPrefix(a, prefixed), stripPrefix(b, prefixed), prefixed);
          if (f.oldPath === null) f.status = 'added';
          if (f.newPath === null) { f.status = 'deleted'; f.path = f.oldPath; }
          i += 1; state = 'header';
          continue;
        }
        if (state === 'between' && /^[+ -]/.test(l) && l !== '-- ') return fail('a diff line sits outside any hunk (the hunk header count is too small)', i);
        if (state === 'between' && l === '-- ') state = 'pre';
        if (state === 'pre' && HUNK_RE.test(l)) return fail('a hunk has no file header (--- / +++ or diff --git) above it', i);
        continue;
      }
      if (state === 'between') {
        if (/^[+ -]/.test(l) && l !== '-- ') return fail('a diff line sits outside any hunk (the hunk header count is too small)', i);
        if (l === '' || COMMIT_RE.test(l) || l === '-- ') { if (l !== '') state = 'pre'; continue; }
        return fail('an unexpected line sits between files: ' + l.slice(0, 60), i);
      }
      // header state: extended header lines, ---/+++, or the first @@
      const m = l.match(HUNK_RE);
      if (m) {
        h = { oldStart: +m[1], newStart: +m[3], lines: [] };
        remOld = m[2] === undefined ? 1 : +m[2];
        remNew = m[4] === undefined ? 1 : +m[4];
        oldNo = +m[1]; newNo = +m[3];
        f.hunks.push(h);
        state = remOld === 0 && remNew === 0 ? 'between' : 'hunk';
        continue;
      }
      if (l.startsWith('--- ')) { const p = headerPath(l.slice(4)); if (p === null) return fail('the --- path is unreadable', i); if (p === '/dev/null') f.status = 'added'; else f.oldPath = stripPrefix(p, f.prefixed); continue; }
      if (l.startsWith('+++ ')) { const p = headerPath(l.slice(4)); if (p === null) return fail('the +++ path is unreadable', i); if (p === '/dev/null') { f.status = 'deleted'; f.path = f.oldPath; } else { f.newPath = stripPrefix(p, f.prefixed); f.path = f.newPath; } continue; }
      if (l.startsWith('new file mode ')) { f.status = 'added'; continue; }
      if (l.startsWith('deleted file mode ')) { f.status = 'deleted'; continue; }
      if (l.startsWith('rename from ') || l.startsWith('copy from ')) { const p = unquotePath(l.slice(l.indexOf('from ') + 5)); if (p === null) return fail('the rename path is unreadable', i); f.oldPath = p; f.status = l[0] === 'r' ? 'renamed' : 'copied'; continue; }
      if (l.startsWith('rename to ') || l.startsWith('copy to ')) { const p = unquotePath(l.slice(l.indexOf('to ') + 3)); if (p === null) return fail('the rename path is unreadable', i); f.newPath = p; f.path = p; continue; }
      if (l.startsWith('old mode ') || l.startsWith('new mode ')) { f.mode = true; continue; }
      if (l.startsWith('Binary files ') || l === 'GIT binary patch') { f.binary = true; state = l === 'GIT binary patch' ? 'binary' : 'header'; continue; }
      if (/^(?:similarity|dissimilarity) index \d+%$/.test(l) || l.startsWith('index ')) continue;
      if (l === '') { state = 'between'; continue; }
      return fail('an unrecognised header line: ' + l.slice(0, 60), i);
    }
    if (state === 'hunk') return { ok: false, why: 'the diff ends inside a hunk (it was cut off)', line: lines.length };
    if (files.length === 0 && text.trim() !== '') return { ok: false, why: 'no file changes were found in this text', line: 0 };
    for (const x of files) {
      if (x.status === 'deleted') x.path = x.oldPath;
      delete x.prefixed;
    }
    return { ok: true, files };
  } catch { return { ok: false, why: 'the diff could not be read', line: 0 }; }
}

// ─── line helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const COMMENT_RE = /^\s*(?:\/\/+|#+(?![[!])|\/\*+|\*+(?!\/)|<!--)/;
export const isComment = (s) => typeof s === 'string' && COMMENT_RE.test(s);
export function uncomment(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^\s*(?:\/\/+|#+|\/\*+|\*+|<!--)\s*/, '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
}
const squash = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const JSISH = /\.(?:[cm]?[jt]sx?|coffee|vue|svelte)$/i;

const ASSERT_RES = [
  /^\s*assert[\s(]/,
  /(?:^|[^\w.$])expect\s*\(/,
  /(?:^|[^\w.$])assert(?:[A-Z_]\w*)?\s*[.(!]/,
  /(?:^|[^\w.$])assert_\w+[\s(!]/,
  /\.assert\.\w+\s*\(/,
  /\bAssert(?:ions)?\.\w+\s*\(/,
  /\bself\.assert\w*\s*\(/,
  /(?:^|[^\w.$])t\.(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|equal|ok|same|match|regex|like|Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/,
  /\brequire\.(?:Equal|NotEqual|EqualValues|NoError|Error|ErrorIs|True|False|Nil|NotNil|Len|Contains|NotContains|Empty|NotEmpty|ElementsMatch|Panics|JSONEq)\s*\(/,
  /\bXCTAssert\w*\s*\(/,
  /\.should\b|\bshould\.\w/,
];
/** a line that makes an assertion (and is not a comment) */
export const isAssertion = (s) => typeof s === 'string' && !isComment(s) && ASSERT_RES.some((r) => r.test(s));

const SKIP_RES = [
  /(?:^|[^\w$])(?:it|test|describe|context|suite|specify)\.skip(?:If)?\b/,
  /(?:^|[^\w$.])x(?:it|test|describe|context|specify)\s*\(/,
  /\bthis\.skip\s*\(\s*\)/,
  /(?:^|[^\w$])skip\s*:\s*(?:true\b|['"`])/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bself\.skipTest\s*\(/,
  /\braise\s+(?:unittest\.)?SkipTest\b/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /#\[ignore\b/,
  /@(?:Ignore|Disabled)\b/,
  /\[(?:Ignore|Skip)\b|\bSkip\s*=\s*"/,
  /\bmarkTest(?:Skipped|Incomplete)\s*\(/,
  /^\s*(?:skip|pending)\b\s*(?:\(|['"]|do\b|$)/,
];
const ONLY_RES = [
  /(?:^|[^\w$])(?:it|test|describe|context|suite|specify)\.only\b/,
  /(?:^|[^\w$])only\s*:\s*true\b/,
];
// Jasmine's focus markers take a test title first; a bare fit(...) is an ordinary function (model fitting) and is not one
const ONLY_JS_RES = [/(?:^|[^\w$.])f(?:it|describe|test|context)\s*\(\s*['"`]/];

const NEUTER_RES = [
  /(?:^|[^\w.$])expect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:not\s*\.\s*)?to\w*\s*\(/,
  /(?:^|[^\w.$])expect\s*\(\s*([\w.$]+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /(?:^|[^\w.$])assert(?:\.ok|True|\.isTrue)?\s*\(\s*(?:true|True|1|!0)\s*\)/,
  /\bself\.assertTrue\s*\(\s*(?:True|1)\s*\)/,
  /\bassert!\s*\(\s*true\s*\)/,
  /^\s*assert\s+(?:True|1)\s*(?:$|#|,)/,
  /^\s*assert\s+([\w.]+)\s*==\s*\1\s*(?:$|#|,)/,
  /(?:^|[^\w.$])(?:assert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)|assertEquals?|assert_eq!|assertSame|self\.assertEqual|Assert\.(?:AreEqual|Equal))\s*\(\s*([^,()]+?)\s*,\s*\1\s*[,)]/,
];

const SWALLOW_RES = [
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/,
  /^\s*except\b[^:]*:\s*pass\b/,
];

const SILENCE_RES = [
  /eslint-disable/, /@ts-(?:ignore|nocheck|expect-error)\b/, /#\s*type:\s*ignore\b/, /#\s*noqa\b/,
  /pragma:\s*no\s*cover/, /\b(?:istanbul|c8|v8)\s+ignore\b/, /\/\/\s*nolint\b/, /#\[allow\(/, /@SuppressWarnings\b/,
  /pylint:\s*disable/, /rubocop:disable/, /\bNOSONAR\b/,
];

const FAILURE_IGNORED_RES = [
  /continue-on-error\s*:\s*true\b/i,
  /allow_failure\s*:\s*true\b/i,
  /\|\|\s*(?:true|:|exit\s+0)(?:\b|\s|$|["'])/,
  /(?:^|[\s;'"])set\s+\+e\b/,
  /--passWithNoTests\b/,
  /--exit-zero\b/,
  /fail_ci_if_error\s*:\s*false\b/,
  /\bignore[_-]?errors\s*[:=]\s*(?:true|True|yes)\b/,
  /(?:^|\s)-k\s+['"]?not\b/,
  /--deselect\b/,
  /(?:^|\s)--ignore(?:-glob)?[=\s]/,
  /^\s*-?\s*if\s*:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/,
  /--testPathIgnorePatterns\b/,
];
// the commands that run tests, by kind: a removal is flagged only when its kind no longer appears in the hunk
const RUNNERS = [
  ['npm-test', /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/], ['node-test', /\bnode\s+(?:--\S+\s+)*--test\b/],
  ['pytest', /\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/], ['go-test', /\bgo\s+test\b/], ['cargo-test', /\bcargo\s+(?:test|nextest)\b/],
  ['jest', /\bjest\b/], ['vitest', /\bvitest\b/], ['mocha', /\bmocha\b/], ['maven', /\bmvnw?\b.*\b(?:test|verify)\b/],
  ['gradle', /\bgradlew?\b.*\b(?:test|check)\b/], ['dotnet-test', /\bdotnet\s+test\b/], ['phpunit', /\bphpunit\b/], ['rspec', /\brspec\b/],
  ['tox', /\btox\b/], ['make-test', /\bmake\s+(?:test|check)\b/], ['playwright', /\bplaywright\s+test\b/], ['ctest', /\bctest\b/],
  ['witness', /\/witness@|\bwitness(?:-bench)?\.mjs\b/],
];
const runnerKinds = (s) => RUNNERS.filter(([, re]) => re.test(s)).map(([k]) => k);
// the files a test command names: test files (a.test.mjs, a_spec.rb, test_a.py) and the file a mutation gate mutates.
// Other files on the line (a script, the runner's own code) are not targets. A name built from a variable ($k) is not one.
const TEST_FILE_RE = /(?:^|[^\w.$/-])(?:[\w.-]*\/)*((?:[\w-][\w.-]*?[._](?:test|spec)|test_[\w.-]+)\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt))\b/g;
const SOURCE_FILE_RE = /[\w*]\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt)\b/;
const MUTATE_RE = /\bmutate\s+["']?(?:[\w.-]*\/)*([\w-]+\.[cm]?[jt]sx?)\b/g;
export const targetsOf = (s) => (typeof s === 'string' ? [...new Set([...s.matchAll(TEST_FILE_RE), ...s.matchAll(MUTATE_RE)].map((m) => m[1]))] : []);
// a file pattern a test command runs (kards/*.test.mjs, test/**/*.spec.ts): its own target, kept only by the same
// pattern or by a command that names nothing at all and so finds everything
const GLOB_RE = /(?:^|[\s"'=])((?:[\w.-]*\/)*(?:\*\*\/)?[\w.-]*\*[\w.*-]*\.(?:[cm]?[jt]sx?|py|go|rb|rs))(?=$|[\s"',;)])/g;
export const globsOf = (s) => (typeof s === 'string' ? [...new Set([...s.matchAll(GLOB_RE)].map((m) => m[1]))] : []);
/** a target's stem, the name a shell loop would list: socket.test.mjs, socket.mjs and socket_spec.rb are all "socket" */
export const stemOf = (file) => (typeof file === 'string' ? file.split(/[._](?:test|spec)\.|\./)[0] : '');
const LOOP_RE = /\bfor\s+\w+\s+in\s/;
export const hasWord = (s, w) => typeof s === 'string' && typeof w === 'string' && new RegExp('(?:^|[^\\w-])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^\\w-]|$)').test(s);
// what a "|| true" line saves its output to (tee FILE, > FILE, VAR=$( ... )), so a later check on it can be seen
function captureTargets(s) {
  const out = [];
  for (const m of s.matchAll(/\btee\s+(?:-a\s+)?["']?([^\s"'|;&)]+)/g)) out.push(m[1]);
  for (const m of s.matchAll(/(?:^|[^<>&\d])>{1,2}\s*["']?([^\s"'|;&)]+)/g)) if (!/^&?\d$|^\/dev\/null$/.test(m[1])) out.push(m[1]);
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)=\$\(/g)) out.push('$' + m[1]);
  return out;
}
const mentions = (s, target) => (target.startsWith('$') ? new RegExp('\\$\\{?' + target.slice(1) + '\\b').test(s) : s.includes(target));
const DEPENDENCY_RE = /^\s*"[@\w./-]+"\s*:\s*"(?:[\^~>=<*\d]|latest"|next"|workspace:|npm:|file:|link:|git\+|github:)|^\s*["']?(?:pytest|tox|coverage|jest|vitest|mocha)[\w.-]*\s*(?:[<>=!~]=?|\[|["']\s*,?\s*$)/;
const NOOP_TEST_RE = /"test"\s*:\s*"\s*(?:echo(?:\s+[^"\\]*)?|exit\s+0|true|:)?\s*"\s*,?\s*$/;
const THRESHOLD_KEY_RE = /(?:coverage|threshold|fail[_-]?under|cov-fail-under|branches|lines|functions|statements|minimum|min[_-]?coverage|mutation|score|\bbreak\b)/i;
const ON_KEY_RE = /strict|fail(?![_-]?fast)|check|verify|enforce|require|lint|noImplicit|noUnused|noFallthrough|error/i;
const OFF_KEY_RE = /skip|ignore/i;

// a number token, not part of a word
const NUM_RE = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w.])/g;
const shapeOf = (s) => squash(s).replace(NUM_RE, '#');
const numsOf = (s) => (squash(s).match(NUM_RE) || []).map(Number);

// tolerance keywords: the first number after the match end is the tolerance. smaller=true: fewer is looser.
const TOL_KEYS = [
  { re: /\bplaces\s*=\s*/, smaller: true },
  { re: /toBeCloseTo\s*\([^,()]*(?:\([^()]*\)[^,()]*)*,\s*/, smaller: true },
  { re: /\b(?:digits|precision|decimal)\s*[=:]\s*/i, smaller: true },
  { re: /\b(?:delta|rtol|atol|abs_tol|rel_tol|rel|abs|epsilon|eps|tolerance|tol|margin)\s*[=:]\s*/i, smaller: false },
  { re: /\bcloseTo\s*\([^,()]*,\s*/, smaller: false },
  { re: /\bInDelta\s*\((?:[^,()]*,\s*){3}/, smaller: false },
];

// The three scanners below walk the string's UTF-16 units; a backslash inside quotes skips the unit after it.

/** index of the bracket that closes the one at index `open` (an integer), honouring quotes; -1 if none */
export function closeParen(s, open) {
  if (typeof s !== 'string' || !(open >= 0)) return -1;
  let depth = 0; let q = null; let skip = false;
  for (const [k, c] of s.slice(open).split('').entries()) {
    if (skip) { skip = false; continue; }
    if (q) { if (c === '\\') skip = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return open + k; }
  }
  return -1;
}
/** split a call's argument text on top-level commas */
export function splitArgs(s) {
  if (typeof s !== 'string') return [];
  const out = []; let depth = 0; let q = null; let cur = ''; let skip = false;
  for (const c of s.split('')) {
    if (skip) { skip = false; cur += c; continue; }
    if (q) { cur += c; if (c === '\\') skip = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
/** cut a trailing "# comment" that sits outside quotes */
export function cutHashComment(s) {
  if (typeof s !== 'string') return '';
  let q = null; let skip = false;
  for (const [k, c] of s.split('').entries()) {
    if (skip) { skip = false; continue; }
    if (q) { if (c === '\\') skip = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') return s.slice(0, k);
  }
  return s;
}
const LITERAL_RE = /^(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|true|false|True|False|None|null|nil|undefined|'[^']*'|"[^"]*"|`[^`]*`)$/;
const subjectsOf = (args) => args.map(squash).filter((a) => a !== '' && a !== 't' && !LITERAL_RE.test(a));

const STRICT_JS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toHaveLength', 'toContain', 'toContainEqual', 'toMatch', 'toBeCloseTo', 'toHaveBeenCalledWith', 'toHaveBeenCalledTimes', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toBeNull', 'toBeUndefined', 'toBeNaN', 'toMatchInlineSnapshot', 'toHaveReturnedWith', 'eq', 'eql', 'equal', 'equals', 'deep']);
const LOOSE_JS = new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeInstanceOf', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toHaveBeenCalled', 'toBeTypeOf', 'ok', 'exist', 'be_truthy', 'be_falsey', 'be_present', 'be_a', 'be_an', 'be_kind_of', 'be_instance_of', 'above', 'below', 'least', 'most', 'a', 'an', 'instanceOf']);
// chai property assertions (no call): expect(x).to.be.ok
const PROP_JS = { ok: 'loose', exist: 'loose', true: 'strict', false: 'strict', null: 'strict', undefined: 'strict', empty: 'strict', NaN: 'strict' };
const STRICT_CALL = new Set(['equal', 'equals', 'strictequal', 'deepequal', 'deepstrictequal', 'equalvalues', 'exactly', 'same', 'is', 'identical', 'areequal', 'aresame', 'dictequal', 'listequal', 'setequal', 'tupleequal', 'countequal', 'sequenceequal', 'multilineequal', 'almostequal', 'isnone', 'null', 'isnull', 'nil', 'len', 'lengthof', 'contains', 'in', 'regex', 'match', 'matches', 'raises', 'raisesregex', 'throws', 'rejects', 'equalerror', 'erroris', 'errorcontains', 'jsoneq', 'elementsmatch', 'deepequals', 'arrayequals', 'eq']);
const LOOSE_CALL = new Set(['', 'ok', 'true', 'istrue', 'truthy', 'false', 'isfalse', 'falsy', 'notnull', 'isnotnull', 'isnotnone', 'notnone', 'notnil', 'notempty', 'isinstance', 'instanceof', 'isinstanceof', 'greater', 'greaterorequal', 'greaterequal', 'less', 'lessorequal', 'lessequal', 'notequal', 'notequals', 'notstrictequal', 'notdeepequal', 'notdeepstrictequal', 'notsame', 'error', 'notzero', 'positive', 'exists', 'isdefined', 'defined', 'ne']);

/**
 * the shape of an assertion line: { strength: 'strict'|'loose', matcher, args, subjects }, or null.
 * subjects are the non-literal arguments, so a loosened check pairs with a strict one whatever the argument order.
 */
export function assertionShape(line) {
  try {
    const s = String(line);
    if (isComment(s)) return null;
    // JS / RSpec style: expect(subject)[.not|.resolves|.rejects].matcher(args)
    const ei = s.search(/(?:^|[^\w.$])expect\s*\(/);
    if (ei >= 0) {
      const open = s.indexOf('(', ei);
      const close = closeParen(s, open);
      if (close === -1) return null;
      const subject = squash(s.slice(open + 1, close));
      const rest = s.slice(close + 1);
      const pm = rest.match(/^\s*((?:\.\s*(?:not|to|be|been|is|that|and|have|deep)\s*)*)\.\s*(ok|exist|true|false|null|undefined|empty|NaN)\b\s*(?![\s(])/);
      if (pm) {
        const neg = /\bnot\b/.test(pm[1]);
        return { strength: neg ? 'loose' : PROP_JS[pm[2]], matcher: (neg ? 'not.' : '') + pm[2], args: [], subjects: subjectsOf([subject]) };
      }
      const m = rest.match(/^\s*((?:\.\s*(?:not|resolves|rejects|to|be|deep|that|is|been|have|and)\s*)*)\.\s*(\w+)\s*\(/) || rest.match(/^\s*\.\s*(not_to|to_not|to)\b\s*\(?\s*(\w+)/);
      if (!m) return null;
      const negated = /\bnot\b|not_to|to_not/.test(m[1]);
      const matcher = m[2];
      // the matcher's own arguments, when it is a call that closes on this line
      const ao = close + m[0].length;
      const ac = rest[m[0].length - 1] === '(' ? closeParen(s, ao) : -1;
      const argText = ac === -1 ? '' : s.slice(ao + 1, ac);
      const args = splitArgs(argText);
      let strength = null;
      if (negated) strength = 'loose';
      else if (STRICT_JS.has(matcher) || ((matcher === 'toThrow' || matcher === 'toThrowError' || matcher === 'toHaveProperty') && args.length >= (matcher === 'toHaveProperty' ? 2 : 1))) strength = 'strict';
      else if (LOOSE_JS.has(matcher) || matcher === 'toThrow' || matcher === 'toThrowError' || matcher === 'toHaveProperty') strength = 'loose';
      if (!strength) return null;
      // toBe(true) / toEqual(false) is a truth check, the same strength as toBeTruthy()
      if (strength === 'strict' && args.length === 1 && /^(?:true|false)$/.test(squash(args[0]))) strength = 'loose';
      return { strength, matcher: (negated ? 'not.' : '') + matcher, args: args.map(squash), subjects: subjectsOf([subject]) };
    }
    // Python bare assert: the expression is the first top-level argument (a message may follow), comments cut
    const pa = s.match(/^\s*assert\s+(\S.*)$/);
    if (pa && !/^\s*assert\s*\(/.test(s)) {
      const e = squash(splitArgs(cutHashComment(pa[1]))[0] || '');
      if (e === '') return null;
      const ops = [[/\s+is\s+not\s+/, 'loose', 'is not'], [/\s+not\s+in\s+/, 'loose', 'not in'], [/\s*!=\s*/, 'loose', '!='], [/\s*>=\s*/, 'loose', '>='], [/\s*<=\s*/, 'loose', '<='], [/\s*==\s*/, 'strict', '=='], [/\s+is\s+/, 'strict', 'is'], [/\s+in\s+/, 'strict', 'in'], [/\s*>\s*/, 'loose', '>'], [/\s*<\s*/, 'loose', '<']];
      for (const [re, strength, op] of ops) {
        const k = e.search(re);
        if (k > 0) { const mm = e.slice(k).match(re); const args = [e.slice(0, k), e.slice(k + mm[0].length)]; return { strength, matcher: op, args: args.map(squash), subjects: subjectsOf(args) }; }
      }
      return { strength: 'loose', matcher: 'assert', args: [squash(e)], subjects: subjectsOf([e]) };
    }
    // call style: assert(x), assert.equal(a, b), self.assertEqual(a, b), assertEquals(a, b), Assert.AreEqual, t.is, require.Equal
    // the first call on the line whose receiver and name make it an assertion
    const valid = (prefix, name) => (prefix === 't.' ? /^(?:is|not|deepEqual|true|false|truthy|falsy|equal|ok|same)$/.test(name)
      : prefix === '' || prefix === 'self.' || prefix === 'this.' || prefix === '$this->' ? /^assert/.test(name) : true);
    const cm = [...s.matchAll(/(?:^|[^\w$])((?:self\.|this\.|\$this->|t\.assert\.|Assert(?:ions)?\.|assert\.|require\.|t\.)?)([A-Za-z]\w*)\s*!?\s*\(/g)].find((m) => valid(m[1], m[2]));
    if (cm) {
      const prefix = cm[1];
      let name = cm[2];
      const open = s.indexOf('(', cm.index + cm[0].length - 1);
      const close = closeParen(s, open);
      if (close === -1) return null;
      const args = splitArgs(s.slice(open + 1, close));
      name = name.replace(/^assert_?/i, '').replace(/_/g, '').toLowerCase();
      if (prefix === 't.' && name === 'not') name = 'notequal';
      let strength = null;
      if (STRICT_CALL.has(name)) strength = 'strict';
      else if (LOOSE_CALL.has(name)) strength = 'loose';
      if (!strength) return null;
      if ((name === 'throws' || name === 'rejects') && args.length < 2) strength = 'loose';
      // equal(x, true) is a truth check, the same strength as ok(x)
      if (strength === 'strict' && args.some((a) => /^(?:true|false|True|False)$/.test(squash(a)))) strength = 'loose';
      return { strength, matcher: name, args: args.map(squash), subjects: subjectsOf(args) };
    }
    return null;
  } catch { return null; }
}

// a multiset difference on squashed text: the items of `a` not cancelled by an equal item of `b`
function unmatched(a, b, key = (x) => squash(x.s)) {
  const pool = new Map();
  for (const x of b) { const k = key(x); pool.set(k, (pool.get(k) || 0) + 1); }
  const out = [];
  for (const x of a) { const k = key(x); const n = pool.get(k) || 0; if (n > 0) pool.set(k, n - 1); else out.push(x); }
  return out;
}

const clip = (s) => { const t = squash(s); return t.length > 200 ? t.slice(0, 199) + '…' : t; };

/** pair each removed line with an added line of the same shape (numbers masked), within one hunk */
function pairsByShape(hunk, mask) {
  const rem = hunk.lines.filter((x) => x.t === '-');
  const add = hunk.lines.filter((x) => x.t === '+');
  const used = new Set();
  const out = [];
  for (const r of rem) {
    const k = mask(r.s);
    const j = add.findIndex((a, idx) => !used.has(idx) && mask(a.s) === k && squash(a.s) !== squash(r.s));
    if (j >= 0) { used.add(j); out.push([r, add[j]]); }
  }
  return out;
}

function tolerance(s) {
  const t = squash(s);
  for (const k of TOL_KEYS) {
    const m = t.match(k.re);
    if (!m) continue;
    const after = t.slice(m.index + m[0].length).match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
    if (after) return { value: Number(after[0]), smaller: k.smaller };
  }
  return null;
}

// two lines of the same shape (so both or neither carry a tolerance) whose only differing number is the tolerance
function tolOnlyChange(a, b) {
  const tr = tolerance(a);
  if (!tr) return false;
  const nb = numsOf(b);
  return numsOf(a).filter((v, k) => v !== nb[k]).length === 1 && tolerance(b).value !== tr.value;
}

// ─── the audit ────────────────────────────────────────────────────────────────────────────────────────────────────
function rulesForFile(f, cls, push) {
  const added = []; const removed = [];
  for (const h of f.hunks) for (const x of h.lines) { if (x.t === '+') added.push(x); else if (x.t === '-') removed.push(x); }
  const isTest = cls.kind === 'test';
  const isGate = cls.kind === 'gate';

  if (f.binary && (isTest || isGate || cls.kind === 'snapshot')) push('unreadable-binary', null, 'file', '(binary content)');

  if (cls.kind === 'snapshot') {
    if (f.status !== 'added') push('snapshot-updated', null, 'file', f.status + ' snapshot');
    return;
  }

  // checker-silenced: any file
  for (const x of unmatched(added.filter((x) => SILENCE_RES.some((r) => r.test(x.s))), removed.filter((x) => SILENCE_RES.some((r) => r.test(x.s))))) push('checker-silenced', x.nu, '+', x.s);

  if (isTest) {
    if (f.status === 'deleted') { push('test-file-deleted', null, 'file', removed.filter((x) => isAssertion(x.s)).length + ' assertion lines removed'); return; }
    const js = JSISH.test(f.path || '');
    const marks = (res) => (x) => !isComment(x.s) && res.some((r) => r.test(x.s));
    for (const x of unmatched(added.filter(marks(SKIP_RES)), removed.filter(marks(SKIP_RES)))) push('skip-added', x.nu, '+', x.s);
    const onlyRes = js ? ONLY_RES.concat(ONLY_JS_RES) : ONLY_RES;
    for (const x of unmatched(added.filter(marks(onlyRes)), removed.filter(marks(onlyRes)))) push('only-added', x.nu, '+', x.s);
    // assert-commented: an added comment whose text is a removed assertion
    const removedAsserts = removed.filter((x) => isAssertion(x.s));
    const remText = new Map();
    for (const x of removedAsserts) { const k = squash(x.s); remText.set(k, (remText.get(k) || 0) + 1); }
    let commented = 0;
    for (const x of added) {
      if (!isComment(x.s)) continue;
      const k = squash(uncomment(x.s));
      const n = remText.get(k) || 0;
      if (n > 0) { remText.set(k, n - 1); commented++; push('assert-commented', x.nu, '+', x.s); }
    }
    // an always-true assertion is high when its own hunk lost a real assertion (it replaced one), else review.
    // v1.1: judged per hunk; v1 judged the whole file, so an identical line elsewhere could hide the replacement.
    const isTaut = (x) => !isComment(x.s) && NEUTER_RES.some((r) => r.test(x.s));
    for (const h of f.hunks) {
      const hAdd = h.lines.filter((x) => x.t === '+'); const hRem = h.lines.filter((x) => x.t === '-');
      const realLost = unmatched(hRem.filter((x) => isAssertion(x.s) && !isTaut(x)), hAdd).length > 0;
      for (const x of unmatched(hAdd.filter(isTaut), hRem)) push(realLost ? 'assert-neutered' : 'assert-always-true', x.nu, '+', x.s);
    }
    for (const x of unmatched(added.filter((x) => !isComment(x.s) && SWALLOW_RES.some((r) => r.test(x.s))), removed)) push('swallowed-failure', x.nu, '+', x.s);

    // matcher-loosened and expected-changed: pair by subject across the file
    const remShapes = unmatched(removed, added).map((x) => ({ x, sh: assertionShape(x.s) })).filter((o) => o.sh);
    const addShapes = unmatched(added, removed).map((x) => ({ x, sh: assertionShape(x.s) })).filter((o) => o.sh);
    const overlap = (a, b) => a.sh.subjects.some((s) => b.sh.subjects.includes(s));
    // v1.1: the exact check counts as still there only when the SAME check (same value, same expected arguments) was
    // added back; v1 counted any exact check on the same value, so a generic value (r.why) hid a loosened check.
    const usedAdd = new Set();
    const argsOf = (o) => o.sh.args.join('\u0000');
    for (const r of remShapes) {
      if (r.sh.strength !== 'strict') continue;
      if (addShapes.some((a) => a.sh.strength === 'strict' && argsOf(a) === argsOf(r) && overlap(a, r))) continue;
      const loose = addShapes.find((a) => a.sh.strength === 'loose' && overlap(a, r) && !usedAdd.has(a));
      if (loose) { usedAdd.add(loose); push('matcher-loosened', loose.x.nu, '+', r.x.s.trim() + '  →  ' + loose.x.s.trim()); continue; }
      const same = addShapes.find((a) => a.sh.strength === 'strict' && a.sh.matcher === r.sh.matcher && overlap(a, r) && !usedAdd.has(a));
      // a change only in a tolerance number belongs to tolerance-widened (or is a tightening), not to this rule
      if (same && !(shapeOf(same.x.s) === shapeOf(r.x.s) && tolOnlyChange(r.x.s, same.x.s))) {
        usedAdd.add(same);
        push('expected-changed', same.x.nu, '+', r.x.s.trim() + '  →  ' + same.x.s.trim());
      }
    }
    // tolerance-widened: same line shape, the tolerance number moved the loose way
    for (const h of f.hunks) {
      for (const [r, a] of pairsByShape(h, shapeOf)) {
        // same shape, so the same tolerance keyword is on both lines, or on neither
        const tr = tolerance(r.s);
        if (!tr) continue;
        const ta = tolerance(a.s);
        if (tr.smaller ? ta.value < tr.value : ta.value > tr.value) push('tolerance-widened', a.nu, '+', r.s.trim() + '  →  ' + a.s.trim());
      }
    }
    // assert-net-loss
    if (f.status !== 'added') {
      // assertions already reported as commented out are not counted again
      const lost = removed.filter((x) => isAssertion(x.s)).length - added.filter((x) => isAssertion(x.s)).length - commented;
      if (lost > 0) push('assert-net-loss', null, 'file', lost + ' fewer assertion lines');
    }
  }

  if (isGate) {
    const isBaseline = /baseline/i.test((f.path || '').split('/').pop());
    const fi = (x) => !isComment(x.s) && FAILURE_IGNORED_RES.some((r) => r.test(x.s));
    for (const h of f.hunks) {
      const hAdd = h.lines.filter((x) => x.t === '+');
      const hRem = h.lines.filter((x) => x.t === '-');
      for (const x of unmatched(hAdd.filter(fi), hRem.filter(fi))) {
        if (isBaseline) continue;
        // capture then check: the output is saved and a later part of this line, or a later line, reads it
        const targets = captureTargets(x.s);
        const cut = x.s.search(/\|\|\s*(?:true|:|exit\s+0)/);
        const tail = (cut === -1 ? '' : x.s.slice(cut)).replace(/\btee\s+(?:-a\s+)?\S+/g, '').replace(/>{1,2}\s*\S+/g, '');
        const later = h.lines.slice(h.lines.indexOf(x) + 1).filter((y) => y.t !== '-').map((y) => y.s);
        if (targets.some((t) => mentions(tail, t) || later.some((y) => mentions(y, t)))) continue;
        push('failure-ignored', x.nu, '+', x.s);
      }
    }
    // a removed command line is a finding when its runner kind no longer appears in the hunk, or (v1.1) when any file
    // it ran is no longer named by a test command or a shell loop left in the hunk. v1 checked the kind only, so
    // dropping one gated file from a list of gated files went unseen.
    const runner = (x) => !DEPENDENCY_RE.test(x.s) && !isComment(x.s);
    for (const h of f.hunks) {
      const left = h.lines.filter((x) => x.t !== '-' && !isComment(x.s)).map((x) => x.s);
      const kept = new Set(left.flatMap(runnerKinds));
      const loops = left.filter((s) => LOOP_RE.test(s));
      for (const x of unmatched(h.lines.filter((y) => y.t === '-' && runner(y)), h.lines.filter((y) => y.t === '+' && runner(y)))) {
        const kinds = runnerKinds(x.s);
        if (kinds.length === 0) continue;
        const same = left.filter((s) => runnerKinds(s).some((k) => kinds.includes(k)));
        const noVar = (s) => !/\$\w/.test(s);
        // a bare command of the same kind (npm test, node --test, pytest -q: no file named at all) finds everything;
        // one that names only patterns (node --test *.test.mjs) still runs every named file this line ran
        const bare = same.some((s) => !SOURCE_FILE_RE.test(s) && noVar(s));
        const sweeps = bare || same.some((s) => targetsOf(s).length === 0 && globsOf(s).length > 0 && noVar(s));
        const goneFile = !sweeps && targetsOf(x.s).some((t) => !same.some((s) => hasWord(s, t)) && !loops.some((s) => hasWord(s, stemOf(t))));
        const goneGlob = !bare && globsOf(x.s).some((g) => !same.some((s) => globsOf(s).includes(g)));
        if (goneFile || goneGlob || kinds.some((kd) => !kept.has(kd))) push('test-run-removed', x.old, '-', x.s);
      }
    }
    if (/(?:^|\/)package\.json$/.test(f.path || '')) for (const x of unmatched(added.filter((x) => NOOP_TEST_RE.test(x.s)), removed)) push('test-script-noop', x.nu, '+', x.s);
    for (const h of f.hunks) {
      for (const [r, a] of pairsByShape(h, shapeOf)) {
        if (!THRESHOLD_KEY_RE.test(r.s) || /max/i.test(r.s)) continue;
        const nr = numsOf(r.s); const na = numsOf(a.s);
        if (nr.some((v, k) => na[k] < v)) push('threshold-lowered', a.nu, '+', r.s.trim() + '  →  ' + a.s.trim());
      }
      // every true/false on the line is compared by position, each with the words before it (since the last one) as its
      // key; a line pair has the same shape, so a changed value went from one to the other
      const BOOL = /\b(?:true|false|True|False)\b/g;
      const boolMask = (s) => squash(s).replace(BOOL, '#B');
      const bools = (s) => [...squash(s).matchAll(BOOL)].map((m) => ({ v: m[0].toLowerCase(), at: m.index }));
      for (const [r, a] of pairsByShape(h, boolMask)) {
        const t = squash(r.s); const br = bools(r.s); const ba = bools(a.s);
        const off = br.some((b, k) => {
          if (b.v === ba[k].v) return false;
          const key = t.slice(k === 0 ? 0 : br[k - 1].at, b.at);
          if (/continue-on-error|allow_failure|fail_ci_if_error/i.test(key)) return false;
          return OFF_KEY_RE.test(key) ? b.v === 'false' : ON_KEY_RE.test(key) && b.v === 'true';
        });
        if (off) push('check-turned-off', a.nu, '+', r.s.trim() + '  →  ' + a.s.trim());
      }
    }
    if (isBaseline && added.length > removed.length) push('baseline-grew', null, 'file', (added.length - removed.length) + ' more lines');
  }
}

/**
 * the files and folders a summary text names: a bare token ending in a known file extension, a bare token ending in
 * "/" (a folder), or anything path-like inside `backticks`. Prose such as "and/or" is not a path.
 */
export const FILE_EXT = 'js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|py|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|css|scss|html|txt|toml|ini|cfg|sh|lock|xml|sql|swift|vue|svelte|gradle|env|snap';
const EXT_END = new RegExp('\\.(?:' + FILE_EXT + ')$');
export function claimedPaths(text) {
  try {
    if (typeof text !== 'string') return [];
    const out = new Set();
    const tidy = (t) => t.replace(/^\.\//, '').replace(/[.,;:)]+$/, '');
    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const t = tidy(m[1]);
      if ((t.includes('/') || EXT_END.test(t)) && !/:\/\//.test(t)) out.add(t);
    }
    const bare = new RegExp('(?:^|[\\s(\\[\'"])((?:[\\w@~.-]+\\/)*[\\w@~-][\\w@~.-]*\\.(?:' + FILE_EXT + ')|(?:[\\w@~.-]+\\/)+)(?=$|[\\s,;:)\\]\'"]|\\.(?:\\s|$))', 'g');
    for (const m of text.matchAll(bare)) {
      const t = tidy(m[1]);
      if (t !== '' && !/^(?:https?|www)\b/.test(t)) out.add(t);
    }
    return [...out];
  } catch { return []; }
}
const namesPath = (token, path) => token === path || (!token.includes('/') && path.split('/').pop() === token) || path.endsWith('/' + token)
  || (token.endsWith('/') && (path.startsWith(token) || path.includes('/' + token)));

/**
 * the whole check. diff: unified diff text. scopeText: optional scope file text. claimText: optional summary the
 * agent wrote of its own change. Returns { ok: true, v, verdict, counts, files, findings } or { ok: false, why, line }.
 */
export function audit(diffText, scopeText, claimText) {
  try {
    const parsed = parseDiff(diffText);
    if (!parsed.ok) return { ok: false, why: parsed.why, line: parsed.line };
    const scope = parseScope(scopeText);
    if (!scope.ok) return { ok: false, why: scope.why, line: 0 };
    const findings = [];
    const files = [];
    for (const f of parsed.files) {
      const cls = classify(f.path, scope);
      const oldCls = f.oldPath && f.oldPath !== f.path ? classify(f.oldPath, scope) : null;
      let added = 0; let removed = 0;
      for (const h of f.hunks) for (const x of h.lines) { if (x.t === '+') added++; else if (x.t === '-') removed++; }
      files.push({ path: f.path, oldPath: f.oldPath !== f.path ? f.oldPath : null, status: f.status, kind: cls.kind, scope: cls.scope, binary: f.binary, added, removed });
      const push = (rule, line, side, text) => findings.push({ rule, severity: SEVERITY[rule], path: f.path, line, side, text: clip(text) });
      for (const c of [cls, oldCls].filter(Boolean)) {
        if (c.scope === 'denied') push('denied-path', null, 'file', c === cls ? f.path : 'renamed from ' + f.oldPath);
        else if (c.scope === 'outside') push('outside-scope', null, 'file', c === cls ? f.path : 'renamed from ' + f.oldPath);
      }
      if (f.path === SCOPE_FILE || f.oldPath === SCOPE_FILE) push('scope-file-changed', null, 'file', f.status + ' ' + SCOPE_FILE);
      if (oldCls && (oldCls.kind === 'test') && cls.kind !== 'test' && cls.kind !== 'snapshot' && f.status === 'renamed') push('test-moved-out', null, 'file', f.oldPath + ' → ' + f.path);
      rulesForFile(f, cls, push);
    }
    if (typeof claimText === 'string' && claimText.trim() !== '') {
      const tokens = claimedPaths(claimText);
      const touched = parsed.files.flatMap((f) => [f.path, f.oldPath]).filter((p) => typeof p === 'string');
      for (const fl of files) {
        if (!tokens.some((t) => namesPath(t, fl.path) || (fl.oldPath && namesPath(t, fl.oldPath)))) findings.push({ rule: 'unclaimed-change', severity: 'review', path: fl.path, line: null, side: 'file', text: 'not named in the summary' });
      }
      for (const t of tokens) {
        if (!touched.some((p) => namesPath(t, p))) findings.push({ rule: 'claimed-untouched', severity: 'review', path: t, line: null, side: 'claim', text: 'named in the summary, not in the change' });
      }
    }
    // one line, one finding: a review finding on a line a high finding already names is dropped
    const highAt = new Set(findings.filter((x) => x.severity === 'high' && x.line !== null).map((x) => x.path + '\u0000' + x.side + '\u0000' + x.line));
    for (let k = findings.length - 1; k >= 0; k--) {
      const x = findings[k];
      if (x.severity === 'review' && x.line !== null && highAt.has(x.path + '\u0000' + x.side + '\u0000' + x.line)) findings.splice(k, 1);
    }
    const order = new Map(RULES.map((r, i) => [r.id, i]));
    findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) || order.get(a.rule) - order.get(b.rule));
    const high = findings.filter((x) => x.severity === 'high').length;
    const review = findings.length - high;
    return {
      ok: true,
      v: VERSION,
      verdict: high > 0 ? 'flagged' : review > 0 ? 'review' : 'clean',
      counts: { files: files.length, high, review, added: files.reduce((s, x) => s + x.added, 0), removed: files.reduce((s, x) => s + x.removed, 0) },
      files,
      findings,
    };
  } catch { return { ok: false, why: 'the check could not run on this input', line: 0 }; }
}

/** the exact strings the two SHA-256 fingerprints are taken over (the page and the command line hash these) */
export function fingerprintInput(diffText, scopeText, claimText) {
  try {
    const t = (x) => (typeof x === 'string' ? x.replace(/\r\n/g, '\n') : '');
    return JSON.stringify({ diff: t(diffText), scope: t(scopeText), claim: t(claimText) });
  } catch { return ''; }
}
export function fingerprintResult(result) {
  try {
    if (!result || result.ok !== true) return JSON.stringify({ ok: false, why: result && result.why ? String(result.why) : '' });
    return JSON.stringify({ v: result.v, verdict: result.verdict, files: result.files, findings: result.findings });
  } catch { return ''; }
}

/** the exit code the command line uses: 0 clean, 2 flagged (and review too when failOn is 'review'), 1 unreadable */
export function exitCode(result, failOn = 'high') {
  try {
    if (!result || result.ok !== true) return 1;
    if (result.verdict === 'flagged') return 2;
    if (result.verdict === 'review' && failOn === 'review') return 2;
    return 0;
  } catch { return 1; }
}

export default { VERSION, SCOPE_FILE, RULES, targetsOf, globsOf, stemOf, hasWord, DEFAULT_TESTS, DEFAULT_GATES, DEFAULT_SNAPSHOTS, globToRegExp, parseScope, classify, unquotePath, parseDiff, isComment, uncomment, isAssertion, assertionShape, closeParen, splitArgs, claimedPaths, audit, fingerprintInput, fingerprintResult, exitCode };
