/**
 * MOCK deep sky — for developing the interface only, like the rest of the mock engine.
 * Every number is illustrative: 24 showpiece objects and 7 showers instead of the real
 * tables, low-precision positions (precession only), a Milky Way made of two bands of
 * galactic latitude, and the ranking rules of the real engine applied roughly. The shapes,
 * ranges, units and failure modes are the contract's (EXPLORER_API.md, "Expansion
 * programme — deep sky"; types.ts `DeepSkyEngine`).
 */

import { isoUtc } from '../../time.js';
import type {
  CompassPoint,
  DarkWindow,
  DeepSkyEngine,
  DeepSkyInstant,
  DeepSkySighting,
  Dso,
  DsoCatalog,
  DsoInstrument,
  DsoListOptions,
  DsoPositions,
  DsoTonight,
  DsoType,
  DsoVisibility,
  ExplorerEngine,
  ExtinctionTable,
  MeteorShower,
  MilkyWayOutline,
  MoonNight,
  NightSummary,
  Observer,
  SearchHit,
  SearchResult,
  ShowerNight,
  ShowerYear,
  SkyConditions,
  SkyConditionsInput,
  SunNight,
  Tonight,
  TonightOptions,
} from '../types.js';
import * as A from './astro.js';

type Host = Pick<ExplorerEngine, 'skyState' | 'dayEvents' | 'starfieldCatalog' | 'starfieldApparent'>;

const CATEGORY: Record<DsoType, Dso['category']> = {
  open_cluster: 'cluster',
  globular_cluster: 'cluster',
  cluster_with_nebula: 'cluster',
  planetary_nebula: 'nebula',
  emission_nebula: 'nebula',
  reflection_nebula: 'nebula',
  supernova_remnant: 'nebula',
  spiral_galaxy: 'galaxy',
  elliptical_galaxy: 'galaxy',
  lenticular_galaxy: 'galaxy',
  irregular_galaxy: 'galaxy',
  double_star: 'other',
  asterism: 'other',
  star_cloud: 'other',
};

type Row = [string, string | null, DsoType, string, number, number, number | null, number, number, string, string[]];
/** id, name, type, constellation, ra, dec (J2000), V, major, minor, description, cross ids. */
const ROWS: Row[] = [
  ['M31', 'Andromeda Galaxy', 'spiral_galaxy', 'And', 10.6848, 41.2691, 3.4, 200, 71, 'The nearest large galaxy (mock)', ['NGC 224']],
  ['M42', 'Orion Nebula', 'emission_nebula', 'Ori', 83.8221, -5.3911, 4.0, 66, 66, 'A star-forming nebula (mock)', ['NGC 1976']],
  ['M45', 'Pleiades', 'open_cluster', 'Tau', 56.6008, 24.1139, 1.6, 110, 110, 'The Seven Sisters (mock)', []],
  ['M13', 'Hercules Cluster', 'globular_cluster', 'Her', 250.4235, 36.4613, 5.8, 33, 33, 'A globular cluster (mock)', ['NGC 6205']],
  ['M57', 'Ring Nebula', 'planetary_nebula', 'Lyr', 283.3963, 33.0292, 8.8, 1.2, 1.1, 'A planetary nebula (mock)', ['NGC 6720']],
  ['M27', 'Dumbbell Nebula', 'planetary_nebula', 'Vul', 299.9016, 22.7212, 7.5, 6.7, 5.7, 'A planetary nebula (mock)', ['NGC 6853']],
  ['M8', 'Lagoon Nebula', 'emission_nebula', 'Sgr', 270.9042, -24.3867, 6.0, 90, 40, 'A nebula in Sagittarius (mock)', ['NGC 6523']],
  ['M51', 'Whirlpool Galaxy', 'spiral_galaxy', 'CVn', 202.4696, 47.1952, 8.4, 9, 7.6, 'A spiral galaxy (mock)', ['NGC 5194']],
  ['M81', "Bode's Galaxy", 'spiral_galaxy', 'UMa', 148.8882, 69.0653, 6.9, 21, 10, 'A spiral galaxy (mock)', ['NGC 3031']],
  ['M44', 'Beehive Cluster', 'open_cluster', 'Cnc', 130.1, 19.67, 3.1, 95, 95, 'An open cluster (mock)', ['NGC 2632']],
  ['M11', 'Wild Duck Cluster', 'open_cluster', 'Sct', 282.7708, -6.27, 5.8, 14, 14, 'An open cluster (mock)', ['NGC 6705']],
  ['M22', null, 'globular_cluster', 'Sgr', 279.0998, -23.9048, 5.1, 24, 24, 'A globular cluster (mock)', ['NGC 6656']],
  ['NGC5139', 'Omega Centauri', 'globular_cluster', 'Cen', 201.697, -47.4795, 3.7, 36, 36, 'The largest globular (mock)', []],
  ['NGC104', '47 Tucanae', 'globular_cluster', 'Tuc', 6.0236, -72.0813, 4.0, 44, 44, 'A bright globular (mock)', []],
  ['LMC', 'Large Magellanic Cloud', 'irregular_galaxy', 'Dor', 80.8942, -69.7561, 0.4, 320, 270, 'A satellite galaxy (mock)', []],
  ['SMC', 'Small Magellanic Cloud', 'irregular_galaxy', 'Tuc', 13.1867, -72.8286, 2.3, 160, 90, 'A satellite galaxy (mock)', ['NGC 292']],
  ['NGC869', 'Double Cluster (h Persei)', 'open_cluster', 'Per', 34.75, 57.1283, 3.7, 16, 16, 'Half of the Double Cluster (mock)', []],
  ['NGC884', 'Double Cluster (Chi Persei)', 'open_cluster', 'Per', 35.5958, 57.125, 3.8, 15, 15, 'Half of the Double Cluster (mock)', []],
  ['M1', 'Crab Nebula', 'supernova_remnant', 'Tau', 83.6331, 22.0145, 8.4, 7, 5, 'A supernova remnant (mock)', ['NGC 1952']],
  ['M104', 'Sombrero Galaxy', 'spiral_galaxy', 'Vir', 189.9976, -11.6231, 8.0, 8.5, 4.9, 'A spiral galaxy (mock)', ['NGC 4594']],
  ['M33', 'Triangulum Galaxy', 'spiral_galaxy', 'Tri', 23.4621, 30.6599, 5.7, 60, 35, 'A Local Group galaxy (mock)', ['NGC 598']],
  ['NGC7000', 'North America Nebula', 'emission_nebula', 'Cyg', 314.6875, 44.33, 4.0, 120, 100, 'A large nebula (mock)', []],
  ['Mel25', 'Hyades', 'open_cluster', 'Tau', 66.725, 15.8667, 0.5, 330, 330, 'The nearest open cluster (mock)', []],
  ['M7', 'Ptolemy Cluster', 'open_cluster', 'Sco', 268.4633, -34.7928, 3.3, 100, 100, 'An open cluster (mock)', ['NGC 6475']],
];

const OBJECTS: Dso[] = ROWS.map(([id, name, type, con, ra, dec, v, maj, min, description, cross]) => ({
  id,
  label: id.replace(/^(NGC|IC|Mel|Cr)(\d+)$/, '$1 $2'),
  name,
  type,
  category: CATEGORY[type],
  constellation: con,
  ra_j2000_deg: ra,
  dec_j2000_deg: dec,
  magnitude: v,
  major_arcmin: maj,
  minor_arcmin: min,
  description,
  cross_ids: cross,
}));

type ShowerRow = [number, string, string, number, number, number, number, number, number, number, number, number, number, boolean, string | null];
const SHOWER_ROWS: ShowerRow[] = [
  [10, 'QUA', 'Quadrantids', 276, 283.15, 292, 230, 49, 0.72, -0.25, 41, 2.1, 80, false, '2003 EH1'],
  [6, 'LYR', 'Lyrids', 24, 32.32, 40, 271, 34, 0.8, -0.25, 49, 2.1, 18, false, 'C/1861 G1 (Thatcher)'],
  [31, 'ETA', 'Eta Aquariids', 29, 45.5, 67, 338, -1, 0.71, 0.34, 66, 2.4, 50, false, '1P/Halley'],
  [7, 'PER', 'Perseids', 114, 140, 151, 48, 58, 1.4, 0.21, 59, 2.2, 100, false, '109P/Swift-Tuttle'],
  [8, 'ORI', 'Orionids', 188, 208, 225, 95, 16, 0.78, 0.02, 66, 2.5, 20, false, '1P/Halley'],
  [13, 'LEO', 'Leonids', 223, 235.27, 248, 152, 22, 0.63, -0.39, 71, 2.5, 15, true, '55P/Tempel-Tuttle'],
  [4, 'GEM', 'Geminids', 251, 262.2, 269, 112, 33, 1.1, -0.17, 35, 2.6, 150, false, '(3200) Phaethon'],
];
const SHOWERS: MeteorShower[] = SHOWER_ROWS.map(
  ([iau, code, name, ls, lp, le, ra, dec, dra, ddec, v, r, zhr, variable, parent]) => ({
    iau,
    code,
    name,
    lambda_start_deg: ls,
    lambda_peak_deg: lp,
    lambda_end_deg: le,
    ra_deg: ra,
    dec_deg: dec,
    dra_deg: dra,
    ddec_deg: ddec,
    v_inf_kms: v,
    r,
    zhr,
    variable,
    parent,
  }),
);

const BORTLE_NELM = [7.8, 7.3, 6.8, 6.3, 5.8, 5.3, 4.8, 4.3, 4.0];
const POINTS: CompassPoint[] = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function conditionsOf(c: SkyConditionsInput | undefined): SkyConditions {
  const k = c?.k ?? 0.25;
  if (!(k >= 0.2 && k <= 0.4)) throw new Error(`conditions: k must be between 0.2 and 0.4, got ${k}`);
  let bortle: number | null = null;
  let nelm: number;
  let source: SkyConditions['source'];
  if (c?.nelm != null) {
    if (!(c.nelm >= 1 && c.nelm <= 8)) throw new Error(`conditions: nelm must be between 1 and 8, got ${c.nelm}`);
    nelm = c.nelm;
    bortle = c.bortle ?? null;
    source = 'nelm';
  } else {
    bortle = c?.bortle ?? 5;
    if (!(Number.isInteger(bortle) && bortle >= 1 && bortle <= 9)) {
      throw new Error(`conditions: bortle must be a class from 1 to 9, got ${bortle}`);
    }
    nelm = BORTLE_NELM[bortle - 1]!;
    source = c?.bortle != null ? 'bortle' : 'default';
  }
  const t = 10 ** (1.586 - nelm / 5) - 1;
  const sky = t <= 0 ? 22 : Math.min(22, 21.58 - 5 * Math.log10(t));
  return { bortle, nelm, k, sky_brightness_mpsas: sky, source };
}

function airmass(h: number): number {
  return 1 / Math.sin((h + 244 / (165 + 47 * h ** 1.1)) * A.D2R);
}

function instant(jd: number): DeepSkyInstant {
  return { jd_utc: jd, utc: isoUtc(jd) };
}

/** J2000 to (roughly) of date: precession only (mock). */
function ofDate(ra: number, dec: number, jd: number): { ra_deg: number; dec_deg: number } {
  const m = A.precessionMatrix(A.centuriesTT(jd));
  const { ra_deg, dec_deg } = A.vecToRaDec(A.applyMat(m, A.unitVector(ra, dec)));
  return { ra_deg, dec_deg };
}

function sighting(jd: number, ra: number, dec: number, o: Observer): DeepSkySighting {
  const site = A.makeSite(o.lat_deg, o.lon_deg, o.height_m ?? 0);
  const h = A.horizontal(A.gmstDeg(jd) + o.lon_deg - ra, dec, site);
  const alt = h.alt_deg + A.refractionArcmin(h.alt_deg) / 60;
  return {
    jd_utc: jd,
    utc: isoUtc(jd),
    alt_deg: alt,
    az_deg: h.az_deg,
    direction: POINTS[Math.round(h.az_deg / 22.5) % 16]!,
  };
}

function words(alt: number, az: number): string {
  const where = WORDS[Math.round(az / 45) % 8]!;
  return alt >= 60 ? `high in the ${where}` : alt >= 30 ? `in the ${where}` : `low in the ${where}`;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Solar longitude, roughly J2000 (mock Sun, precession removed). */
function solarLongitude(jd: number): number {
  return A.norm360(A.sunPosition(jd).lon_deg - 1.397 * A.centuriesTT(jd));
}

function instantOfLongitude(lambda: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 6; k += 1) t += A.wrap180(lambda - solarLongitude(t)) / 0.98565;
  return t;
}

export function createMockDeepSky(host: Host): DeepSkyEngine {
  const night = (o: Observer, jd: number): NightSummary => {
    const shift = o.lon_deg / 360;
    let start = Math.floor(jd + shift) - shift;
    if (jd - start > 0.5 && host.skyState(o, jd, ['Sun']).sun_altitude_deg > -0.83) start += 1;
    const end = start + 1;
    const d = host.dayEvents(o, start, end, ['Sun', 'Moon']);
    let best: [number, number] | null = null;
    for (const p of d.phases) {
      if (p.phase === 'night' && (!best || p.jd_end - p.jd_start > best[1] - best[0])) best = [p.jd_start, p.jd_end];
    }
    const darkness: DarkWindow | null = best
      ? { kind: 'night', start: instant(best[0]), end: instant(best[1]), hours: (best[1] - best[0]) * 24 }
      : null;
    const ev = (body: string, kind: string): DeepSkyInstant | null => {
      const e = d.bodies.find((b) => b.body === body)?.events.find((x) => x.kind === kind);
      return e ? instant(e.jd_utc) : null;
    };
    const sun: SunNight = {
      set: ev('Sun', 'set'),
      civil_dusk: ev('Sun', 'civil_dusk'),
      nautical_dusk: ev('Sun', 'nautical_dusk'),
      astronomical_dusk: ev('Sun', 'astronomical_dusk'),
      astronomical_dawn: ev('Sun', 'astronomical_dawn'),
      nautical_dawn: ev('Sun', 'nautical_dawn'),
      civil_dawn: ev('Sun', 'civil_dawn'),
      rise: ev('Sun', 'rise'),
    };
    const mid = best ? (best[0] + best[1]) / 2 : start + 0.5;
    const m = host.skyState(o, mid, ['Moon']).bodies[0];
    const f = m?.illuminated_fraction ?? 0;
    const waxing = A.wrap180((m?.ra_deg ?? 0) - A.sunPosition(mid).ra_deg) > 0;
    const phase: MoonNight['phase'] =
      f < 0.03 ? 'new' : f > 0.97 ? 'full' : f < 0.45 ? (waxing ? 'waxing crescent' : 'waning crescent')
        : f <= 0.55 ? (waxing ? 'first quarter' : 'last quarter') : waxing ? 'waxing gibbous' : 'waning gibbous';
    let up = 0;
    if (best) {
      for (let t = best[0]; t < best[1]; t += 1 / 48) {
        if ((host.skyState(o, t, ['Moon']).bodies[0]?.alt_apparent_deg ?? -1) > 0) up += 0.5;
      }
    }
    const hours = darkness?.hours ?? 0;
    return {
      start: instant(start),
      end: instant(end),
      darkness,
      sun,
      moon: {
        illuminated_fraction: f,
        phase_angle_deg: m?.phase_angle_deg ?? 180,
        phase,
        waxing,
        rise: ev('Moon', 'rise'),
        set: ev('Moon', 'set'),
        up_hours: Math.min(up, hours),
        down_hours: Math.max(0, hours - up),
      },
    };
  };

  const instrumentOf = (d: Dso, lm: number): DsoInstrument => {
    if (d.magnitude === null) return 'camera';
    const m = d.magnitude + 0.75 * Math.log10(Math.max(d.major_arcmin, 1));
    return m <= lm - 0.5 ? 'eye' : m <= lm + 3 ? 'binoculars' : m <= lm + 5 ? 'telescope' : 'camera';
  };

  const bestOver = (ra: number, dec: number, o: Observer, n: NightSummary) => {
    const w = n.darkness;
    if (!w) return { best: null as DeepSkySighting | null, hours: 0 };
    let best: DeepSkySighting | null = null;
    let hours = 0;
    const step = 1 / 144;
    for (let t = w.start.jd_utc; t <= w.end.jd_utc; t += step) {
      const s = sighting(t, ra, dec, o);
      if (!best || s.alt_deg > best.alt_deg) best = s;
      if (s.alt_deg >= 20) hours += step * 24;
    }
    return { best: best && best.alt_deg > 0 ? best : null, hours };
  };

  const showerNight = (s: MeteorShower, o: Observer, n: NightSummary, c: SkyConditions): ShowerNight | null => {
    const w = n.darkness;
    if (!w) return null;
    const mid = (w.start.jd_utc + w.end.jd_utc) / 2;
    const lambda = solarLongitude(mid);
    const d = A.wrap180(lambda - s.lambda_peak_deg);
    const before = A.norm360(s.lambda_peak_deg - s.lambda_start_deg);
    const after = A.norm360(s.lambda_end_deg - s.lambda_peak_deg);
    if (d < -before || d > after) return null;
    const edge = Math.min(2, s.zhr / 2);
    const zhr = s.zhr * 10 ** (-Math.log10(s.zhr / edge) * Math.abs(d) / (d < 0 ? before : after));
    const ra0 = A.norm360(s.ra_deg + s.dra_deg * d);
    const dec0 = s.dec_deg + s.ddec_deg * d;
    const { ra_deg, dec_deg } = ofDate(ra0, dec0, mid);
    const { best, hours } = bestOver(ra_deg, dec_deg, o, n);
    const rate = best ? zhr * Math.sin(best.alt_deg * A.D2R) * s.r ** (c.nelm - 6.5) : 0;
    const days = d / 0.98565;
    const when = Math.abs(days) < 1 ? 'at its peak' : `${Math.round(Math.abs(days))} days ${days < 0 ? 'before' : 'after'} its peak`;
    return {
      code: s.code,
      name: s.name,
      lambda_deg: lambda,
      zhr,
      days_from_peak: days,
      radiant_ra_deg: ra0,
      radiant_dec_deg: dec0,
      best,
      expected_rate_per_hour: rate,
      limiting_mag: best ? c.nelm : null,
      hours_radiant_above_20: hours,
      variable: s.variable,
      reason: `${s.name} ${when}: about ${Math.round(rate)} meteors an hour (mock)`,
    };
  };

  const engine: DeepSkyEngine = {
    dsoCatalog(): DsoCatalog {
      return { objects: OBJECTS, source: 'MOCK: 24 showpiece objects, illustrative only.' };
    },

    dsoList(observer: Observer | null, jdUtc: number, options?: DsoListOptions): DsoPositions {
      if (!Number.isFinite(jdUtc)) throw new Error('jd_utc must be a finite Julian date');
      const index: number[] = [];
      const ra: number[] = [];
      const dec: number[] = [];
      const hz: [number[], number[], number[]] = [[], [], []];
      OBJECTS.forEach((d, i) => {
        const kinds = options?.kinds ?? [];
        if (kinds.length && !kinds.some((k) => k === d.category || k === d.type)) return;
        if (options?.max_magnitude != null && d.magnitude !== null && d.magnitude > options.max_magnitude) return;
        const p = ofDate(d.ra_j2000_deg, d.dec_j2000_deg, jdUtc);
        if (observer) {
          const s = sighting(jdUtc, p.ra_deg, p.dec_deg, observer);
          if (options?.above_horizon && s.alt_deg <= 0) return;
          hz[0].push(s.alt_deg - A.refractionArcmin(s.alt_deg) / 60);
          hz[1].push(s.az_deg);
          hz[2].push(s.alt_deg);
        }
        index.push(i);
        ra.push(p.ra_deg);
        dec.push(p.dec_deg);
      });
      return {
        jd_utc: jdUtc,
        index: Int32Array.from(index),
        ra_deg: Float64Array.from(ra),
        dec_deg: Float64Array.from(dec),
        alt_deg: observer ? Float64Array.from(hz[0]) : null,
        az_deg: observer ? Float64Array.from(hz[1]) : null,
        alt_apparent_deg: observer ? Float64Array.from(hz[2]) : null,
      };
    },

    dsoVisibility(id: string, observer: Observer, jdUtc: number, conditions?: SkyConditionsInput): DsoVisibility {
      const key = id.replace(/\s+/g, '').toLowerCase();
      const d = OBJECTS.find((x) => x.id.toLowerCase() === key || x.cross_ids.some((c) => c.replace(/\s+/g, '').toLowerCase() === key));
      if (!d) throw new Error(`no deep-sky object "${id}"`);
      const c = conditionsOf(conditions);
      const n = night(observer, jdUtc);
      const p = ofDate(d.ra_j2000_deg, d.dec_j2000_deg, n.start.jd_utc + 0.5);
      const { best, hours } = bestOver(p.ra_deg, p.dec_deg, observer, n);
      const lm = best ? c.nelm - c.k * (airmass(Math.max(best.alt_deg, 0)) - 1) : null;
      const track = { jd_utc: [] as number[], alt_deg: [] as number[] };
      for (let k = 0; k <= 144; k += 1) {
        const t = n.start.jd_utc + k / 144;
        track.jd_utc.push(t);
        track.alt_deg.push(sighting(t, p.ra_deg, p.dec_deg, observer).alt_deg);
      }
      return {
        object: d,
        night: n,
        conditions: c,
        visibility: {
          best,
          transit: null,
          hours_above_20: hours,
          moon: best ? { moon_alt_deg: 0, separation_deg: 90, brightening_mag: 0 } : null,
          limiting_mag: lm,
          instrument: lm === null ? null : instrumentOf(d, lm),
        },
        track,
      };
    },

    meteorShowers(year: number, observer?: Observer | null, conditions?: SkyConditionsInput): ShowerYear {
      if (!Number.isInteger(year)) throw new Error(`year must be a whole number, got ${year}`);
      const c = conditionsOf(conditions);
      const jan1 = Date.UTC(year, 0, 1) / 86_400_000 + 2_440_587.5;
      const showers = SHOWERS.map((s) => {
        const peak = instantOfLongitude(s.lambda_peak_deg, jan1 + A.norm360(s.lambda_peak_deg - solarLongitude(jan1)) / 0.98565);
        const start = instantOfLongitude(s.lambda_start_deg, peak - A.norm360(s.lambda_peak_deg - s.lambda_start_deg) / 0.98565);
        const end = instantOfLongitude(s.lambda_end_deg, peak + A.norm360(s.lambda_end_deg - s.lambda_peak_deg) / 0.98565);
        const m = observer ? host.skyState(observer, peak, ['Moon']).bodies[0] : null;
        return {
          shower: s,
          peak: instant(peak),
          start: instant(start),
          end: instant(end),
          moon_illuminated_fraction: m?.illuminated_fraction ?? 0.5,
          at_site: observer ? showerNight(s, observer, night(observer, peak), c) : null,
        };
      }).sort((a, b) => a.peak.jd_utc - b.peak.jd_utc);
      return {
        year,
        showers,
        errors: [],
        source: 'MOCK: 7 showers, illustrative only.',
        rate_model: 'MOCK estimate.',
      };
    },

    milkyWayOutline(): MilkyWayOutline {
      // Two bands of galactic latitude (mock): |b| = 12 and |b| = 5 degrees.
      const g2e = [
        [-0.0548755604162154, 0.4941094278755837, -0.8676661490190047],
        [-0.873437090234885, -0.4448296299600112, -0.1980763734312015],
        [-0.4838350155487132, 0.7469822444972189, 0.4559837761750669],
      ];
      const ring = (b: number, level: number) => {
        const ra: number[] = [];
        const dec: number[] = [];
        for (let l = 0; l <= 360; l += 10) {
          const v = A.unitVector(b > 0 ? 360 - l : l, b);
          const e: A.Vec3 = [0, 1, 2].map((i) => g2e[i]![0]! * v[0] + g2e[i]![1]! * v[1] + g2e[i]![2]! * v[2]) as A.Vec3;
          const p = A.vecToRaDec(e);
          ra.push(p.ra_deg);
          dec.push(p.dec_deg);
        }
        return { level, ra_deg: Float64Array.from(ra), dec_deg: Float64Array.from(dec) };
      };
      return {
        levels: [0.32, 0.5],
        rings: [ring(12, 0), ring(-12, 0), ring(5, 1), ring(-5, 1)],
        source: 'MOCK: two bands of galactic latitude, illustrative only.',
      };
    },

    skySearch(query: string, observer?: Observer | null, jdUtc?: number | null, limit = 20): SearchResult {
      if (observer && jdUtc == null) throw new Error('an observer needs a time (jd_utc) to place the hits');
      const q = fold(query);
      const hits: SearchHit[] = [];
      if (!q) return { query, hits };
      /** `ra`/`dec` are J2000 unless `ofDateAlready` (the star field's apparent places). */
      const add = (kind: SearchHit['kind'], id: string, label: string, detail: string, mag: number | null, ra: number | null, dec: number | null, index: number | null, keys: string[], ofDateAlready = false) => {
        const f = keys.map(fold);
        const score = f.some((k) => k.replace(/ /g, '') === q.replace(/ /g, '')) ? 100 : f.some((k) => k.startsWith(q)) ? 80 : f.some((k) => k.includes(q)) ? 40 : 0;
        if (!score) return;
        let pos: { ra_deg: number | null; dec_deg: number | null; alt: number | null; az: number | null } = { ra_deg: null, dec_deg: null, alt: null, az: null };
        if (jdUtc != null && ra !== null && dec !== null) {
          const p = ofDateAlready ? { ra_deg: ra, dec_deg: dec } : ofDate(ra, dec, jdUtc);
          const s = observer ? sighting(jdUtc, p.ra_deg, p.dec_deg, observer) : null;
          pos = { ...p, alt: s?.alt_deg ?? null, az: s?.az_deg ?? null };
        }
        hits.push({
          kind, id, label, detail, magnitude: mag, index,
          ra_deg: pos.ra_deg, dec_deg: pos.dec_deg,
          alt_deg: pos.alt, az_deg: pos.az, alt_apparent_deg: pos.alt,
          above_horizon: pos.alt === null ? null : pos.alt > 0,
          score,
        });
      };
      OBJECTS.forEach((d) => add('deep_sky', d.id, d.name ?? d.label, `${d.label} · ${d.description}`, d.magnitude, d.ra_j2000_deg, d.dec_j2000_deg, null, [d.id, d.label, ...(d.name ? [d.name] : []), ...d.cross_ids]));
      const cat = host.starfieldCatalog();
      // Stars are placed from the mock star field's own places of date.
      const app = jdUtc != null ? host.starfieldApparent(jdUtc) : null;
      for (const { index, name } of cat.names) {
        const ra = app ? app[2 * index]! * A.R2D : null;
        const dec = app ? app[2 * index + 1]! * A.R2D : null;
        add('star', `HR ${cat.hr[index]}`, name, `HR ${cat.hr[index]} (mock)`, cat.vmag[index] ?? null, ra, dec, index, [name], true);
      }
      for (const c of cat.constellations) add('constellation', c.abbr, c.name, `Constellation · ${c.abbr}`, null, c.label_ra_deg, c.label_dec_deg, null, [c.name, c.abbr]);
      for (const b of ['Sun', 'Moon', ...A.PLANET_NAMES]) {
        add(b === 'Sun' ? 'sun' : b === 'Moon' ? 'moon' : 'planet', b, b, b === 'Sun' || b === 'Moon' ? `The ${b}` : 'Planet', null, null, null, null, [b]);
      }
      SHOWERS.forEach((s) => add('shower', s.code, s.name, `Meteor shower · IAU ${s.iau} ${s.code}`, null, s.ra_deg, s.dec_deg, null, [s.name, s.code, `${s.name} radiant`]));
      hits.sort((a, b) => b.score - a.score || (a.magnitude ?? 9) - (b.magnitude ?? 9));
      return { query, hits: hits.slice(0, Math.max(1, Math.min(100, limit))) };
    },

    tonight(observer: Observer, jdUtc: number, options?: TonightOptions): Tonight {
      if (!Number.isFinite(jdUtc)) throw new Error('jd_utc must be a finite Julian date');
      const c = conditionsOf(options);
      const n = night(observer, jdUtc);
      const deep: DsoTonight[] = [];
      for (const d of OBJECTS) {
        const p = ofDate(d.ra_j2000_deg, d.dec_j2000_deg, n.start.jd_utc + 0.5);
        const { best, hours } = bestOver(p.ra_deg, p.dec_deg, observer, n);
        if (!best || hours <= 0) continue;
        const lm = c.nelm - c.k * (airmass(Math.max(best.alt_deg, 0)) - 1);
        const instrument = instrumentOf(d, lm);
        const base = { eye: 1, binoculars: 0.8, telescope: 0.5, camera: 0.35 }[instrument];
        const score = 100 * base * Math.sin(best.alt_deg * A.D2R) * (0.5 + 0.5 * Math.min(1, hours / 4)) * (d.name ? 1.2 : 1);
        deep.push({
          id: d.id, label: d.label, name: d.name, type: d.type, category: d.category,
          constellation: d.constellation, magnitude: d.magnitude, best, hours_above_20: hours,
          moon: null, instrument, score,
          reason: `${words(best.alt_deg, best.az_deg)} (${Math.round(best.alt_deg)}° at best), mock`,
        });
      }
      deep.sort((a, b) => b.score - a.score);
      const showers = SHOWERS.map((s) => showerNight(s, observer, n, c)).filter((x): x is ShowerNight => x !== null);
      const w = n.darkness;
      return {
        night: n,
        conditions: c,
        planets: [],
        deep_sky: deep.slice(0, Math.max(1, Math.min(60, options?.limit ?? 12))),
        showers,
        milky_way_core: { best: null, hours_above_20: 0, reason: 'MOCK: not computed' },
        summary: w
          ? `Dark from {jd:${w.start.jd_utc.toFixed(6)}} to {jd:${w.end.jd_utc.toFixed(6)}} (mock).`
          : 'The Sun stays too high for a dark sky tonight (mock).',
        notes: ['MOCK engine: every number is illustrative.'],
        errors: [],
      };
    },

    extinction(conditions?: SkyConditionsInput): ExtinctionTable {
      const c = conditionsOf(conditions);
      const alt = Float64Array.from({ length: 91 }, (_, i) => i);
      const x = alt.map((h) => airmass(h));
      return {
        conditions: c,
        alt_deg: alt,
        airmass: x,
        extinction_mag: x.map((v) => c.k * v),
        limiting_mag: x.map((v) => c.nelm - c.k * (v - 1)),
        model: 'MOCK: Pickering air mass, extinction k X.',
      };
    },
  };
  return engine;
}
