// node genome/lane.mjs < sample.json → {"inLane":true} or {"inLane":false,"status":"refused","escalate":"<who>"}
import { inLane } from './cell.mjs';
import { input, say, seed } from './io.mjs';
let ok = false;
try { ok = (await inLane(input())) === true; } catch { ok = false; }
say(ok ? { inLane: true } : { inLane: false, status: 'refused', escalate: seed().boundary.escalate });
