// skillcli.mjs — the command line inside the agent skill (scripts/kar-scopeguard.mjs): read a diff, print the JSON
// report. Unlike cli.mjs it runs no git, writes no files and reads no environment, because a skill script runs alone
// from a temporary file. tools/build-skill.mjs inlines kernel.mjs above this file to make the skill script.
//
//   node scripts/kar-scopeguard.mjs change.diff [--scope scope.txt] [--claim summary.txt]
//   git diff main...HEAD | node scripts/kar-scopeguard.mjs -
// Exit codes: 0 clean or review, 2 flagged, 1 the input could not be read or bad usage.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { audit, exitCode, fingerprintInput, fingerprintResult } from './kernel.mjs';

const skillSha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** the whole skill run as a pure step: { code, out, err } from the arguments and a reader for files */
export function skillRun(argv, readText) {
  const a = Array.isArray(argv) ? argv : [];
  // an option's value; null when the option is absent, undefined when it has no value after it
  const val = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
  const input = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--scope' && a[i - 1] !== '--claim');
  const scopePath = val('--scope'); const claimPath = val('--claim');
  if (input === undefined || scopePath === undefined || claimPath === undefined) return { code: 1, out: '', err: 'usage: node kar-scopeguard.mjs <diff-file|-> [--scope FILE] [--claim FILE]\n' };
  try {
    const diff = readText(input);
    const scope = scopePath === null ? '' : readText(scopePath);
    const claim = claimPath === null ? '' : readText(claimPath);
    const result = audit(diff, scope, claim);
    const report = { verdict: result.ok ? result.verdict : 'unreadable', ...result, fingerprints: { input: skillSha256(fingerprintInput(diff, scope, claim)), result: skillSha256(fingerprintResult(result)) } };
    return { code: exitCode(result), out: JSON.stringify(report, null, 2) + '\n', err: result.ok ? '' : 'could not read the diff: ' + result.why + '\n' };
  } catch (e) {
    return { code: 1, out: '', err: 'could not read the input: ' + String(e && e.message ? e.message : e).split('\n')[0] + '\n' };
  }
}

/** read a named file, or standard input for "-" */
export const readInput = (p) => readFileSync(p === '-' ? 0 : p, 'utf8');

// tools/build-skill.mjs appends the lines that run skillRun on process.argv to the skill script, so the script runs
// whatever its file is called (a skill runner writes it to a temporary file); this module itself runs nothing.
