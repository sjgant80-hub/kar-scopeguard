// node genome/act.mjs < input.json → {"output":<the work>} or {"status":"refused","why":"..."}; exits 0 only with an output.
// The part's real work, as the guard (bin/genome-run.mjs) calls it: only after its lane check took the input, and
// before its judge checks what it made. An act() that returns nothing refuses.
import * as cell from './cell.mjs';
import { input, say } from './io.mjs';
let out = { status: 'refused', why: 'cell.mjs has no act(): this part checks work, it does not do it' };
if (typeof cell.act === 'function') {
  try {
    const v = await cell.act(input());
    out = v === undefined ? { status: 'refused', why: 'act() returned nothing' } : { output: v };
  } catch (e) { out = { status: 'refused', why: 'act() threw: ' + (e && e.message) }; }
}
say(out);
process.exit(out.status === 'refused' ? 1 : 0);
