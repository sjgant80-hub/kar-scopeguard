// io.mjs — shared plumbing for the genome hooks: this part's seed.json and the one line of JSON on stdin.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const seed = () => JSON.parse(readFileSync(new URL('../seed.json', import.meta.url), 'utf8'));
export function input() {
  try { const s = readFileSync(0, 'utf8').trim(); return s ? JSON.parse(s) : null; } catch { return null; }
}
export const say = (o) => console.log(JSON.stringify(o));
