/**
 * The Sky view's projections (src/next/sky/projection.ts): the stereographic dome and
 * the conformal panorama — orientation, inverses, limits, and that the fast per-star
 * path (`projectDir`) lands exactly where the general one does.
 */
import { describe, expect, it } from 'vitest';
import { DEG } from '../../src/next/sky/astro.js';
import {
  DomeProjector,
  inverseMercator,
  mercator,
  PANORAMA_LIMITS,
  PanoramaProjector,
} from '../../src/next/sky/projection.js';

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

describe('dome (stereographic, zenith in the middle)', () => {
  const d = new DomeProjector();
  d.configure(400, 300, 250, false);

  it('puts the zenith at the centre and the horizon on the circle', () => {
    d.project(90 * DEG, 1.234);
    expect(close(d.x, 400) && close(d.y, 300)).toBe(true);
    for (const az of [0, 45, 90, 200, 359]) {
      d.project(0, az * DEG);
      expect(Math.hypot(d.x - 400, d.y - 300)).toBeCloseTo(250, 9);
    }
    // 45° up is tan(22.5°) of the radius from the centre.
    d.project(45 * DEG, 0);
    expect(300 - d.y).toBeCloseTo(250 * Math.tan(22.5 * DEG), 9);
  });

  it('draws north up and east on the LEFT, as a chart held overhead', () => {
    d.project(0, 0);
    expect([Math.round(d.x), Math.round(d.y)]).toEqual([400, 50]);
    d.project(0, 90 * DEG);
    expect([Math.round(d.x), Math.round(d.y)]).toEqual([150, 300]);
    d.project(0, 270 * DEG);
    expect([Math.round(d.x), Math.round(d.y)]).toEqual([650, 300]);
  });

  it('turns the chart half way round for south up (a rotation, not a mirror)', () => {
    const s = new DomeProjector();
    s.configure(400, 300, 250, true);
    s.project(0, 180 * DEG);
    expect([Math.round(s.x), Math.round(s.y)]).toEqual([400, 50]);
    s.project(0, 90 * DEG);
    expect([Math.round(s.x), Math.round(s.y)]).toEqual([650, 300]); // east now on the right
  });

  it('inverts', () => {
    for (const [alt, az] of [
      [10, 20],
      [60, 300],
      [0.5, 181],
      [89, 5],
    ] as const) {
      d.project(alt * DEG, az * DEG);
      expect(d.unproject(d.x, d.y)).toBe(true);
      expect(d.alt / DEG).toBeCloseTo(alt, 9);
      expect(d.az / DEG).toBeCloseTo(az, 9);
    }
    expect(d.unproject(400, 20)).toBe(false); // outside the horizon circle
  });

  it('the per-star path matches the general one', () => {
    for (const [alt, az] of [
      [12, 33],
      [-5, 250],
      [77, 180],
    ] as const) {
      const h = alt * DEG;
      const a = az * DEG;
      d.project(h, a);
      const [x, y] = [d.x, d.y];
      d.projectDir(h, Math.sin(h), Math.cos(h), Math.sin(a), Math.cos(a));
      expect(close(d.x, x) && close(d.y, y)).toBe(true);
    }
  });

  it('points "up" at the zenith and gives the scale for true-size discs', () => {
    const up = { x: 0, y: 0 };
    d.upAt(650, 300, up);
    expect([up.x, up.y]).toEqual([-1, 0]);
    d.upAt(400, 300, up);
    expect([up.x, up.y]).toEqual([0, -1]);
    // dρ/dh at the zenith is R/2 per radian, at the horizon R.
    expect(d.scaleAt(90 * DEG)).toBeCloseTo(125, 9);
    expect(d.scaleAt(0)).toBeCloseTo(250, 9);
  });
});

describe('panorama (conformal cylinder)', () => {
  it('keeps the horizon straight and azimuth growing to the right', () => {
    const p = new PanoramaProjector();
    const applied = p.configure(1440, 780, { azimuth: 180, fov: 120, bottomAlt: -5 });
    expect(applied.fov).toBeCloseTo(120, 9);
    p.project(0, 150 * DEG);
    const yLeft = p.y;
    const xLeft = p.x;
    p.project(0, 210 * DEG);
    expect(p.y).toBeCloseTo(yLeft, 9);
    expect(p.x).toBeGreaterThan(xLeft);
    p.project(0, 180 * DEG);
    expect(p.x).toBeCloseTo(720, 9);
    // The bottom edge is the requested altitude.
    expect(p.yHorizon - p.s * mercator(-5 * DEG)).toBeCloseTo(780, 6);
  });

  it('is conformal: equal small steps in altitude and azimuth look equal at the horizon', () => {
    const p = new PanoramaProjector();
    p.configure(1000, 700, { azimuth: 90, fov: 90, bottomAlt: -5 });
    p.project(0, 90 * DEG);
    const [x0, y0] = [p.x, p.y];
    p.project(0.1 * DEG, 90 * DEG);
    const dy = y0 - p.y;
    p.project(0, 90.1 * DEG);
    expect(p.x - x0).toBeCloseTo(dy, 3);
  });

  it('clamps the field to 60–180° and narrows it for a tall canvas', () => {
    const p = new PanoramaProjector();
    expect(p.configure(1440, 700, { azimuth: 0, fov: 20, bottomAlt: 0 }).fov).toBeCloseTo(PANORAMA_LIMITS.minFov, 9);
    expect(p.configure(1440, 700, { azimuth: 0, fov: 400, bottomAlt: 0 }).fov).toBeCloseTo(PANORAMA_LIMITS.maxFov, 9);
    // A phone held upright cannot show 180° and the whole height of the sky at once.
    const phone = p.configure(390, 700, { azimuth: 0, fov: 180, bottomAlt: -5 });
    expect(phone.fov).toBeLessThan(180);
    expect(p.topAlt).toBeLessThanOrEqual(PANORAMA_LIMITS.maxAlt + 1e-9);
  });

  it('never shows beyond the zenith limit or below the ground limit', () => {
    const p = new PanoramaProjector();
    const high = p.configure(1440, 700, { azimuth: 0, fov: 60, bottomAlt: 87.5 });
    expect(p.topAlt).toBeCloseTo(PANORAMA_LIMITS.maxAlt, 6);
    expect(high.bottomAlt).toBeLessThan(87.5);
    const low = p.configure(1440, 700, { azimuth: 0, fov: 60, bottomAlt: -40 });
    expect(low.bottomAlt).toBeCloseTo(PANORAMA_LIMITS.minAlt, 6);
  });

  it('inverts, and the per-star path matches the general one', () => {
    const p = new PanoramaProjector();
    p.configure(1200, 800, { azimuth: 350, fov: 150, bottomAlt: -5 });
    for (const [alt, az] of [
      [10, 20],
      [45, 300],
      [0.5, 355],
      [70, 10],
    ] as const) {
      const h = alt * DEG;
      const a = az * DEG;
      expect(p.project(h, a)).toBe(true);
      const [x, y] = [p.x, p.y];
      p.unproject(x, y);
      expect(p.alt / DEG).toBeCloseTo(alt, 9);
      expect(p.az / DEG).toBeCloseTo(az, 9);
      p.projectDir(h, Math.sin(h), Math.cos(h), Math.sin(a), Math.cos(a));
      expect(close(p.x, x, 1e-7) && close(p.y, y, 1e-7)).toBe(true);
    }
  });

  it('drops directions far behind the viewer (the seam is never drawn)', () => {
    const p = new PanoramaProjector();
    p.configure(1200, 800, { azimuth: 0, fov: 90, bottomAlt: -5 });
    expect(p.project(10 * DEG, 180 * DEG)).toBe(false);
    expect(p.project(10 * DEG, 40 * DEG)).toBe(true);
  });

  it('Mercator ordinates invert', () => {
    for (const h of [-10, 0, 23.4, 60, 85]) expect(inverseMercator(mercator(h * DEG)) / DEG).toBeCloseTo(h, 9);
  });
});
