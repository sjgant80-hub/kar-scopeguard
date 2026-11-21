// ScopeGuard as a cell of the estate genome: its judge (the kernel's own audit), its lane and its health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, inLane, health } from './genome/cell.mjs';
import { EXAMPLES } from './examples.mjs';

const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const input = (e) => ({ diff: e.diff, scope: e.scope, claim: e.claim });
const HONEST = input(EXAMPLES.find((e) => e.id === 'honest'));

test('judge: only a change the audit calls clean is verified, on every worked example on the page', async () => {
  const want = { clean: 'verified', review: 'unverified', flagged: 'unverified' };
  const seen = new Set();
  for (const e of EXAMPLES) {
    assert.equal(await judge(input(e)), want[e.expect.verdict], e.id);
    seen.add(e.expect.verdict);
  }
  assert.deepEqual([...seen].sort(), ['clean', 'flagged', 'review'], 'the examples hold all three verdicts');
});

test('judge: an empty diff is what git prints when nothing changed, and the kernel calls it clean', async () => {
  assert.equal(await judge({ diff: '' }), 'verified');
});

test('judge: the seed cases split good from bad', async () => {
  assert.deepEqual(seed.judge.cases.good, JSON.parse(JSON.stringify(HONEST)));
  assert.equal(await judge(seed.judge.cases.good), 'verified');
  assert.equal(await judge(seed.judge.cases.bad), 'unverified');
});

test('lane: a readable change is in lane, flagged or not; what the kernel cannot read is out and refused', async () => {
  assert.equal(await inLane(HONEST), true);
  assert.equal(await inLane(seed.boundary.inLane), true);
  assert.equal(await inLane({ diff: HONEST.diff }), true);
  const bad = [null, undefined, 'x', 5, {}, seed.boundary.outOfLane, { diff: 5 }, { diff: 'all tests pass' },
    { diff: HONEST.diff, scope: 5 }, { diff: HONEST.diff, scope: 'frobnicate x' }];
  for (const b of bad) {
    assert.equal(await inLane(b), false, String(JSON.stringify(b)));
    assert.equal(await judge(b), 'refused', String(JSON.stringify(b)));
  }
});

test('health says what ScopeGuard cannot measure from inside its repository', async () => {
  assert.deepEqual(await health(), { used: null, dependedOn: null, lastEarned: null });
});
