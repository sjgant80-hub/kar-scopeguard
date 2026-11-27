// tools/build-house.mjs — build index.html to the AI Native house standard, from page/legacy.html (the page exactly as
// it was before the house standard, kept as this build's source) and this repository's own records.
//   node tools/build-house.mjs           write index.html
//   node tools/build-house.mjs --check   exit 1 if index.html is not what this script builds
//
// Nothing of the old page is dropped. Its "Try it" section is the glass and stays open; every other section, its
// first introduction and its footer are folded behind a click, each in full. The old styles are kept for the old
// content only, scoped under .legacy and switched to the house's dark colours. The module script that runs the
// checker is the old page's own, byte for byte. Every number in the house layer is computed here from the records
// (measured() — the same figures tools/build-page.mjs writes into the page's data block —, the kernel's RULES, the
// witness receipt and the bars written in CLAIMS.md). Nothing is typed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measured, withBlock } from './build-page.mjs';
import { RULES } from '../kernel.mjs';
import { scope } from '../vendor/house/scope.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const CREDIT = 'Powered by the Konomi architecture, created by Thomas Frumkin.';
const SUPPLIER = '<a href="https://www.ai-nativesolutions.com">AI Native Solutions</a>';

// ---- the old page, taken apart (nothing is thrown away) ----------------------------------------------------------
const OLD = read('page/legacy.html');
const pick = (re, what) => { const m = OLD.match(re); if (!m) throw new Error('page/legacy.html has no ' + what); return m; };
const oldCss = pick(/<style>([\s\S]*?)<\/style>/, 'style sheet')[1];
const csp = pick(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/, 'Content-Security-Policy')[1];
const title = pick(/<title>([^<]*)<\/title>/, 'title')[1];
const description = pick(/<meta name="description" content="([^"]*)">/, 'description')[1];
const header = pick(/<header>([\s\S]*?)<\/header>/, 'header')[1];
const nav = pick(/<nav class="toc"[\s\S]*?<\/nav>/, 'contents')[0];
const footer = pick(/<footer>([\s\S]*?)<\/footer>/, 'footer')[1];
const moduleScript = pick(/<script type="module">[\s\S]*?<\/script>/, 'module script')[0];
const dataOpen = '<script type="application/json" id="measured-data">';
const sections = [...OLD.matchAll(/<section id="([\w-]+)"[\s\S]*?<\/section>/g)].map((m) => ({ id: m[1], html: m[0] }));
if (!sections.some((s) => s.id === 'try')) throw new Error('page/legacy.html has no Try it section');

// fonts are the kit's own files, served from this page's origin: the policy gains font-src 'self' and nothing else
const policy = /font-src/.test(csp) ? csp : csp.replace("img-src", "font-src 'self'; img-src");

// ---- the records ---------------------------------------------------------------------------------------------------
const m = measured();
const H = m.held, P = m.planted, W = m.witness.gates;
const claimsMd = read('CLAIMS.md');
const barS4 = Number((claimsMd.match(/at most (\d+(?:\.\d+)?)%\s+of held-out honest commits/) || [])[1]);
const barS5 = Number((claimsMd.match(/Target: (\d+)% per rule/) || [])[1]);
if (!Number.isFinite(barS4) || !Number.isFinite(barS5)) throw new Error('CLAIMS.md no longer states the S4 and S5 bars this page reads');
const wrongFlags = H.flagged - H.labels.real;                       // a real weakening is a catch, not a false alarm (S4)
const rateS4 = H.checked ? wrongFlags / H.checked : 1;
const misses = P.rules.filter((r) => r.caught < r.copies);
const missed = P.copies - P.caught;
const gateKilled = W.reduce((a, g) => a + g.killed, 0), gateTotal = W.reduce((a, g) => a + g.total, 0);
const gatesClean = W.length > 0 && W.every((g) => g.clean && g.survived === 0);
const high = RULES.filter((r) => r.severity === 'high').length;
const PLAIN_RULE = { 'assert-neutered': 'a real check swapped for one that can never fail', 'test-run-removed': 'the step that runs the tests taken out' };
const plainMiss = (r) => `${r.copies - r.caught} of ${fmt(r.copies)} where ${PLAIN_RULE[r.rule] || 'the rule ' + r.rule + ' applies'}`;

const goals = [
  { id: 'S4', name: 'Few false alarms on honest changes', pass: rateS4 * 100 <= barS4,
    result: `It flagged ${H.flagged} of ${fmt(H.checked)} test changes it had never seen. The goal was ${barS4} in 100 at most. `
      + (H.labels.real === 0 ? `None was a real weakening: ${H.labels.falseAlarm} false alarms, ${H.labels.cannotRead} it could not read.` : `${H.labels.real} were real weakenings, which count as catches.`) },
  { id: 'S5', name: 'Catches weakenings planted into real changes', pass: misses.length === 0 && barS5 === 100,
    result: misses.length === 0 ? `It caught all ${fmt(P.copies)}, in every kind it checks.` : `It caught ${fmt(P.caught)} of ${fmt(P.copies)}. The goal was every one. It missed ${misses.map(plainMiss).join(', and ')}.` },
  { id: 'S8', name: 'Its own code is tested by breaking it on purpose', pass: gatesClean,
    result: gatesClean ? `Its tests caught all ${fmt(gateTotal)} breaks, in ${W.length} files, and none was excused.` : `Its tests caught ${fmt(gateKilled)} of ${fmt(gateTotal)} breaks. Some got through.` },
];
const met = goals.filter((g) => g.pass).length, failed = goals.length - met;

// ---- the house layer -----------------------------------------------------------------------------------------------
const receipts = [
  { n: `${H.flagged} of ${fmt(H.checked)}`, lab: `test changes it flagged, from ${H.repos} of our own projects it had never seen. ${H.labels.real === 0 ? 'None was a real weakening.' : H.labels.real + ' were real weakenings.'}`, src: 'data/calibration-held.json', what: 'the set-aside run' },
  { n: `${fmt(P.caught)} of ${fmt(P.copies)}`, lab: missed === 0 ? 'weakenings planted into real changes that it caught. It caught every one.' : `weakenings planted into real changes that it caught. It missed ${missed}, shown in red below.`, src: 'data/planted.json', what: 'the planted run', red: missed > 0 },
  { n: `${fmt(gateKilled)} of ${fmt(gateTotal)}`, lab: 'breaks made on purpose in its own code that its tests caught.', src: 'receipts/witness.json', what: 'the test of the tests' },
  { n: `${RULES.length}`, lab: `kinds of weakened test it looks for, ${high} of them serious. Each is listed below.`, src: 'kernel.mjs', what: 'the rule list' },
];
// "X of Y": the house idiom (as on The Seed) sets "of Y" small, so a long count still fits inside its card
const numHtml = (n, red) => { const m = String(n).match(/^(\S+) of (\S+)$/); const tone = red ? ' style="color:var(--gold)"' : ''; return m ? `<span class="now"${tone}>${esc(m[1])}</span><span class="was" style="font-size:.42em"> of ${esc(m[2])}</span>` : `<span class="now"${tone}>${esc(n)}</span>`; };
const receiptsHtml = receipts.map((r) => `<div class="stat reveal"><div class="n">${numHtml(r.n, r.red)}</div><div class="lab">${esc(r.lab)}</div><a class="src" href="${r.src}">receipt: ${esc(r.what)} ↗</a></div>`).join('');

const goalsHtml = goals.map((g) => `<div class="srow${g.pass ? '' : ' red'}"><div class="d">${g.id}</div><div class="nm"><b>${esc(g.name)}</b><span>${esc(g.result)}</span>${g.pass ? '<span class="tag cy">met</span>' : '<span class="tag rd">missed · kept</span>'}</div></div>`).join('');

const PART = {
  'kernel.mjs': ['The checker', 'reads a change line by line and finds weakened tests'],
  'cli.mjs': ['The command line', 'the same checker in a terminal, in CI, or as a hook'],
  'skillcli.mjs': ['The one-file skill', 'a single file you can drop into any project'],
  'checkcase.mjs': ['The cost sums', 'works out review time from sourced pay figures'],
};
const partsHtml = W.map((g, i) => { const [nm, line] = PART[g.file] || [g.file, 'a part of this build']; return `<div class="srow${g.clean ? '' : ' red'}" title="${esc(g.file)}"><div class="d">${String(i + 1).padStart(2, '0')}</div><div class="nm"><b>${esc(nm)}</b><span>${esc(line)}</span>${g.clean ? `<span class="tag cy">${fmt(g.killed)} of ${fmt(g.total)} breaks caught</span>` : `<span class="tag rd">${fmt(g.killed)} of ${fmt(g.total)} caught</span>`}</div></div>`; }).join('');

const ROLES = [
  ['Engineering leads', 'A green build from an AI agent can be trusted again. Weakened tests are caught before they are merged.'],
  ['Security', 'A list of the files a task may touch becomes a check on every change. No code leaves your machines.'],
  ['Finance', 'Review time is the cost of using AI safely. It puts the lines that need a person first.'],
  ['Operations', 'Fewer surprises from changes that only passed because a test was weakened. A record of each check.'],
  ['The board', 'Proof that AI-written code passes a real control, one anyone can run again and get the same answer.'],
  ['The engineers', 'No new tool to log into. It is one step in CI and one hook.'],
];
const rolesHtml = ROLES.map(([r, l]) => `<div class="act reveal"><b>${esc(r)}</b><p>${esc(l)}</p></div>`).join('');

// the glass: the old Try it section, open. Its long first sentence goes one click down, word for word.
const TRY = sections.find((s) => s.id === 'try').html.replace(/<p>(Pick one of the real-shaped examples[\s\S]*?)<\/p>/, (all, inner) =>
  `<p>Press an example, or paste a change of your own.</p><details class="note"><summary>What can I paste?</summary><p>${inner}</p></details>`);
if (!TRY.includes('What can I paste?')) throw new Error('the Try it section changed: its first sentence was not found');

// the folds: the old introduction (its h1 kept as bold text: the house hero carries the page's one h1, and the
// contents now sit open above), every other old section, and the old footer (its version line now sits in the
// house footer, which is where the page's script still writes it)
const fold = (summary, body, id) => `<details class="fold"${id ? ` id="${id}"` : ''}><summary>${esc(summary)}</summary><div class="legacy">${body}</div></details>`;
const introHtml = header.replace(nav, '').replace(/<h1>([\s\S]*?)<\/h1>/, '<p><b>$1</b></p>');
const footerHtml = footer.replace(/<p class="small" id="ver"><\/p>\s*/, '');
const folds = [fold('The first introduction', introHtml, 'fold-intro')]
  .concat(sections.filter((s) => s.id !== 'try').map((s) => fold(text((s.html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, s.id])[1]), s.html, 'fold-' + s.id)))
  .concat([fold('The first footer', footerHtml, 'fold-footer')]).join('\n');

const faces = goals.map((g) => g.pass).concat(W.map((g) => g.clean));
const facet = `${met} of ${goals.length} goals met${failed ? ` · ${failed} missed and kept` : ''} · point at a face`;
const facesJson = JSON.stringify({ faces, labels: goals.map((g) => `${g.id} ${g.name} · ${g.pass ? 'met' : 'missed, kept'}`).concat(W.map((g) => `${(PART[g.file] || [g.file])[0]} · ${g.killed} of ${g.total} breaks caught`)), facet });

// the kit, inlined in scope (no file is fetched): exports become a namespace object
function inline(ns, file) {
  const src = read(file);
  const names = [...src.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((x) => x[1]);
  const code = src.split('\n').filter((l) => !l.startsWith('export default ')).map((l) => l.replace(/^export /, '')).join('\n').trim();
  return `// ${file}, inlined byte for byte (export removed)\nconst ${ns} = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();`;
}

const LEGACY_DARK = '.legacy{--bg:transparent;--card:#081320;--ink:#e9f2f6;--muted:#aebecb;--line:rgba(174,190,203,.18);--accent:#49e8c8;--accent-ink:#02070c;--good:#49e8c8;--warn:#ffcf6a;--bad:#ff6b6b;--code:#060e18;--hi:rgba(255,107,107,.12);--rv:rgba(255,207,106,.1);color:var(--ink)}';
const LOCAL_CSS = `
@media(min-width:761px){#result .stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.hero .hero-in{padding-bottom:84px}}
.jump{display:flex;flex-wrap:wrap;gap:6px 8px;padding:18px 0 4px}
.jump a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid rgba(174,190,203,.18);border-radius:999px;color:var(--soft);text-decoration:none;font:500 .88rem var(--mono,'JetBrains Mono',monospace)}
.jump a:hover,.jump a:focus-visible{color:var(--cyan);border-color:var(--cyan)}
.steps{margin:0;padding-left:1.2em;color:var(--soft)}.steps li{margin:.35em 0}
.glass .legacy section{margin:0}
.glass .legacy textarea{max-width:100%}
.legacy .card{overflow-x:auto}
details.fold{border:1px solid rgba(174,190,203,.14);border-radius:12px;margin:10px 0;background:rgba(8,19,32,.6)}
details.fold>summary{padding:14px 16px;cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center}
details.fold>.legacy{padding:0 16px 16px;overflow-x:auto}
details.note{margin:.4em 0}details.note>summary{cursor:pointer;color:var(--soft);font-size:.92rem;min-height:36px;display:flex;align-items:center}
.acts .act b{display:block;color:var(--ink);margin-bottom:.3em}
.acts .act p{margin:0;color:var(--soft)}
.srow .mono{font-size:.8em}
footer #ver{margin:.6em 0 0}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<style>
${read('vendor/house/house.css').trim()}
/* the old page's own styles, for its own content only (scope() from the house standard) */
${scope(oldCss)}
${LEGACY_DARK}
${LOCAL_CSS.trim()}
</style>
</head>
<body>
<header class="hero" id="top">
  <canvas id="crystal" role="img" aria-label="A crystal of faces. Each lit face is one of this build's measured goals or tested parts: cyan when met, red when missed and kept."></canvas>
  <div class="hero-shade"></div>
  <div class="wrap hero-in">
    <p class="eyebrow reveal">For teams that let AI write code</p>
    <h1>Your AI says the tests pass. <em>See how.</em></h1>
    <p class="lede reveal">ScopeGuard reads the change an AI made. It shows every test that was skipped, weakened or deleted. It runs in your browser, and nothing is sent anywhere.</p>
  </div>
  <p class="facet" id="facet" aria-live="polite">${esc(facet)}</p>
</header>

<div class="wrap">${nav.replace('<nav class="toc"', '<nav class="jump"')}</div>

<section class="pad" id="result">
  <div class="wrap">
    <p class="kline reveal">Measured, not claimed</p>
    <h2 class="claim reveal">Read from its own records. <b>Each number has its source one click away.</b></h2>
    <div class="stats">${receiptsHtml}</div>
  </div>
</section>

<section class="pad alt" id="start-now">
  <div class="wrap">
    <p class="kline reveal">Start here</p>
    <h2 class="claim reveal">Four steps. <b>No sign-up.</b></h2>
    <ol class="steps reveal">
      <li>Press one of the examples in the box below.</li>
      <li>Press <b>Check it</b>.</li>
      <li>Read what it found. Each line says which rule fired and why.</li>
      <li>Then paste a change of your own. Nothing leaves this page.</li>
    </ol>
    <p class="sub reveal">The full guide is in <a href="#start">Start here</a>, further down.</p>
  </div>
</section>

<section class="pad proof" id="glass-wrap">
  <div class="wrap">
    <p class="kline reveal">Try it: it runs here, on your machine</p>
    <div class="glass"><div class="legacy">${TRY}</div></div>
  </div>
</section>

<section class="pad" id="goals">
  <div class="wrap">
    <p class="kline reveal">Goals written down before any code</p>
    <h2 class="claim reveal">${met} of ${goals.length} measured goals met. <b>${failed ? 'The miss stays on the page.' : 'Each one met.'}</b></h2>
    <div class="stack reveal">${goalsHtml}</div>
    <p class="sub reveal">Six more goals (S1 to S3, S6, S7 and S9) are checked by its tests on every change. All nine are in full in the sealed claims file.</p>
  </div>
</section>

<section class="pad alt" id="parts">
  <div class="wrap">
    <p class="kline reveal">How it is built</p>
    <h2 class="claim reveal">Small files, one job each. <b>Each one tested by breaking it.</b></h2>
    <div class="stack reveal">${partsHtml}</div>
  </div>
</section>

<section class="pad" id="who">
  <div class="wrap">
    <p class="kline reveal">Who it is for</p>
    <h2 class="claim reveal">One check. <b>Something for each role.</b></h2>
    <div class="acts">${rolesHtml}</div>
  </div>
</section>

<section class="pad alt" id="honest">
  <div class="wrap">
    <p class="kline reveal">Said straight</p>
    <h2 class="claim reveal">What it cannot do. <b>What can go wrong.</b></h2>
    <details class="honest reveal"><summary>What it can't tell you</summary><div class="in">
      <p>It cannot tell why a line changed. A flagged line can be honest, like a test removed along with the feature it tested.</p>
      <p>It only reads the change. It does not run the tests. A weakening it has no rule for passes unnoticed.</p>
      <p>Its rules read one line at a time. A check split over several lines is seen only through its first line.</p>
      <p>The count of false alarms was taken mostly on JavaScript. Other languages have rules and tests, but no such count yet.</p></div></details>
    <details class="honest reveal"><summary>What can go wrong</summary><div class="in">
      <p>${wrongFlags === 0 ? 'On the set it had never seen, it raised no false alarm. It still can.' : `It will sometimes flag an honest change. On the set it had never seen, that was ${wrongFlags} of ${fmt(H.checked)}.`} A false flag costs a reviewer a minute of reading.</p>
      <p>${missed === 0 ? 'It caught every weakening planted into real changes. It can still miss one it has no rule for.' : `It can miss a weakening. On the planted cases it missed ${missed}, and those stay in red above.`}</p>
      <p>An AI that reads this page could pick a weakening with no rule. So "clean" only means no listed rule fired.</p>
      <p>People decide what is merged. ScopeGuard only points at the lines to read.</p></div></details>
    <details class="honest reveal"><summary>Your data, who owns it, and support</summary><div class="in">
      <p>The check runs in your browser or on your own machine. This page cannot connect to anything: its security rules forbid it.</p>
      <p>It is open code under the MIT licence. Your copy is yours to run, change and keep, with or without us.</p>
      <p>It is supplied by ${SUPPLIER}. Support is agreed per deployment, in each deployment's agreement.</p></div></details>
    <details class="honest reveal"><summary>What changed on this page</summary><div class="in">
      <p>This page was rebuilt to the house standard. Nothing was taken out: every section of the old page is below, one click away.</p>
      <p>The checker, its records and its tests were not changed. The script that runs the check is the same script as before.</p></div></details>
  </div>
</section>

<section class="pad" id="full">
  <div class="wrap">
    <p class="kline reveal">Every detail is still here</p>
    <h2 class="claim reveal">The full page. <b>One click away.</b></h2>
${folds}
  </div>
</section>

<footer>
  <div class="wrap frow">
    <div><div class="brand">ScopeGuard</div><div class="fnote">Built by Kar · MIT licence (holder Simon Gant) · supplied by ${SUPPLIER}<br>${CREDIT}</div><p class="small" id="ver"></p></div>
    <div class="taglist"><span>›</span> Checks how the tests went green.<br><span>›</span> Runs on your machine. Sends nothing.</div>
  </div>
</footer>
<script>
${inline('CRYSTAL', 'vendor/house/crystal.js')}

${inline('HOUSE', 'vendor/house/house.js')}

// the house layer: the crystal lit by the goals and parts computed at build time, and links that open their fold
(() => {
  const D = ${facesJson};
  const $ = (id) => document.getElementById(id);
  const crystal = CRYSTAL.mount($('crystal'), { energy: 0.9 });
  if (crystal) {
    crystal.setFaces(Array.from({ length: CRYSTAL.FACES }, (_, i) => (D.faces[i % D.faces.length] ? 1 : 3)));
    crystal.onHover((i) => { const l = D.labels[i % D.labels.length]; $('facet').textContent = l || D.facet; });
    HOUSE.bindScroll(crystal, 0.9);
  }
  const openTo = (id) => { const t = document.getElementById(id); if (!t) return false; for (let e = t; e; e = e.parentElement) if (e.tagName === 'DETAILS') e.open = true; t.scrollIntoView({ block: 'start' }); return true; };
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="#"]'); if (!a) return; const id = decodeURIComponent(a.getAttribute('href').slice(1)); if (id && openTo(id)) { e.preventDefault(); history.replaceState(null, '', '#' + id); } });
  if (location.hash) openTo(decodeURIComponent(location.hash.slice(1)));
  HOUSE.reveal(document);
  HOUSE.light(document);
})();
</script>
${dataOpen}</script>
${moduleScript}
</body>
</html>
`;

export function build() { return withBlock(html, m); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build(), page = join(ROOT, 'index.html');
  if (process.argv.includes('--check')) {
    const cur = readFileSync(page, 'utf8');
    if (cur !== out) { console.error('index.html is not what tools/build-house.mjs builds; run node tools/build-house.mjs'); process.exit(1); }
    console.log('index.html is what tools/build-house.mjs builds');
  } else { writeFileSync(page, out); console.log(`built index.html · ${receipts.length} receipts · ${goals.length} goals (${failed} missed, kept) · ${W.length} parts · ${sections.length - 1} old sections folded`); }
}
