// house.test.mjs — the page holds to the AI Native house standard and cannot drift back: the seven-rule ship gate
// and the reading check, both vendored from the house standard; the page is exactly what tools/build-house.mjs
// builds from page/legacy.html and the records; and nothing the old page had is lost.
// Run: node --test house.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import STANDARD from './vendor/house/standard.mjs';
import { check as plain } from './vendor/house/plain.mjs';
import { build } from './tools/build-house.mjs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const legacy = readFileSync(new URL('./page/legacy.html', import.meta.url), 'utf8');
const flat = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('the page passes all seven house-standard rules', () => {
  const r = STANDARD.check(html);
  assert.equal(r.pass, true, 'house rules failed:\n  ' + r.rules.filter((x) => !x.pass).map((x) => `${x.id} ${x.name}: ${x.why}`).join('\n  '));
});

test('a twelve-year-old can read what greets a visitor (the house reading check)', () => {
  const r = plain(html);
  assert.equal(r.pass, true, 'reading check failed:\n  ' + r.rules.filter((x) => !x.pass).map((x) => `${x.id} ${x.name}: ${x.why}`).join('\n  '));
});

test('index.html is exactly what tools/build-house.mjs builds (run it after any record changes)', () => {
  assert.equal(html, build(), 'index.html drifted: run node tools/build-house.mjs');
});

test('nothing the old page had is lost: every section, every word of every section', () => {
  for (const m of legacy.matchAll(/<section id="([\w-]+)"[\s\S]*?<\/section>/g)) {
    assert.match(html, new RegExp('<section id="' + m[1] + '"'), 'section ' + m[1]);
    const words = flat(m[0]).split(' ').filter((w) => w.length > 3);
    const have = flat(html);
    const lost = words.filter((w) => !have.includes(w));
    assert.deepEqual(lost, [], 'section ' + m[1] + ' lost words');
  }
  for (const part of ['header', 'footer']) {
    const inner = legacy.match(new RegExp('<' + part + '>([\\s\\S]*?)</' + part + '>'))[1];
    const lost = flat(inner).split(' ').filter((w) => w.length > 3 && !flat(html).includes(w));
    assert.deepEqual(lost, [], 'the old ' + part + ' lost words');
  }
});

test('the script that runs the check is the old page\'s own, byte for byte', () => {
  const was = legacy.match(/<script type="module">[\s\S]*?<\/script>/)[0];
  assert.ok(html.includes(was), 'the module script changed');
});

test('the policy still forbids every connection; fonts load only from this page\'s own origin', () => {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /font-src 'self'/);
  assert.doesNotMatch(csp, /https?:/);
});

test('the fonts come from this repository\'s own vendor/fonts, and the page makes no outside request', () => {
  assert.doesNotMatch(html, /<link[^>]+(stylesheet|preload)/);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /url\(\s*['"]?https?:/);
  for (const f of ['fraunces/files/fraunces-latin-full-normal.woff2', 'hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2']) {
    assert.ok(html.includes('vendor/fonts/' + f), 'font ' + f);
  }
});
