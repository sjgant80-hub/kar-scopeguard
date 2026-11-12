// page.test.mjs — the live page: it runs this repository's kernel, its examples give the verdicts it shows, its
// measured figures are the data files' figures, it can make no network request, and its words follow the house rules.
// Run: node --test page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { audit, RULES } from './kernel.mjs';
import { EXAMPLES } from './examples.mjs';
import { measured, withBlock, half, LABELS } from './tools/build-page.mjs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script type="module">'));
const prose = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

test('every example gives the verdict and the findings the page shows', () => {
  assert.equal(EXAMPLES.length, 8);
  assert.equal(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
  for (const ex of EXAMPLES) {
    const r = audit(ex.diff, ex.scope, ex.claim);
    assert.equal(r.ok, true, ex.id + ': ' + r.why);
    assert.equal(r.verdict, ex.expect.verdict, ex.id);
    assert.deepEqual(r.findings.map((f) => f.rule), ex.expect.rules, ex.id);
    assert.ok(ex.title.length > 5 && ex.story.length > 40, ex.id);
  }
  const verdicts = new Set(EXAMPLES.map((e) => e.expect.verdict));
  assert.deepEqual([...verdicts].sort(), ['clean', 'flagged', 'review'], 'the examples show all three verdicts');
  assert.equal(EXAMPLES.find((e) => e.id === 'skipped').expect.rules[0], 'skip-added', 'the trace on the page runs this one');
});

test('the page imports only its own files and can open no connection', () => {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(csp, /https?:/);
  assert.match(script, /from '\.\/kernel\.mjs'/);
  assert.match(script, /from '\.\/examples\.mjs'/);
  assert.match(script, /from '\.\/checkcase\.mjs'/);
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external script tags');
  assert.doesNotMatch(html, /<link[^>]+stylesheet/, 'no external stylesheets');
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  for (const m of script.matchAll(/import[^;]*from '([^']+)'/g)) assert.match(m[1], /^\.\//, m[1]);
});

test('the rule table and the trace are rendered from the kernel, not typed', () => {
  assert.match(script, /RULES\.map\(/);
  assert.match(script, /RULES\.length/);
  assert.match(script, /EXAMPLES\.find\(\(e\) => e\.id === 'skipped'\)/);
  for (const r of RULES) assert.ok(!prose.includes('>' + r.what + '<'), 'rule text is not duplicated by hand: ' + r.id);
});

test('the published measurements were made by this exact kernel', () => {
  const k = createHash('sha256').update(readFileSync(new URL('./kernel.mjs', import.meta.url))).digest('hex');
  for (const h of ['tune', 'held']) {
    const cal = JSON.parse(readFileSync(new URL('./data/calibration-' + h + '.json', import.meta.url), 'utf8'));
    assert.equal(cal.kernelSha256, k, h + ': the kernel changed after this half was measured; re-measure (and say so) before publishing');
  }
});

test('the measured block is exactly what the data files give', () => {
  const m = measured();
  assert.equal(withBlock(html, m), html, 'run node tools/build-page.mjs');
  assert.ok(m.held.checked > 0 && m.tune.checked > 0);
  assert.equal(m.held.labels.real + m.held.labels.falseAlarm + m.held.labels.cannotRead, m.held.flagged, 'every flagged held-out commit is labelled');
  assert.equal(m.tune.labels.real + m.tune.labels.falseAlarm + m.tune.labels.cannotRead, m.tune.flagged);
  assert.equal(m.held.clean + m.held.review + m.held.flagged + m.held.refused, m.held.checked);
  assert.ok(m.planted.copies > 0);
  assert.deepEqual(LABELS, ['real weakening', 'false alarm', 'cannot read']);
});

test('the sealed v1 record is the frozen kernel\'s, and the page\'s sentence on what v1.1 still misses matches the plants', () => {
  const m = measured();
  for (const h of ['tune', 'held']) assert.equal(JSON.parse(readFileSync(new URL('./data/v1/calibration-' + h + '.json', import.meta.url), 'utf8')).kernelSha256, 'd4bbe7e4f8916b0c775e68344dffb7f503eab674a18c5a0ce65342eb5b98b930', 'v1 is the kernel frozen at 9e580e8');
  assert.equal(m.v1.commit, '9e580e8');
  assert.equal(m.v1.held.labels.real + m.v1.held.labels.falseAlarm + m.v1.held.labels.cannotRead, m.v1.held.flagged);
  const misses = Object.fromEntries(m.planted.rules.filter((p) => p.caught < p.copies).map((p) => [p.rule, p.copies - p.caught]));
  assert.deepEqual(misses, { 'assert-neutered': 1, 'test-run-removed': 3 }, 'the page names four misses, read one by one; if the plants change, re-read them and rewrite that sentence');
  assert.match(html, /removing a check that a file is byte-identical/);
});

test('every id on the page is unique, and the page can find and parse its own data block', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dup, [], 'a duplicate id makes getElementById return the wrong element (it once hid every measured figure)');
  const block = html.match(/<script type="application\/json" id="measured-data">([\s\S]*?)<\/script>/);
  assert.ok(block, 'the data block');
  const M = JSON.parse(block[1]);
  assert.ok(M.v1 && M.tune && M.held && M.planted && M.basis && M.witness);
  assert.match(script, /JSON\.parse\(\$\('measured-data'\)\.textContent/);
});

test('half() refuses an unlabelled high finding and an unknown label', () => {
  const cal = { summary: { repos: 1, commitsSeen: 1, checked: 1, refused: 0, clean: 0, review: 0, flagged: 1 }, records: [{ repo: 'r', sha: 's', findings: [{ rule: 'skip-added', severity: 'high', path: 'p' }] }] };
  assert.throws(() => half(cal, { items: [] }), /no label for r s skip-added p/);
  assert.throws(() => half(cal, { items: [{ repo: 'r', sha: 's', rule: 'skip-added', path: 'p', label: 'maybe' }] }), /unknown label maybe/);
  const ok = half(cal, { items: [{ repo: 'r', sha: 's', rule: 'skip-added', path: 'p', label: 'false alarm', why: 'w' }] });
  assert.deepEqual(ok.labels, { real: 0, falseAlarm: 1, cannotRead: 0 });
});

test('the page explains itself: every section the house rules ask for, and every contents link lands', () => {
  for (const id of ['try', 'start', 'how', 'rules', 'measured', 'limits', 'install', 'bp', 'biz', 'cost', 'sec', 'ro', 'risk', 'board', 'paper', 'words', 'faq']) {
    assert.match(html, new RegExp('<section id="' + id + '"'), id);
    assert.match(html, new RegExp('<a href="#' + id + '">'), 'contents link ' + id);
  }
  for (const m of html.matchAll(/href="#([\w-]+)"/g)) assert.match(html, new RegExp('id="' + m[1] + '"'), 'link target ' + m[1]);
  for (const id of [...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1])) assert.match(html, new RegExp('id="' + id + '"'), 'element ' + id);
});

test('house rules: the credit, the supplier, no prices, no internal shorthand', () => {
  assert.match(prose, /Powered by the Konomi architecture, created by Thomas Frumkin\./);
  assert.match(prose, /AI Native Solutions/);
  assert.match(prose, /built by Kar/);
  assert.doesNotMatch(prose, /(?:£|\$|€)\s?\d/, 'no price on the page');
  assert.doesNotMatch(html, /karma-didy|κ|φ|konomif|sididy|\bwisp\b|the resident|prime \d/i);
  assert.doesNotMatch(prose, /\b(?:pricing|per month for|subscribe now)\b/i);
});
