/**
 * Geometry for the "Up close" insets: how a small patch of sky round the Moon or a planet
 * is laid on the screen, and where points of a globe fall on its disc. OWNER: sky2 agent
 * (expansion Q3). Pure: no DOM, no engine.
 *
 * Sky offsets are (east, north): toward celestial east (position angle 90°) and north
 * (0°), as the engines give them (`DiscPoint.east/north`, `offset_east_arcsec`). An
 * orientation turns them into screen vectors (x right, y down):
 * - **north up**: north up and east to the LEFT — the sky as the eye sees it, and a
 *   refractor or binoculars (which show the sky upright and unmirrored);
 * - **south up**: turned half way round — an astronomical telescope without a diagonal;
 * - **as seen**: the zenith up, turned by the parallactic angle `q` (the position angle
 *   of the zenith at the body, EXPLORER_API `parallactic_angle_deg`) — how the Moon hangs
 *   in the sky over the horizon;
 * - **mirrored** (with any of them): left and right swapped — a telescope with a star
 *   diagonal.
 */

const DEG = Math.PI / 180;

export type UpCloseOrientation = 'seen' | 'north' | 'south';

/** Screen unit vectors (x right, y down) of celestial east and north. */
export interface SkyBasis {
  ex: number;
  ey: number;
  nx: number;
  ny: number;
}

export function skyBasis(mode: UpCloseOrientation, mirror: boolean, parallacticDeg: number | null): SkyBasis {
  let b: SkyBasis;
  if (mode === 'south') b = { ex: 1, ey: 0, nx: 0, ny: 1 };
  else if (mode === 'seen' && parallacticDeg !== null && Number.isFinite(parallacticDeg)) {
    // A position angle θ drawn north-up is (−sin θ, −cos θ); zenith-up it is at θ − q.
    const q = parallacticDeg * DEG;
    b = { nx: Math.sin(q), ny: -Math.cos(q), ex: -Math.cos(q), ey: -Math.sin(q) };
  } else b = { ex: -1, ey: 0, nx: 0, ny: -1 };
  if (mirror) {
    b.ex = -b.ex;
    b.nx = -b.nx;
  }
  return b;
}

/** Screen offset (x right, y down) of a sky offset `(east, north)` in the basis. */
export function toScreen(b: SkyBasis, east: number, north: number): { x: number; y: number } {
  return { x: east * b.ex + north * b.nx, y: east * b.ey + north * b.ny };
}

/** Screen direction of a position angle (north through east), a unit vector. */
export function paDirection(b: SkyBasis, paDeg: number): { x: number; y: number } {
  return toScreen(b, Math.sin(paDeg * DEG), Math.cos(paDeg * DEG));
}

/**
 * Where a point of a globe falls on its disc, orthographically, in disc radii along
 * celestial east and north: the globe seen from above the sub-observer point `(lat0,
 * lon0)` with its north pole at position angle `poleDeg`. `lonEast` says which way the
 * globe's longitudes run on its own surface: true for the Moon (selenographic longitude
 * is east-positive, toward Mare Crisium, which lies on the sky's west side), false for a
 * planetographic west-positive longitude.
 */
export function globePoint(
  latDeg: number,
  lonDeg: number,
  lat0Deg: number,
  lon0Deg: number,
  poleDeg: number,
  lonEast = true,
): { east: number; north: number; visible: boolean } {
  const lat = latDeg * DEG;
  const dl = (lonEast ? lonDeg - lon0Deg : lon0Deg - lonDeg) * DEG;
  const lat0 = lat0Deg * DEG;
  // Toward increasing east longitude on the globe, and toward its north, on the disc.
  const xs = Math.cos(lat) * Math.sin(dl);
  const ys = Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dl);
  const zs = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dl);
  // The globe's north on the sky is at poleDeg; its east (seen from outside) 90° clockwise
  // from it on the sky, i.e. at position angle poleDeg − 90° (Mare Crisium, to the west).
  const p = poleDeg * DEG;
  const nE = Math.sin(p);
  const nN = Math.cos(p);
  const eE = -Math.cos(p);
  const eN = Math.sin(p);
  return { east: xs * eE + ys * nE, north: xs * eN + ys * nN, visible: zs > 0 };
}

/**
 * The lit part of a disc from where the sub-solar point sits on it: the direction of the
 * bright limb (a screen unit vector) and `xt`, where the terminator crosses the bright
 * limb's axis in disc radii (−1 full, 0 half, +1 new: negative gibbous, positive crescent),
 * the same construction as the Sky view's phase disc. `subSolar` is in disc radii along
 * east and north, `facing` whether it is on the visible hemisphere.
 */
export function litRegion(b: SkyBasis, subSolar: { east: number; north: number }, facing: boolean): { dirX: number; dirY: number; xt: number } {
  const s = toScreen(b, subSolar.east, subSolar.north);
  const len = Math.hypot(s.x, s.y);
  const zs = Math.sqrt(Math.max(0, 1 - Math.min(1, subSolar.east ** 2 + subSolar.north ** 2))) * (facing ? 1 : -1);
  if (len < 1e-9) return { dirX: 0, dirY: -1, xt: facing ? -1 : 1 };
  return { dirX: s.x / len, dirY: s.y / len, xt: -zs };
}

/** The illuminated fraction a lit region stands for, `(1 − xt) / 2`. */
export function litFraction(xt: number): number {
  return (1 - xt) / 2;
}

/**
 * A ring of Saturn (or the planet's outline) as the sky shows it: the half nearer the
 * Earth. With the Earth south of the ring plane (`earthLatDeg` < 0, the south face seen)
 * the near half lies on the side of the planet's north pole, and passes in front of the
 * globe's northern half; with the north face seen, the other way. Returns +1 when the
 * near half is toward the pole's position angle, −1 when away from it.
 */
export function nearSide(earthLatDeg: number): 1 | -1 {
  return earthLatDeg < 0 ? 1 : -1;
}

/**
 * Libration in words, as the Selected card says it (panel/moon-tools.ts): selenographic
 * east is the Mare Crisium side (IAU), which is the Moon's edge toward the sky's west.
 */
export function librationWords(lonDeg: number, latDeg: number): string {
  if (Math.hypot(lonDeg, latDeg) < 0.5) return 'It faces us almost squarely: little libration now.';
  const parts: string[] = [];
  if (Math.abs(lonDeg) >= 0.1) {
    parts.push(`more of its ${lonDeg > 0 ? 'eastern edge (the Mare Crisium side)' : 'western edge (the Grimaldi side)'}, by ${Math.abs(lonDeg).toFixed(1)}°`);
  }
  if (Math.abs(latDeg) >= 0.1) parts.push(`${parts.length ? 'and' : 'more'} of its ${latDeg > 0 ? 'north' : 'south'} pole, by ${Math.abs(latDeg).toFixed(1)}°`);
  return `Tipped to show ${parts.join(', ')}.`;
}

// --- verify2: the Galilean moons' accuracy in words -----------------------------------------
/**
 * The years JPL's positions of Jupiter's moons (Horizons, the jup365 satellite ephemeris)
 * cover, against which the engine's `accuracy_arcsec` is measured (satellites.rs
 * `accuracy_arcsec_at`). Outside them the engine's figure is an extrapolation.
 */
export const GALILEAN_MEASURED_YEARS = [1600, 2200] as const;

/**
 * The Galilean moons' accuracy for the up-close note: "within 0.5″ of JPL" where it was
 * measured, and said to be an estimate outside `GALILEAN_MEASURED_YEARS` (verify2: the note
 * said "within 3.0″ of JPL" for dates no JPL ephemeris of the moons reaches).
 */
export function galileanAccuracyWords(accuracyArcsec: number, jdUtc: number): string {
  const year = 2000 + (jdUtc - 2_451_545) / 365.25;
  const [first, last] = GALILEAN_MEASURED_YEARS;
  const x = `${accuracyArcsec.toFixed(1)}″`;
  return year >= first && year <= last
    ? `within ${x} of JPL`
    : `to about ${x}, an estimate (JPL’s positions of the moons, the yardstick, cover only ${first} to ${last})`;
}
