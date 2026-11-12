#!/usr/bin/env node
// cli.mjs — ScopeGuard on the command line, in CI, and as a Claude Code Stop hook.
//
//   node cli.mjs change.diff [--scope .scopeguard] [--claim summary.txt] [--fail-on high|review] [--json]
//   git diff main...HEAD | node cli.mjs -          (read the diff from standard input)
//   node cli.mjs --git [REF]                        (this folder's changes against REF, default HEAD, new files included)
//   node cli.mjs --git --staged                     (what is staged: a pre-commit hook)
//   node cli.mjs --hook                             (Claude Code Stop hook; reads the hook's JSON on standard input)
//
// Exit codes: 0 clean (and review, unless --fail-on review), 2 flagged, 1 the input could not be read or bad usage.
// In --hook mode: 2 stops the agent from finishing and tells it why (once per set of findings), else 0.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, exitCode, fingerprintInput, fingerprintResult } from './kernel.mjs';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const USAGE = 'usage: node cli.mjs <diff-file|-> [--scope FILE] [--claim FILE] [--fail-on high|review] [--json]\n'
  + '       node cli.mjs --git [REF] [--staged] [--scope FILE] [--claim FILE] [--fail-on high|review] [--json]\n'
  + '       node cli.mjs --hook';

/** read the command line into options; { error } when it is wrong */
export function parseArgs(argv) {
  const o = { input: null, git: false, ref: 'HEAD', staged: false, hook: false, scope: null, claim: null, failOn: 'high', json: false };
  const a = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--json') o.json = true;
    else if (x === '--hook') o.hook = true;
    else if (x === '--staged') o.staged = true;
    else if (x === '--git') { o.git = true; if (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) o.ref = a[++i]; }
    else if (x === '--scope' || x === '--claim' || x === '--fail-on') {
      const v = a[++i];
      if (v === undefined) return { error: x + ' needs a value' };
      if (x === '--scope') o.scope = v; else if (x === '--claim') o.claim = v; else o.failOn = v;
    } else if (x.startsWith('--')) return { error: 'unknown option ' + x };
    else if (o.input === null) o.input = x;
    else return { error: 'only one diff file at a time' };
  }
  if (o.failOn !== 'high' && o.failOn !== 'review') return { error: '--fail-on must be high or review' };
  if (!o.hook && !o.git && o.input === null) return { error: 'no diff given' };
  if ((o.hook || o.git) && o.input !== null) return { error: 'give a diff file or --git/--hook, not both' };
  return o;
}

/** the plain-text report: verdict line, one line per finding, the two fingerprints */
export function formatReport(result, fp) {
  if (!result || result.ok !== true) return 'ScopeGuard: could not check this input: ' + (result && result.why ? result.why : 'unknown') + (result && result.line ? ' (line ' + result.line + ')' : '') + '\n';
  const c = result.counts;
  const head = { clean: 'CLEAN', review: 'REVIEW', flagged: 'FLAGGED' }[result.verdict];
  const out = ['ScopeGuard: ' + head + ' - ' + c.high + ' high, ' + c.review + ' review, ' + c.files + (c.files === 1 ? ' file' : ' files') + ' (+' + c.added + ' -' + c.removed + ')'];
  for (const f of result.findings) {
    const where = f.path + (f.line === null ? '' : ':' + f.line);
    out.push('  ' + (f.severity === 'high' ? 'HIGH  ' : 'review') + ' ' + f.rule.padEnd(18) + ' ' + where + '  ' + f.text);
  }
  if (fp) out.push('input  sha256 ' + fp.input, 'result sha256 ' + fp.result);
  return out.join('\n') + '\n';
}

/** what the Claude Code Stop hook says to the agent when it blocks */
export function hookMessage(result) {
  const high = result.findings.filter((f) => f.severity === 'high');
  const lines = ['ScopeGuard stopped this finish: the change has ' + high.length + ' high finding' + (high.length === 1 ? '' : 's') + ' a reviewer must read.'];
  for (const f of high) lines.push('- ' + f.rule + ' at ' + f.path + (f.line === null ? '' : ':' + f.line) + ': ' + f.text);
  lines.push('Fix the code instead of the check where you can. If a finding is an honest change, say so and why in your final message. ScopeGuard does not stop you twice for the same findings.');
  return lines.join('\n');
}

/**
 * the key the hook remembers: the high findings without their line numbers, so an agent that edits other lines is not
 * stopped again for the same finding, and a new or changed finding stops it once more
 */
export function blockKey(result) {
  if (!result || result.ok !== true) return null;
  return sha256(JSON.stringify(result.findings.filter((f) => f.severity === 'high').map((f) => [f.rule, f.path, f.text])));
}

/** the hook's decision: block (exit 2) on high findings, unless this same set of findings already blocked once */
export function hookDecision(result, lastBlocked) {
  if (!result || result.ok !== true) return { code: 0, note: 'ScopeGuard could not read this change, so it did not check it: ' + (result && result.why ? result.why : 'unknown') };
  if (result.verdict !== 'flagged') return { code: 0, note: null };
  const key = blockKey(result);
  if (lastBlocked === key) return { code: 0, note: 'ScopeGuard: the same findings were already shown once; not stopping again.' };
  return { code: 2, note: hookMessage(result), remember: key };
}

/** the scope as committed at ref (never the working copy, which the change under check could have edited) */
export function committedScope(top, ref = 'HEAD') {
  try { return git(top, ['show', ref + ':.scopeguard']); } catch { return ''; }
}

function git(cwd, args, okCodes = [0]) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (okCodes.includes(e.status) && typeof e.stdout === 'string') return e.stdout; throw e; }
}

/** this folder's change as one diff: tracked changes against ref (or the staged ones) plus new untracked files */
export function workingDiff(cwd, ref = 'HEAD', staged = false) {
  const base = (() => { try { git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']); return ref; } catch { return ref === 'HEAD' ? EMPTY_TREE : null; } })();
  if (base === null) throw new Error('unknown ref ' + ref);
  const common = ['--no-color', '--no-ext-diff', '-M'];
  let text = staged ? git(cwd, ['diff', '--cached', ...common, base]) : git(cwd, ['diff', ...common, base]);
  if (!staged) {
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const p of untracked) text += git(cwd, ['diff', '--no-index', ...common, '--', '/dev/null', p], [0, 1]);
  }
  return text;
}

const readText = (p) => readFileSync(p, 'utf8');

/** run one check and return { code, stdout, stderr } (no process exit here, so the tests can call it) */
export function run(argv, { stdin = '', cwd = process.cwd() } = {}) {
  const o = parseArgs(argv);
  if (o.error) return { code: 1, stdout: '', stderr: o.error + '\n' + USAGE + '\n' };
  try {
    if (o.hook) {
      let ev = {};
      try { ev = stdin.trim() ? JSON.parse(stdin) : {}; } catch { ev = {}; }
      const dir = typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : cwd;
      let top;
      try { top = git(dir, ['rev-parse', '--show-toplevel']).trim(); } catch { return { code: 0, stdout: '', stderr: 'ScopeGuard: not a git folder, nothing to check.\n' }; }
      const diff = workingDiff(top);
      const result = audit(diff, committedScope(top));
      const mark = resolve(top, git(top, ['rev-parse', '--git-dir']).trim(), 'scopeguard-last-block');
      const last = existsSync(mark) ? readText(mark).trim() : null;
      const d = hookDecision(result, last);
      if (d.remember) writeFileSync(mark, d.remember + '\n');
      return { code: d.code, stdout: '', stderr: d.note ? d.note + '\n' : '' };
    }
    const diff = o.git ? workingDiff(resolve(cwd), o.ref, o.staged) : o.input === '-' ? stdin : readText(resolve(cwd, o.input));
    const scope = o.scope ? readText(resolve(cwd, o.scope)) : '';
    const claim = o.claim ? readText(resolve(cwd, o.claim)) : '';
    const result = audit(diff, scope, claim);
    const fp = { input: sha256(fingerprintInput(diff, scope, claim)), result: sha256(fingerprintResult(result)) };
    const code = exitCode(result, o.failOn);
    const stdout = o.json ? JSON.stringify({ result, fingerprints: fp }, null, 2) + '\n' : formatReport(result, result.ok ? fp : null);
    return { code, stdout, stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: 'ScopeGuard: ' + (e instanceof Error ? e.message : String(e)).split('\n')[0] + '\n' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const needsStdin = argv.includes('--hook') || argv.includes('-');
  const stdin = needsStdin ? (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })() : '';
  const r = run(argv, { stdin });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
