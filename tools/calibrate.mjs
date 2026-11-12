// tools/calibrate.mjs — run the kernel over every non-merge commit that touches a test, snapshot or gate file in the
// estate's public repositories cloned on this machine, one half at a time (see CLAIMS.md, S4).
//
//   node tools/calibrate.mjs tune  [--root C:/Users/sjgan] [--out data/calibration-tune.json]
//   node tools/calibrate.mjs held  (read ONCE, after the kernel's hash is committed)
//
// Each record names the public repository, the commit and the SHA-256 of the diff text the kernel read, so anyone
// can re-run it: git show --format= --no-color --no-ext-diff <sha> | node cli.mjs --json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, classify, parseScope } from '../kernel.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const half = args[0];
  if (half !== 'tune' && half !== 'held') { console.error('usage: node tools/calibrate.mjs tune|held [--root DIR] [--out FILE]'); process.exit(1); }
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const root = opt('--root', 'C:/Users/sjgan');
  const out = opt('--out', join(here, '..', 'data', 'calibration-' + half + '.json'));
  const repos = JSON.parse(readFileSync(join(here, 'repos.json'), 'utf8')).filter((r) => r.half === half);
  const git = (dir, a) => execFileSync('git', ['-C', dir, ...a], { maxBuffer: 1 << 28, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const noScope = parseScope('');
  const records = [];
  let commitsSeen = 0;
  for (const r of repos) {
    const dir = join(root, r.d);
    if (!existsSync(join(dir, '.git'))) continue;
    let log;
    try { log = git(dir, ['log', '--no-merges', '--format=@@C %H', '--name-only', '-M']); } catch (e) { console.error('skip ' + r.repo + ': ' + String(e.message).split('\n')[0]); continue; }
    const commits = [];
    for (const line of log.split('\n')) {
      if (line.startsWith('@@C ')) commits.push({ sha: line.slice(4), files: [] });
      else if (line.trim() !== '' && commits.length) commits[commits.length - 1].files.push(line.trim());
    }
    commitsSeen += commits.length;
    for (const c of commits) {
      if (!c.files.some((p) => classify(p, noScope).kind !== 'source')) continue;
      let diff;
      try { diff = git(dir, ['show', '--format=', '--no-color', '--no-ext-diff', '-M', c.sha]); } catch { records.push({ repo: r.repo, sha: c.sha, error: 'git show failed' }); continue; }
      const res = audit(diff);
      const rec = { repo: r.repo, sha: c.sha, diffSha256: createHash('sha256').update(diff, 'utf8').digest('hex'), chars: diff.length };
      if (!res.ok) { rec.refused = res.why; rec.line = res.line; }
      else {
        const status = new Map(res.files.map((x) => [x.path, x.status]));
        rec.verdict = res.verdict;
        rec.findings = res.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path, status: status.get(f.path) || null, line: f.line, text: f.text }));
      }
      records.push(rec);
    }
  }
  const byRule = {};
  for (const rec of records) for (const f of rec.findings || []) { byRule[f.rule] = byRule[f.rule] || { commits: new Set(), findings: 0 }; byRule[f.rule].commits.add(rec.sha); byRule[f.rule].findings++; }
  const summary = {
    half, repos: repos.length, commitsSeen, checked: records.length,
    refused: records.filter((x) => x.refused).length,
    flagged: records.filter((x) => x.verdict === 'flagged').length,
    review: records.filter((x) => x.verdict === 'review').length,
    clean: records.filter((x) => x.verdict === 'clean').length,
    byRule: Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, { commits: v.commits.size, findings: v.findings }])),
  };
  mkdirSync(dirname(out), { recursive: true });
  const kernelSha256 = createHash('sha256').update(readFileSync(join(here, '..', 'kernel.mjs'))).digest('hex');
  writeFileSync(out, JSON.stringify({ kind: 'kar-scopeguard.calibration', at: new Date().toISOString().slice(0, 10), kernelSha256, summary, records }, null, 1) + '\n');
  console.log(JSON.stringify(summary, null, 1));
}
