// node genome/judge.mjs < case.json → {"status":"verified"|"unverified"|"refused"}; exits 0 only when verified
import { judge } from './cell.mjs';
import { input, say } from './io.mjs';
const STATUSES = ['verified', 'unverified', 'refused'];
let status = 'refused', why = '';
try {
  const s = await judge(input());
  if (STATUSES.includes(s)) status = s; else why = 'the judge returned no status';
} catch (e) { why = 'the judge threw: ' + (e && e.message); }
say(why ? { status, why } : { status });
process.exit(status === 'verified' ? 0 : 1);
