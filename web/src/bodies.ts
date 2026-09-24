/**
 * "Sun" + the 57 Nautical Almanac navigational stars in almanac order + "Polaris".
 * Mirrors `skyfix_wasm::BODY_NAMES`; the WASM adapter is authoritative when present.
 */
export const BODY_NAMES: readonly string[] = [
  'Sun',
  'Alpheratz', 'Ankaa', 'Schedar', 'Diphda', 'Achernar', 'Hamal', 'Acamar', 'Menkar',
  'Mirfak', 'Aldebaran', 'Rigel', 'Capella', 'Bellatrix', 'Elnath', 'Alnilam',
  'Betelgeuse', 'Canopus', 'Sirius', 'Adhara', 'Procyon', 'Pollux', 'Avior', 'Suhail',
  'Miaplacidus', 'Alphard', 'Regulus', 'Dubhe', 'Denebola', 'Gienah', 'Acrux', 'Gacrux',
  'Alioth', 'Spica', 'Alkaid', 'Hadar', 'Menkent', 'Arcturus', 'Rigil Kentaurus',
  'Zubenelgenubi', 'Kochab', 'Alphecca', 'Antares', 'Atria', 'Sabik', 'Shaula',
  'Rasalhague', 'Eltanin', 'Kaus Australis', 'Vega', 'Nunki', 'Altair', 'Peacock',
  'Deneb', 'Enif', "Al Na'ir", 'Fomalhaut', 'Markab', 'Polaris',
];

/** Only the Sun has a measurable disc and a usable parallax in this project. */
export function isStar(body: string): boolean {
  return body.trim().toLowerCase() !== 'sun';
}
