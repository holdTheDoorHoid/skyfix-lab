/**
 * "Show in Sky" from the Tonight view, as the Sky view carries it out (sky2 agent): the
 * channel's `take`, each kind of target's plan (targets.ts), and a direction at a moment
 * turned back into a J2000 place — the exact inverse of how the Sky view places one.
 */
import { describe, expect, it } from 'vitest';
import { horizonMatrix, refractionArcmin } from '../../src/next/sky/astro.js';
import { skyTargets, type TimedSkyTarget } from '../../src/next/sky/sky-link.js';
import { j2000OfApparent, planOfTarget } from '../../src/next/sky/targets.js';
import { upCloseSupported } from '../../src/next/sky/upclose.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** A rotation like the star field's ICRS-to-date matrix: Rz(−z) Ry(θ) Rz(−ζ), row-major. */
function precessionLike(zeta: number, theta: number, z: number): Float64Array {
  const rz = (a: number) => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const ry = (a: number) => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
  const mul = (a: number[], b: number[]) => {
    const m = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) m[3 * i + j]! += a[3 * i + k]! * b[3 * k + j]!;
    return m;
  };
  return Float64Array.from(mul(rz(-z), mul(ry(theta), rz(-zeta))));
}

/** How the Sky view places a J2000 direction (view.ts updatePoint and horizonOf): degrees. */
function place(raDeg: number, decDeg: number, hm: ArrayLike<number>, f: ArrayLike<number>, refraction: number): { alt: number; az: number } {
  const c = Math.cos(decDeg * DEG);
  const v = [c * Math.cos(raDeg * DEG), c * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
  const d = [0, 1, 2].map((i) => f[3 * i]! * v[0]! + f[3 * i + 1]! * v[1]! + f[3 * i + 2]! * v[2]!);
  const e = hm[0]! * d[0]! + hm[1]! * d[1]! + hm[2]! * d[2]!;
  const n = hm[3]! * d[0]! + hm[4]! * d[1]! + hm[5]! * d[2]!;
  const u = hm[6]! * d[0]! + hm[7]! * d[1]! + hm[8]! * d[2]!;
  const h = Math.asin(Math.max(-1, Math.min(1, u))) * RAD;
  let az = Math.atan2(e, n) * RAD;
  if (az < 0) az += 360;
  return { alt: h + refractionArcmin(h, refraction) / 60, az };
}

function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = [Math.cos(dec1 * DEG) * Math.cos(ra1 * DEG), Math.cos(dec1 * DEG) * Math.sin(ra1 * DEG), Math.sin(dec1 * DEG)];
  const b = [Math.cos(dec2 * DEG) * Math.cos(ra2 * DEG), Math.cos(dec2 * DEG) * Math.sin(ra2 * DEG), Math.sin(dec2 * DEG)];
  const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  return Math.atan2(Math.hypot(cross[0]!, cross[1]!, cross[2]!), a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) * RAD;
}

describe('the Tonight view’s targets in the Sky view', () => {
  it('lets the Sky view take a waiting target without telling the listeners', () => {
    const store = {};
    const channel = skyTargets({ store } as never);
    const seen: (TimedSkyTarget | null)[] = [];
    const stop = channel.subscribe((t) => seen.push(t));
    channel.set({ kind: 'body', name: 'Saturn', inset: true, jd_utc: 2461308.6 });
    expect(seen).toHaveLength(1);
    expect(channel.take()).toEqual({ kind: 'body', name: 'Saturn', inset: true, jd_utc: 2461308.6 });
    expect(channel.get()).toBeNull();
    expect(channel.take()).toBeNull();
    expect(seen).toHaveLength(1);
    stop();
  });

  it('plans each kind: a body and its close-up, a deep-sky object, a radiant, a direction', () => {
    const moon = planOfTarget({ kind: 'body', name: 'Moon', inset: true, jd_utc: null }, upCloseSupported);
    expect(moon).toEqual({ show: { kind: 'body', id: 'Moon' }, fallback: null, direction: null, upClose: 'Moon' });
    expect(planOfTarget({ kind: 'body', name: 'Jupiter', jd_utc: null }, upCloseSupported).upClose).toBeNull();
    expect(planOfTarget({ kind: 'body', name: 'Saturn', inset: true, jd_utc: null }, upCloseSupported).upClose).toBe('Saturn');
    expect(planOfTarget({ kind: 'body', name: 'Vega', inset: true, jd_utc: null }, upCloseSupported).upClose).toBeNull();

    const m31 = planOfTarget({ kind: 'deep_sky', id: 'M31', label: 'Andromeda Galaxy', ra_j2000_deg: 10.6847, dec_j2000_deg: 41.2690, jd_utc: 2461308.6 }, upCloseSupported);
    expect(m31.show).toEqual({ kind: 'deep_sky', id: 'M31' });
    expect(m31.fallback).toEqual({ kind: 'point', id: 'Andromeda Galaxy', ra_j2000_deg: 10.6847, dec_j2000_deg: 41.269 });
    expect(planOfTarget({ kind: 'deep_sky', id: 'X', label: 'X', ra_j2000_deg: null, dec_j2000_deg: null, jd_utc: null }, upCloseSupported).fallback).toBeNull();

    const per = planOfTarget({ kind: 'radiant', code: 'PER', label: 'Perseids', ra_j2000_deg: 48.2, dec_j2000_deg: 58.1, jd_utc: 2461265.8 }, upCloseSupported);
    expect(per.show).toEqual({ kind: 'shower', id: 'PER' });
    expect(per.fallback).toEqual({ kind: 'point', id: 'Radiant of the Perseids', ra_j2000_deg: 48.2, dec_j2000_deg: 58.1 });

    const core = planOfTarget({ kind: 'direction', label: 'The Milky Way’s core', alt_deg: 21.4, az_deg: 196.2, jd_utc: 2461308.55 }, upCloseSupported);
    expect(core).toEqual({ show: null, fallback: null, direction: { label: 'The Milky Way’s core', alt_deg: 21.4, az_deg: 196.2 }, upClose: null });
    expect(planOfTarget({ kind: 'direction', label: 'x', alt_deg: Number.NaN, az_deg: 10, jd_utc: null }, upCloseSupported).direction).toBeNull();
  });

  it('turns a direction at a moment back into the J2000 place the Sky view would draw there', () => {
    // Philadelphia and Sydney; a frame of date some decades from J2000; refraction at two
    // pressures; every direction from the horizon up.
    let worst = 0;
    let n = 0;
    for (const lat of [39.95, -33.87, 78.2]) {
      for (const lst of [0, 97.3, 211.8, 333.3]) {
        const hm = horizonMatrix(lst, lat);
        const f = precessionLike(0.3 * DEG, 0.25 * DEG, 0.3 * DEG);
        for (const refraction of [1, 0.85]) {
          for (let ra = 3; ra < 360; ra += 17) {
            for (let dec = -85; dec <= 85; dec += 10) {
              const p = place(ra, dec, hm, f, refraction);
              if (p.alt < 0) continue;
              const back = j2000OfApparent(p.alt, p.az, hm, f, refraction);
              worst = Math.max(worst, separationDeg(ra, dec, back.ra_deg, back.dec_deg));
              n += 1;
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-9);
  });

  it('undoes refraction: on the horizon the place is half a degree below where it is seen', () => {
    const hm = horizonMatrix(120, 40);
    const f = precessionLike(0, 0, 0);
    const seen = j2000OfApparent(0, 180, hm, f, 1);
    const unrefracted = j2000OfApparent(0, 180, hm, f, 0);
    // Due south, the declination is lower by the horizon's refraction: the geometric h
    // with h + R(h) = 0 is about −34.5′ (Saemundsson, the engine's display refraction).
    const dropArcmin = (unrefracted.dec_deg - seen.dec_deg) * 60;
    expect(dropArcmin).toBeGreaterThan(33);
    expect(dropArcmin).toBeLessThan(36);
    expect(dropArcmin - refractionArcmin(-dropArcmin / 60, 1)).toBeCloseTo(0, 9);
  });
});
