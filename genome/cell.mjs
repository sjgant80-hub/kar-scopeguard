// cell.mjs — ScopeGuard's three answers for the birth check (seed.json, genome/).
//
// judge  ScopeGuard's own audit (audit in kernel.mjs, the same kernel the page, the command line and the Action run):
//        a change is verified only when the audit finds nothing at all (verdict clean); a high finding or a review
//        finding means it is unverified; a diff or scope the kernel cannot read is refused.
// lane   the kernel's own refusal: the input is in lane when audit can read its diff, and its scope if one is given.
//        An agent's word that the tests pass, with no change attached, is not ScopeGuard's to judge.
import { audit } from '../kernel.mjs';

const run = (input) => audit(input?.diff, input?.scope, input?.claim);

export async function inLane(input) {
  return run(input).ok === true;
}

export async function judge(input) {
  const r = run(input);
  if (r.ok !== true) return 'refused';
  return r.verdict === 'clean' ? 'verified' : 'unverified';
}

// health: ScopeGuard runs in other people's browsers, terminals and CI and sends nothing back, so its use, who
// depends on it and when it last earned its keep cannot be seen from inside the repository: null, said honestly
export async function health() {
  return { used: null, dependedOn: null, lastEarned: null };
}
