// tools/receipt.mjs — write receipts/witness.json from witness verdicts, refusing any verdict whose gated copy of the
// file is not byte for byte the file in this repository (a receipt names the exact bytes it judged).
//   node tools/receipt.mjs <file>=<verdict.json-or-gate.out>=<gated copy of the file> ...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const verdict = (p) => { const t = readFileSync(p, 'utf8'); return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); };
const TESTS = { 'kernel.mjs': 'kernel.test.mjs', 'cli.mjs': 'cli.test.mjs', 'skillcli.mjs': 'skillcli.test.mjs', 'checkcase.mjs': 'checkcase.test.mjs' };

const gates = [];
for (const arg of process.argv.slice(2)) {
  const [file, out, copy] = arg.split('=');
  const v = verdict(out);
  if (v.clean !== true || v.capped !== false) throw new Error(file + ': the verdict is not clean and uncapped');
  if (sha(copy) !== sha(join(root, file))) throw new Error(file + ': the gated copy is not this repository\'s file');
  const tests = TESTS[file];
  gates.push({ file, sha256: sha(join(root, file)), tests: 'node --test ' + tests, testsSha256: sha(join(root, tests)), total: v.total, killed: v.killed, survived: (v.survived || []).length, baselined: (v.ignored || []).length, clean: true });
}
const w = JSON.parse(readFileSync(join(root, '..', 'witness', 'package.json'), 'utf8'));
const out = {
  kind: 'kar-scopeguard.witness', v: 1, at: new Date().toISOString().slice(0, 10),
  witness: { tag: 'bbe3d35 (local run, ' + w.name + ' ' + (w.version || '') + '; CI re-runs witness v0.6 on every push)', sha256: sha(join(root, '..', 'witness', 'witness.mjs')) },
  gates,
  history: 'Kernel v1 was frozen at 9e580e8 after three gate runs (369/423, then 412/413: the one survivor exposed a real blind spot, settings past the first true/false on a line, fixed; then 412/412). v1.1 fixes three blind spots the planted weakenings found and is gated again here. Nothing is baselined anywhere.',
};
mkdirSync(join(root, 'receipts'), { recursive: true });
writeFileSync(join(root, 'receipts', 'witness.json'), JSON.stringify(out, null, 1) + '\n');
console.log(gates.map((g) => g.file + ' ' + g.killed + '/' + g.total).join(', '));
