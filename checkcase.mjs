// checkcase.mjs — the cost case on a Kar verifier's page: what it costs a team today to check one item by hand
// (open it, compare it, ask, chase), against running the verifier, which answers in seconds with a receipt.
//
// The only external figures are read from the vendored, sourced basis (vendor/sovereign-enterprise/data/basis.json,
// byte for byte from sjgant80-hub/sovereign-enterprise): the UK median hourly wage and CPI. The item counts, the
// minutes, the share of the check the verifier takes over and any tool the team pays for today are the reader's own.
// Floors, never top ends: staff time at the median wage with on-costs left out. No price of ours appears: the verifier
// is MIT; support, where a team wants it, is agreed per deployment and is not in this case.
//
// Pure, total, deterministic: garbage in gives { ok: false, why }, never a throw.

export const DEFAULTS = Object.freeze({ itemsPerWeek: 50, minutesPerCheck: 5, share: 0.8, secondsPerCheck: 5, toolPerMonth: 0, years: 3 });
export const BASIS_KEYS = Object.freeze(['wageMedianHourly', 'cpi']);
export const WEEKS_PER_YEAR = 52;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const r2 = (x) => Math.round(x * 100) / 100;

/** the two basis figures the case reads, each a sourced number; null when one is missing or unreadable */
export function figures(basis) {
  try {
    const out = { wage: basis.wageMedianHourly.value, cpi: basis.cpi.value };
    return isNum(out.wage) && isNum(out.cpi) ? out : null;
  } catch { return null; }
}

/** where each figure came from, for the page to list beside the numbers */
export function sourcesOf(basis) {
  try { return BASIS_KEYS.map((k) => ({ key: k, value: basis[k].value, unit: basis[k].unit || '', what: basis[k].what, source: basis[k].source })); } catch { return []; }
}

/**
 * the case. inputs (all the reader's own): itemsPerWeek checked by hand today, minutesPerCheck for one, share (0 to 1)
 * of that checking the verifier takes over, secondsPerCheck to run it and read the verdict, toolPerMonth paid today for
 * any tool it would replace, years (1 to 10).
 */
export function checkCase(input, basis) {
  try {
    const f = figures(basis);
    if (!f) return { ok: false, why: 'the sourced basis could not be read' };
    const x = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
    for (const k of ['itemsPerWeek', 'minutesPerCheck', 'secondsPerCheck', 'toolPerMonth']) {
      if (!isNum(x[k])) return { ok: false, why: k + ' must be a number, 0 or more' };
    }
    if (!isNum(x.share) || x.share > 1) return { ok: false, why: 'share must be from 0 to 1' };
    if (!Number.isInteger(x.years) || x.years < 1 || x.years > 10) return { ok: false, why: 'years must be a whole number from 1 to 10' };

    const itemsPerYear = x.itemsPerWeek * WEEKS_PER_YEAR;
    const hoursToday = itemsPerYear * x.minutesPerCheck / 60;
    // with proofs: the share the proof covers costs seconds; the rest is still checked by hand
    const hoursWith = itemsPerYear * (x.share * x.secondsPerCheck / 3600 + (1 - x.share) * x.minutesPerCheck / 60);
    const rows = [];
    let todayTotal = 0, withTotal = 0;
    for (let y = 1; y <= x.years; y++) {
      const rise = Math.pow(1 + f.cpi, y - 1);
      const today = (hoursToday * f.wage + x.toolPerMonth * 12) * rise;
      const withTool = hoursWith * f.wage * rise;
      todayTotal += today;
      withTotal += withTool;
      rows.push({ year: y, today: r2(today), withTool: r2(withTool), saved: r2(today - withTool) });
    }
    return {
      ok: true,
      inputs: x,
      basis: f,
      hoursPerYear: { today: r2(hoursToday), withTool: r2(hoursWith), saved: r2(hoursToday - hoursWith) },
      // one check in year one, in pounds: by hand at the median wage, and the seconds the tool takes to run and read
      perCheck: { byHand: r2(x.minutesPerCheck / 60 * f.wage), withTool: r2(x.secondsPerCheck / 3600 * f.wage) },
      rows,
      total: { today: r2(todayTotal), withTool: r2(withTotal), saved: r2(todayTotal - withTotal) },
    };
  } catch {
    return { ok: false, why: 'the inputs could not be read' };
  }
}

export default { DEFAULTS, BASIS_KEYS, WEEKS_PER_YEAR, figures, sourcesOf, checkCase };
