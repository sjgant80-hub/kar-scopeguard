// node genome/tombstone.mjs apply|restore — the reversible shed. apply keeps this part's exact seed.json (and any
// TOMBSTONE.md) in .tombstone/, marks the part tombstoned and writes TOMBSTONE.md; restore puts the exact bytes back.
// Nothing is deleted. Archiving the repository itself stays a signed human step in the metabolism.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './io.mjs';
const at = (...p) => join(ROOT, ...p);
const cmd = process.argv[2];
if (cmd === 'apply') {
  if (existsSync(at('.tombstone'))) { console.error('already tombstoned'); process.exit(1); }
  mkdirSync(at('.tombstone'));
  copyFileSync(at('seed.json'), at('.tombstone', 'seed.json'));
  if (existsSync(at('TOMBSTONE.md'))) copyFileSync(at('TOMBSTONE.md'), at('.tombstone', 'TOMBSTONE.md'));
  const s = JSON.parse(readFileSync(at('seed.json'), 'utf8'));
  s.state = 'tombstoned';
  writeFileSync(at('seed.json'), JSON.stringify(s, null, 2) + '\n');
  writeFileSync(at('TOMBSTONE.md'), '# Tombstoned\n\nThis part was shed by its metabolism. Nothing was deleted: `node genome/tombstone.mjs restore` brings it back byte for byte.\n');
  console.log(JSON.stringify({ tombstoned: true }));
} else if (cmd === 'restore') {
  if (!existsSync(at('.tombstone', 'seed.json'))) { console.error('not tombstoned'); process.exit(1); }
  copyFileSync(at('.tombstone', 'seed.json'), at('seed.json'));
  if (existsSync(at('.tombstone', 'TOMBSTONE.md'))) copyFileSync(at('.tombstone', 'TOMBSTONE.md'), at('TOMBSTONE.md'));
  else if (existsSync(at('TOMBSTONE.md'))) rmSync(at('TOMBSTONE.md'));
  rmSync(at('.tombstone'), { recursive: true, force: true });
  console.log(JSON.stringify({ restored: true }));
} else { console.error('usage: node genome/tombstone.mjs apply|restore'); process.exit(2); }
