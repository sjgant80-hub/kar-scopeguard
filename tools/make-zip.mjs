// make-zip.mjs — builds the Agensi upload: dist/<name>.zip, one top folder <name>/ holding SKILL.md,
// LICENSE, scripts/ and examples/. Zero dependencies, and deterministic: fixed timestamps and a fixed
// file order, so the same commit always gives the same bytes and the same SHA-256. CI prints that hash;
// the ZIP you upload can be checked against it.
//
// Before it writes anything it checks the rules Agensi publishes (https://www.agensi.io/docs/packaging,
// /docs/review-and-approval, /security) and our own (no prices anywhere; the Konomi credit on the repo's
// README and page), and refuses to build a package that breaks one. The credit is kept OFF the package
// itself (SKILL.md, script) until Simon decides whether it allows commercial sale.
//
//   node make-zip.mjs            check, then write dist/<name>.zip and print its SHA-256
//   node make-zip.mjs --check    check only
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// copied from sjgant80-hub/kar-tally's make-zip.mjs; here it lives in tools/ and works from the repository root,
// and the receipt it checks SKILL.md against is the kernel's entry in receipts/witness.json
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const NAME = pkg.name;
const ALLOW = new Set((pkg.agensi && pkg.agensi.allow) || []);   // patterns a skill needs for its job, declared

// ---- what goes in the package ----
function packageFiles() {
  const files = ['SKILL.md', 'LICENSE'];
  for (const dir of ['scripts', 'examples', 'references']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (statSync(`${dir}/${f}`).isFile()) files.push(`${dir}/${f}`);
  }
  return files;
}

// ---- the rules ----
const EXECUTABLE = /\.(exe|dll|so|dylib|bin|app|dmg|msi|deb|rpm|wasm|class|jar|war)$/i;   // /docs/packaging
const TEXT = /(^LICENSE$|\.(md|mjs|js|json|txt)$)/;
const INJECTION = [/ignore (all |any )?(previous|prior) instructions/i, /do not tell the user/i, /\bsecretly\b/i];
const SCRIPT_RISK = [
  [/\bfetch\s*\(|XMLHttpRequest|node:https?\b|\bWebSocket\b|node:net\b|node:dgram\b/, 'network'],
  [/https?:\/\//, 'url'],
  [/\beval\s*\(|new Function\s*\(/, 'eval'],
  [/base64|atob\(|btoa\(/i, 'encoded'],
  [/node:child_process/, 'child_process'],
  [/\b(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|writeFile|mkdirSync)\b/, 'file-writes'],
  [/process\.env\b/, 'env'],
];
const PRICE = [/[£$€]\s?\d/, /\/mo\b/i, /\bpricing\b/i, /per (seat|month|user)\b/i, /priceCurrency|"@type"\s*:\s*"Offer"/];
const KONOMI = /Powered by the Konomi architecture, created by Thomas Frumkin/i;

export function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fields = {}; const bad = [];
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([a-z_]+): (".*"|\[.*\])$/);   // every value is a quoted string or a flow list
    if (!f) { bad.push(line); continue; }
    fields[f[1]] = JSON.parse(f[2]);                       // so JSON parses it exactly as YAML does
  }
  return { fields, bad, body: m[2] };
}

export function check(files, read) {
  const errors = []; const notes = [];
  const fm = frontmatter(read('SKILL.md'));
  if (!fm) errors.push('SKILL.md: no YAML frontmatter between --- lines');
  else {
    const { fields, bad, body } = fm;
    for (const l of bad) errors.push(`SKILL.md frontmatter: line is not \`key: "string"\` or \`key: [list]\`: ${l}`);
    if (fields.name !== NAME) errors.push(`SKILL.md: name must be "${NAME}" (the folder name), got ${JSON.stringify(fields.name)}`);
    if (!/^[a-z0-9-]{1,64}$/.test(fields.name || '')) errors.push('SKILL.md: name must be lowercase letters, digits and hyphens');
    const d = fields.description || '';
    if (!d) errors.push('SKILL.md: description is missing');
    if (d.length > 1024) errors.push(`SKILL.md: description is ${d.length} characters; keep it under 1024`);
    const sentences = d.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (sentences > 3) errors.push(`SKILL.md: description is ${sentences} sentences; Agensi's format asks for one to three`);
    if (fields.summary && fields.summary.length > 300) errors.push(`SKILL.md: summary is ${fields.summary.length} characters; the Agensi form takes 300`);
    if (body.trim().length < 200) errors.push('SKILL.md: the body has no real instructions');
    if (KONOMI.test(read('SKILL.md'))) errors.push('SKILL.md: the Konomi credit is held off sale packages until Simon decides');
    if (/\bestate\b|karma-didy|\bprime \d|\u03BA|\u25CA/i.test(read('SKILL.md'))) errors.push('SKILL.md: internal wording (estate, karma-didy, prime, the seed mark)');
    if (/\{\{[A-Z_]+\}\}/.test(read('SKILL.md'))) errors.push('SKILL.md: an unfilled {{PLACEHOLDER}}');
    // what SKILL.md tells a buyer about the mutation gate must be what the committed receipt says
    if (existsSync('receipts/witness.json')) {
      const r = JSON.parse(read('receipts/witness.json')).gates.find((g) => g.file === 'kernel.mjs');
      r.kernelSha256 = r.sha256;
      const md = read('SKILL.md').replace(/\s+/g, ' ');
      for (const want of [`made ${r.total} single-operator changes`, `caught ${r.killed} of them`, r.kernelSha256]) {
        if (!md.includes(want)) errors.push(`SKILL.md must cite the receipt: "${want}" not found`);
      }
    }
  }
  for (const f of files) {
    if (EXECUTABLE.test(f)) errors.push(`${f}: executables fail Agensi's file-type check`);
    if (!TEXT.test(f.split('/').pop())) errors.push(`${f}: only text files reach buyers (md, mjs, js, json, txt)`);
    if (/node_modules|site-packages/.test(f)) errors.push(`${f}: bundled dependencies are not allowed`);
    const text = read(f);
    for (const re of INJECTION) if (re.test(text)) errors.push(`${f}: phrase Agensi's prompt-injection check fails on: ${re}`);
    if (f.endsWith('.md')) for (const re of PRICE) if (re.test(text)) errors.push(`${f}: a price pattern (${re}); prices go only in Agensi's own price field`);
    if (f.startsWith('scripts/')) {
      for (const [re, kind] of SCRIPT_RISK) {
        if (!re.test(text)) continue;
        if (ALLOW.has(kind)) notes.push(`${f}: uses ${kind} (declared in package.json agensi.allow; the SKILL.md says why)`);
        else errors.push(`${f}: ${kind} pattern ${re}; a verifier script needs none`);
      }
      const logic = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      notes.push(`${f}: ${Buffer.byteLength(text)} bytes, about ${Buffer.byteLength(logic)} without comments (Agensi's review guideline: logic under 20 KB)`);
      if (/\bestate\b|karma-didy|\bprime \d|\u03BA|\u25CA/i.test(text)) errors.push(`${f}: internal wording (estate, karma-didy, prime, the seed mark) in a shipped script`);
      if (KONOMI.test(text)) errors.push(`${f}: the Konomi credit is held off sale packages until Simon decides`);
    }
  }
  if (files.length > 1000) errors.push('more than 1,000 files');
  // The repo's own surfaces: no prices, and the Konomi credit (product-surface rule 2).
  for (const f of ['README.md', 'index.html']) {
    if (!existsSync(f)) continue;
    const prose = read(f).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
    for (const re of PRICE) if (re.test(prose)) errors.push(`${f}: a price pattern (${re}); never pricing on the product`);
    if (!KONOMI.test(prose)) errors.push(`${f}: the Konomi credit is missing`);
  }
  return { errors, notes };
}

// ---- a minimal, deterministic ZIP writer (deflate, fixed 1980-01-01 timestamps) ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(entries) {   // entries: [[path, Buffer]]
  const locals = []; const centrals = []; let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function main() {
  const files = packageFiles();
  const read = (f) => readFileSync(f, 'utf8');
  const { errors, notes } = check(files, read);
  for (const n of notes) console.log(`· ${n}`);
  if (errors.length) { for (const e of errors) console.error(`✗ ${e}`); process.exit(1); }
  console.log(`✓ Agensi package rules: ${files.length} files pass`);
  if (process.argv.includes('--check')) return;
  const entries = files.map((f) => [`${NAME}/${f}`, readFileSync(f)]);
  const out = zip(entries);
  mkdirSync('dist', { recursive: true });
  writeFileSync(`dist/${NAME}.zip`, out);
  console.log(`wrote dist/${NAME}.zip · ${out.length} bytes · sha256 ${createHash('sha256').update(out).digest('hex')}`);
  for (const [p] of entries) console.log(`  ${p}`);
}

main();
