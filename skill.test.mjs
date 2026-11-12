// skill.test.mjs — the agent skill: its one-file script runs ALONE (copied into an empty folder, no other file of
// the package beside it) and gives the expected report on every example; skillRun's options and exit codes.
// Run: node --test skill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCRIPT, skillScript, RUN } from './tools/build-skill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SKIP = 'diff --git a/t/a.test.js b/t/a.test.js\nindex 1..2 100644\n--- a/t/a.test.js\n+++ b/t/a.test.js\n@@ -1,1 +1,1 @@\n-it("adds", () => {\n+it.skip("adds", () => {\n';

test('the shipped script is kernel.mjs + skillcli.mjs + the run lines', () => {
  const want = skillScript(readFileSync(join(here, 'kernel.mjs'), 'utf8'), readFileSync(join(here, 'skillcli.mjs'), 'utf8'));
  assert.equal(readFileSync(join(here, SCRIPT), 'utf8'), want, 'run node tools/build-skill.mjs');
  assert.ok(want.includes(readFileSync(join(here, 'kernel.mjs'), 'utf8')), 'the kernel is inside, byte for byte');
  assert.ok(want.endsWith(RUN));
  assert.doesNotMatch(want, /from '\.\/kernel\.mjs'/);
  assert.doesNotMatch(want, /node:child_process|\bfetch\s*\(|https?:\/\/|process\.env|writeFileSync|base64/);
});

test('the script runs alone in an empty folder and gives each example its expected report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scopeguard-skill-'));
  copyFileSync(join(here, SCRIPT), join(dir, 'random-name-123.mjs'));
  const ex = readdirSync(join(here, 'examples'));
  const ids = ex.filter((f) => f.endsWith('.diff.txt')).map((f) => f.slice(0, -9));
  assert.equal(ids.length, 8);
  for (const id of ids) {
    for (const f of ex.filter((x) => x.startsWith(id + '.') && !x.endsWith('.out.json'))) copyFileSync(join(here, 'examples', f), join(dir, f));
    const args = [id + '.diff.txt', ...(ex.includes(id + '.scope.txt') ? ['--scope', id + '.scope.txt'] : []), ...(ex.includes(id + '.claim.txt') ? ['--claim', id + '.claim.txt'] : [])];
    const r = spawnSync(process.execPath, ['random-name-123.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.stdout, readFileSync(join(here, 'examples', id + '.out.json'), 'utf8'), id);
    const v = JSON.parse(r.stdout).verdict;
    assert.equal(r.status, v === 'flagged' ? 2 : 0, id);
  }
  const piped = spawnSync(process.execPath, ['random-name-123.mjs', '-'], { cwd: dir, encoding: 'utf8', input: SKIP });
  assert.equal(piped.status, 2);
  assert.equal(JSON.parse(piped.stdout).findings[0].rule, 'skip-added');
  rmSync(dir, { recursive: true, force: true });
});

