/**
 * Search keys for place names: accents, case and punctuation removed, so "São Paulo",
 * "sao paulo" and "SAO-PAULO" are the same key. OWNER: map-data agent.
 *
 * Must stay in step with `foldName` in tools/mapdata/build.mjs, which uses the same rules to
 * decide which alternative names are worth shipping.
 */

/** Letters that do not decompose into a base letter plus accents. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ǿ: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_LETTERS).join('')}]`, 'g');

/** "Saint-Étienne" -> "saint etienne"; "Łódź" -> "lodz"; "N'Djamena" -> "n djamena". */
export function foldName(text: string): string {
  // Most names are plain ASCII: skip the Unicode work for them.
  if (!/[^\x00-\x7f]/.test(text)) return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const s = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(SPECIAL_RE, (c) => SPECIAL_LETTERS[c] ?? c);
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The folded key without spaces: "new york" and "newyork" both become "newyork". */
export function squash(folded: string): string {
  return folded.replace(/ /g, '');
}

/** Common short forms, expanded on both the query and the names ("St Louis" = "Saint Louis"). */
const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['st', 'saint'],
  ['ste', 'sainte'],
  ['mt', 'mount'],
  ['ft', 'fort'],
  ['pt', 'port'],
]);

export function expandAbbreviations(folded: string): string {
  if (!folded) return folded;
  return folded
    .split(' ')
    .map((w) => ABBREVIATIONS.get(w) ?? w)
    .join(' ');
}

/**
 * Levenshtein distance, giving up (returning `max + 1`) as soon as it must exceed `max`.
 * Used for typo-tolerant search on short strings only.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? max + 1;
}
