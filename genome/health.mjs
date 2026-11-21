// node genome/health.mjs → {"used","passing","dependedOn","lastEarned"}: passing = the judge still tells good from bad
import { judge, health } from './cell.mjs';
import { say, seed } from './io.mjs';
const s = seed();
let passing = false;
try { passing = (await judge(s.judge.cases.good)) === 'verified' && (await judge(s.judge.cases.bad)) !== 'verified'; } catch { passing = false; }
let h = {};
try { h = (await health()) || {}; } catch { h = {}; }
const flag = (v) => (v === true || v === false ? v : null);
say({ used: flag(h.used), passing, dependedOn: flag(h.dependedOn), lastEarned: typeof h.lastEarned === 'string' ? h.lastEarned : null });
