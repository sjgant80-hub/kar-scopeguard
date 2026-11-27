// scope.mjs — rules() and scope() from house-standard/scripts/retrofit.mjs (commit a249bef), copied verbatim so this
// repository builds its page with no outside path. scope(css): the old page's own styles, kept for its own content
// only — every rule sits under .legacy, the old colours become .legacy's own (its dark theme last, so it wins: the
// house is dark only), and the rules for parts the house now provides (page, header, hero, footer) go.
// rules(css) → each top-level rule of a style sheet on a line of its own, however the sheet was laid out
export function rules(css) {
  const out = []; let depth = 0, cur = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    cur += ch === '\n' || ch === '\r' ? ' ' : ch;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { out.push(cur.replace(/\s+/g, ' ').replace(/\s*\{\s*/g, '{').replace(/\s*\}\s*/g, '}').trim()); cur = ''; } }
  }
  return out;
}
export function scope(css) {
  const out = [], gone = /^(\*|html|body|main|header|footer|nav|:root|#gem|\.top|\.hero|\.mark|section\.panel|h1)([\s{>,:. ]|$)/;
  const one = (rule) => { const i = rule.indexOf('{'); if (i < 0) return ''; const sels = rule.slice(0, i).split(',').map((s) => s.trim()).filter((s) => s && !gone.test(s)); return sels.length ? `${sels.map((s) => (s.startsWith('#') ? s : `.legacy ${s}`)).join(',')}${rule.slice(i)}` : ''; };
  for (const line of rules(css)) {
    // the house is committed dark: where the old page had a dark theme of its own, those are its colours now
    if (/^:root\[data-theme="?dark"?\]\{/.test(line)) { out.push(`.legacy{${line.slice(line.indexOf('{') + 1, -1).replace(/color-scheme:[^;}]+;?/, '')}}`); continue; }
    if (line.startsWith('@font-face') || line.startsWith(':root[')) continue;        // the faces are the kit's
    if (line.startsWith(':root{')) { out.push(`.legacy{${line.slice(6, -1).replace(/color-scheme:[^;}]+;?/, '')}}`); continue; }
    if (line.startsWith(':root')) continue;                                             // a theme switch: the house is committed dark
    if (line.startsWith('@media')) { const i = line.indexOf('{'), inner = line.slice(i + 1, -1).split('}').filter((r) => r.trim()).map((r) => one(`${r}}`)).filter(Boolean).join(''); if (inner) out.push(`${line.slice(0, i)}{${inner}}`); continue; }
    if (line.startsWith('@')) { out.push(line); continue; }
    const r = one(line); if (r) out.push(r);
  }
  return out.join('\n');
}
