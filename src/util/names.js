// Company-name normalisation used for matching NHQB <-> Companies House <-> Gazette.
const SUFFIX_MAP = [
  [/\bLTD\b\.?/g, 'LIMITED'],
  [/\bL\.?T\.?D\b\.?/g, 'LIMITED'],
  [/\bPLC\b\.?/g, 'PLC'],
  [/\bP\.?L\.?C\b\.?/g, 'PLC'],
  [/\bLLP\b\.?/g, 'LLP'],
  [/\bCO\b\.?/g, 'COMPANY'],
  [/\bAND\b/g, '&'],
];

export function normaliseName(name = '') {
  let s = String(name).toUpperCase();
  s = s.replace(/[’'`]/g, '');
  s = s.replace(/[^A-Z0-9&() ]+/g, ' ');
  for (const [re, rep] of SUFFIX_MAP) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Strip legal-form suffixes so "BARRATT HOMES LIMITED" ~ "BARRATT HOMES". */
export function coreName(name = '') {
  return normaliseName(name)
    .replace(/\b(LIMITED|PLC|LLP|LIMITED LIABILITY PARTNERSHIP|COMMUNITY INTEREST COMPANY|CIC|UK|\(UK\))\b/g, '')
    .replace(/\bTHE\b/g, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameCompanyName(a, b) {
  const na = normaliseName(a), nb = normaliseName(b);
  if (na && na === nb) return 1;
  const ca = coreName(a), cb = coreName(b);
  if (ca && ca === cb) return 0.9;
  if (ca && cb && (ca.startsWith(cb + ' ') || cb.startsWith(ca + ' '))) return 0.6;
  return 0;
}
