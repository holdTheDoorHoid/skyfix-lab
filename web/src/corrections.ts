/**
 * CONVENTIONS section 5, ported to TypeScript for the MOCK ADAPTER ONLY.
 *
 * `skyfix-core::corrections` owns the real chain. This exists so the Corrections view
 * has something structurally correct to render before the Rust lands, and so the UI can
 * invert a correction when the mock simulator manufactures a raw sextant reading.
 * When the WASM package is present none of this runs.
 */

import { isStar } from './bodies.js';
import type {
  AltitudeKind,
  CorrectionStep,
  CorrectionBreakdown,
  HorizonMode,
  Observation,
  Session,
  Warning,
} from './types.js';
import { isShoreHorizon } from './types.js';

/** Dip of the sea horizon, arcminutes, for a height of eye in metres. */
export function dipArcmin(heightOfEyeM: number): number {
  return 1.76 * Math.sqrt(Math.max(heightOfEyeM, 0));
}

/**
 * Dip of the sea short of the horizon, arcminutes, for a waterline `distanceNm` away
 * (Bowditch vol. 2 section 402, Table 14): 60 atan(h_ft / (6076.1 d) + d / 8268), as
 * `skyfix_core::corrections::dip_short_arcmin`.
 */
export function dipShortArcmin(heightOfEyeM: number, distanceNm: number): number {
  const hFt = Math.max(heightOfEyeM, 0) / 0.3048;
  return Math.atan(hFt / (6076.1 * distanceNm) + distanceNm / 8268) * (180 / Math.PI) * 60;
}

/** Distance of the sea horizon, NM, where the dip short of the horizon is least. */
export function seaHorizonNm(heightOfEyeM: number): number {
  return Math.sqrt((8268 * Math.max(heightOfEyeM, 0)) / 0.3048 / 6076.1);
}

/** The dip a horizon subtracts, arcminutes (0 without one), as the core's `horizon_dip`. */
export function horizonDipArcmin(horizon: HorizonMode, heightOfEyeM: number): number {
  if (horizon === 'sea') return dipArcmin(heightOfEyeM);
  if (isShoreHorizon(horizon)) {
    const sea = dipArcmin(heightOfEyeM);
    const d = horizon.shore.distance_nm;
    return d >= seaHorizonNm(heightOfEyeM) ? sea : Math.max(dipShortArcmin(heightOfEyeM, d), sea);
  }
  return 0;
}

/** Bennett 1982 refraction, arcminutes, at the given apparent altitude in degrees. */
export function refractionArcmin(haDeg: number, pressureHpa: number, temperatureC: number): number {
  const r = 1 / Math.tan(((haDeg + 7.31 / (haDeg + 4.4)) * Math.PI) / 180);
  return r * (pressureHpa / 1010) * (283 / (273 + temperatureC));
}

/** Which horizon mode applies to one observation. */
export function horizonFor(session: Session, obs: Observation): HorizonMode {
  return obs.horizon ?? session.instrument.horizon;
}

const KIND_ORDER: Record<AltitudeKind, number> = {
  sextant_hs: 0,
  apparent_ha: 1,
  observed_ho: 2,
};

function step(
  kind: CorrectionStep['kind'],
  applied: boolean,
  before: number,
  after: number,
  note: string,
): CorrectionStep {
  return {
    kind,
    applied,
    before_deg: before,
    after_deg: after,
    delta_arcmin: (after - before) * 60,
    note,
  };
}

/**
 * Run the six steps, recording every one — applied or skipped with its reason.
 * Never applies a step that the declared `altitude_kind` says has already run.
 */
export function reduceAltitude(session: Session, obs: Observation): CorrectionBreakdown {
  const horizon = horizonFor(session, obs);
  const star = isStar(obs.body);
  const kind = obs.altitude_kind;
  const past = KIND_ORDER[kind];
  const steps: CorrectionStep[] = [];
  const warnings: Warning[] = [];
  let h = obs.altitude_deg;
  let sigma = obs.sigma_arcmin;

  // 1. Index correction, signed, added.
  if (past === 0) {
    const ic = session.instrument.index_correction_arcmin;
    const after = h + ic / 60;
    steps.push(
      step(
        'index_correction',
        true,
        h,
        after,
        `${ic >= 0 ? '+' : '−'}${Math.abs(ic).toFixed(2)}′ added` +
          (ic < 0 ? ' (index error on the arc)' : ic > 0 ? ' (index error off the arc)' : ''),
      ),
    );
    h = after;
  } else {
    steps.push(
      step('index_correction', false, h, h, `not applied: altitude supplied as ${kind}`),
    );
  }

  // 2a. Dip — natural sea horizon, or a shoreline nearer than it (dip short).
  if (past === 0 && (horizon === 'sea' || isShoreHorizon(horizon))) {
    const dip = horizonDipArcmin(horizon, session.observer.height_of_eye_m);
    const after = h - dip / 60;
    steps.push(
      step(
        'dip',
        true,
        h,
        after,
        isShoreHorizon(horizon)
          ? `dip short of the horizon for a shoreline ${horizon.shore.distance_nm} NM away, ${session.observer.height_of_eye_m.toFixed(1)} m height of eye`
          : `dip for ${session.observer.height_of_eye_m.toFixed(1)} m height of eye, natural sea horizon`,
      ),
    );
    h = after;
  } else {
    const why =
      past !== 0
        ? `not applied: altitude supplied as ${kind}`
        : horizon === 'artificial_reflected'
          ? 'not applied: a reflected artificial horizon has no dip'
          : 'not applied: an electronic local vertical has no dip';
    steps.push(step('dip', false, h, h, why));
    if (past === 0 && horizon !== 'sea') {
      warnings.push({ code: 'dip_not_applicable', id: obs.id, horizon });
    }
  }

  // 2b. Artificial-horizon halving — reflected artificial horizon only.
  if (past === 0 && horizon === 'artificial_reflected') {
    const after = h / 2;
    steps.push(
      step(
        'artificial_horizon_halving',
        true,
        h,
        after,
        'the reading is the double angle; halved after the index correction',
      ),
    );
    h = after;
    sigma = sigma / 2;
  } else {
    steps.push(
      step(
        'artificial_horizon_halving',
        false,
        h,
        h,
        past !== 0
          ? `not applied: altitude supplied as ${kind}`
          : 'not applied: the reading is a single angle for this horizon mode',
      ),
    );
  }

  const haDeg = h;

  // 3. Refraction, subtracted.
  if (past <= 1) {
    const r = refractionArcmin(haDeg, session.observer.pressure_hpa, session.observer.temperature_c);
    const after = h - r / 60;
    steps.push(
      step(
        'refraction',
        true,
        h,
        after,
        `Bennett 1982 at ${session.observer.pressure_hpa.toFixed(0)} hPa, ${session.observer.temperature_c.toFixed(0)} °C`,
      ),
    );
    h = after;
    if (haDeg < 10) {
      const added = haDeg < 5 ? 1.0 : 0;
      if (added > 0) sigma = Math.hypot(sigma, added);
      warnings.push({
        code: 'low_altitude_refraction',
        id: obs.id,
        apparent_altitude_deg: haDeg,
        sigma_added_arcmin: added,
      });
    }
  } else {
    steps.push(step('refraction', false, h, h, `not applied: altitude supplied as ${kind}`));
  }

  // 4. Semidiameter — Sun only.
  if (past <= 1 && !star && obs.limb !== 'center') {
    const sd = obs.geocentric?.semidiameter_arcmin ?? 0;
    const signed = obs.limb === 'lower' ? sd : -sd;
    const after = h + signed / 60;
    steps.push(
      step('semidiameter', true, h, after, `${obs.limb} limb, semidiameter ${sd.toFixed(2)}′`),
    );
    h = after;
  } else {
    const why = star
      ? 'not applied: a star has no measurable disc'
      : past > 1
        ? `not applied: altitude supplied as ${kind}`
        : 'not applied: the centre of the disc was observed';
    steps.push(step('semidiameter', false, h, h, why));
    if (star && obs.limb !== 'center') {
      warnings.push({ code: 'limb_ignored_for_star', id: obs.id });
    }
  }

  // 5. Parallax in altitude — Sun only.
  if (past <= 1 && !star) {
    const hp = obs.geocentric?.horizontal_parallax_arcmin ?? 0;
    const pa = hp * Math.cos((haDeg * Math.PI) / 180);
    const after = h + pa / 60;
    steps.push(
      step('parallax', true, h, after, `horizontal parallax ${hp.toFixed(3)}′ × cos(Ha)`),
    );
    h = after;
  } else {
    steps.push(
      step(
        'parallax',
        false,
        h,
        h,
        star
          ? 'not applied: stellar parallax in altitude is zero at this precision'
          : `not applied: altitude supplied as ${kind}`,
      ),
    );
  }

  if (past === 2) {
    warnings.push({
      code: 'already_corrected',
      id: obs.id,
      kind,
      ignored: ['refraction', 'semidiameter', 'parallax'],
    });
  }

  return {
    input_kind: kind,
    input_deg: obs.altitude_deg,
    steps,
    ho_deg: h,
    sigma_ho_arcmin: sigma,
    warnings,
  };
}

/**
 * Invert the chain: the raw sextant reading that reduces to `hoDeg`.
 * Used only by the mock simulator to manufacture believable `sextant_hs` records.
 * Refraction is evaluated at Ho rather than Ha (under 0.03′ above 15° altitude).
 */
export function inverseToSextantReading(
  session: Session,
  hoDeg: number,
  horizon: HorizonMode,
): number {
  const r = refractionArcmin(hoDeg, session.observer.pressure_hpa, session.observer.temperature_c);
  let ha = hoDeg + r / 60;
  if (horizon === 'artificial_reflected') ha = ha * 2;
  const dip = horizonDipArcmin(horizon, session.observer.height_of_eye_m);
  return ha + dip / 60 - session.instrument.index_correction_arcmin / 60;
}
