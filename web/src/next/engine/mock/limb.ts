/**
 * MOCK lunar limb (eclipselimb agent, P12) for developing the interface only: a synthetic
 * profile of a few smooth hills and valleys, the Moon at its mean distance, no libration.
 * Every number is illustrative. The shapes, units and errors are the real engine's
 * (EXPLORER_API "Expansion programme P12 — the lunar limb", `skyfix_wasm::limb`).
 */

import { isoUtc } from '../../time.js';
import type { LimbEngine, LimbPackInfo, LimbProfile, Observer } from '../types.js';

const STEP_DEG = 1 / 16;
const BINS = 5760;
const ARCSEC_PER_RAD = 648000 / Math.PI;
const MEAN_DISTANCE_KM = 384400;
const REFERENCE_RADIUS_KM = 1737.4;

export interface MockLimbOptions {
  /** Answer as if the lunar-limb pack were loaded (default true). */
  loaded?: boolean;
}

/** Heights of the synthetic limb, arcseconds, at position angle `psi` degrees. */
export function mockLimbHeightArcsec(psiDeg: number): number {
  const r = (psiDeg * Math.PI) / 180;
  return 1.1 * Math.sin(3 * r + 0.4) + 0.6 * Math.sin(11 * r + 1.3) + 0.25 * Math.sin(37 * r);
}

export class MockLimb implements LimbEngine {
  private loaded: boolean;

  constructor(options: MockLimbOptions = {}) {
    this.loaded = options.loaded ?? true;
  }

  /** `loadPack('lunar-limb', …)`: the synthetic limb answers from then on. */
  install(): void {
    this.loaded = true;
  }

  lunarLimbProfile(observer: Observer, jdUtc: number): LimbProfile {
    if (!this.loaded) {
      throw new Error('pack_not_loaded: the lunar limb profile needs the lunar-limb pack (LRO LOLA topography), which is not loaded');
    }
    if (!Number.isFinite(jdUtc)) throw new Error('jd_utc must be a finite Julian date');
    void observer; // no parallax, no libration: the same limb for everyone
    const reference = Math.asin(REFERENCE_RADIUS_KM / MEAN_DISTANCE_KM) * ARCSEC_PER_RAD;
    const heights: (number | null)[] = [];
    for (let k = 0; k < BINS; k += 1) heights.push(Math.round(mockLimbHeightArcsec(k * STEP_DEG) * 1000) / 1000);
    return {
      jd_utc: jdUtc,
      utc: isoUtc(jdUtc),
      start_deg: 0,
      step_deg: STEP_DEG,
      height_arcsec: heights,
      reference_radius_km: REFERENCE_RADIUS_KM,
      reference_radius_arcsec: Math.round(reference * 1000) / 1000,
      mean_limb_k1_arcsec: 0.3,
      mean_limb_k2_arcsec: -0.42,
      sun_radius_arcsec: 959.6,
      sun_offset_east_arcsec: 0,
      sun_offset_north_arcsec: 0,
      axis_position_angle_deg: 0,
      parallactic_angle_deg: 0,
      libration_lon_deg: 0,
      libration_lat_deg: 0,
      moon_distance_km: MEAN_DISTANCE_KM,
      ring_truncated: false,
    };
  }

  lunarLimbInfo(): LimbPackInfo | null {
    if (!this.loaded) return null;
    return {
      name: 'lunar-limb',
      version: 'mock',
      source: 'synthetic (mock engine): not lunar topography',
      step_deg: STEP_DEG,
      resolution_km: 1.896,
      reference_radius_km: REFERENCE_RADIUS_KM,
      delta_min_deg: -12,
      delta_max_deg: 12,
      min_height_m: -7305,
      max_height_m: 6905,
    };
  }
}
