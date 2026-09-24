/**
 * The compass overlay's geometry (web/src/next/map/skyproj.ts). Paths are built here from
 * the textbook altitude/azimuth formulas for a fixed declination, independently of the code
 * under test and of any engine.
 */
import { describe, expect, it } from 'vitest';
import {
  aboveHorizonRuns,
  arcThroughNorth,
  brightLimbScreenAngle,
  compassRadius,
  declinationRegion,
  labelPlacement,
  lerpAz,
  moonLitPath,
  regionContains,
  regionPath,
  ringXY,
  screenBearing,
  skyXY,
  solsticeBand,
  type SkyTrack,
} from '../../src/next/map/skyproj.js';

const RAD = Math.PI / 180;
const EPS = 23.44;

/** Altitude and azimuth of a fixed declination over one turn, starting at lower transit. */
function diurnal(latDeg: number, decDeg: number, stepDeg = 1.25): SkyTrack {
  const alt: number[] = [];
  const az: number[] = [];
  const phi = latDeg * RAD;
  const dec = decDeg * RAD;
  for (let H = -180; H < 180 - 1e-9; H += stepDeg) {
    const h = H * RAD;
    alt.push(Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)) / RAD);
    const a = Math.atan2(-Math.sin(h) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(h)) / RAD;
    az.push((a + 360) % 360);
  }
  return { alt: Float64Array.from(alt), az: Float64Array.from(az) };
}

/** Declination of the sky point at (alt, az) seen from latitude `lat`. */
function declinationAt(latDeg: number, altDeg: number, azDeg: number): number {
  const phi = latDeg * RAD;
  const h = altDeg * RAD;
  const a = azDeg * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(h) + Math.cos(phi) * Math.cos(h) * Math.cos(a)) / RAD;
}

describe('projection', () => {
  it('puts the zenith at the centre and the horizon on the ring', () => {
    const R = 100;
    expect(skyXY(90, 123, R)[0]).toBeCloseTo(0, 9);
    expect(skyXY(90, 123, R)[1]).toBeCloseTo(0, 9);
    const east = skyXY(0, 90, R);
    expect(east[0]).toBeCloseTo(100, 9);
    expect(east[1]).toBeCloseTo(0, 9);
    const north = skyXY(0, 0, R);
    expect(north[1]).toBeCloseTo(-100, 9); // north is up (y down)
    // Orthographic: 60 degrees up is half way out.
    expect(Math.hypot(...skyXY(60, 200, R))).toBeCloseTo(50, 9);
    // Below the horizon clamps to the ring.
    expect(Math.hypot(...skyXY(-10, 200, R))).toBeCloseTo(100, 9);
    expect(ringXY(270, 50)[0]).toBeCloseTo(-50, 9);
  });

  it('interpolates azimuths the short way', () => {
    expect(lerpAz(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpAz(10, 350, 0.25)).toBeCloseTo(5, 9);
    expect(lerpAz(90, 180, 0.5)).toBeCloseTo(135, 9);
  });

  it('sizes the dial to 38 % of the smaller side, within limits', () => {
    expect(compassRadius(1440, 900)).toBe(150);
    expect(compassRadius(700, 300)).toBeCloseTo(114, 9);
    expect(compassRadius(390, 700)).toBeCloseTo(89.7, 9); // a phone: room for the times
    expect(compassRadius(100, 100)).toBe(64);
  });

  it('turns screen vectors into bearings', () => {
    expect(screenBearing(0, -1)).toBeCloseTo(0, 9);
    expect(screenBearing(1, 0)).toBeCloseTo(90, 9);
    expect(screenBearing(0, 1)).toBeCloseTo(180, 9);
  });
});

describe('paths above the horizon', () => {
  it('ends each run at an interpolated crossing', () => {
    const track = { alt: [-10, -2, 6, 20, 6, -2, -10], az: [0, 60, 90, 180, 270, 300, 360] };
    const runs = aboveHorizonRuns(track);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run[0]).toEqual({ alt: 0, az: 60 + 30 * 0.25 });
    expect(run[run.length - 1]).toEqual({ alt: 0, az: 270 + 30 * 0.75 });
    expect(run).toHaveLength(5);
  });

  it('keeps two runs when a day starts and ends with the body up', () => {
    const track = { alt: [5, -5, -5, 5], az: [300, 10, 60, 100] };
    expect(aboveHorizonRuns(track)).toHaveLength(2);
    // Read cyclically from its lowest point, a closed diurnal path is one run.
    expect(aboveHorizonRuns(track, true)).toHaveLength(1);
  });

  it('follows the horizon through north', () => {
    const arc = arcThroughNorth(300, 60, 10);
    expect(arc[0]!.az).toBe(300);
    expect(arc[arc.length - 1]!.az).toBe(60);
    expect(arc.some((p) => p.az === 0)).toBe(true);
    const back = arcThroughNorth(60, 300, 10);
    expect(back.some((p) => p.az === 0)).toBe(true);
    expect(back.some((p) => p.az === 180)).toBe(false);
  });
});

describe('the solstice band', () => {
  function checkBand(lat: number): void {
    const R = 200;
    const band = solsticeBand(diurnal(lat, EPS), diurnal(lat, -EPS), lat);
    let tested = 0;
    let insideCount = 0;
    // Orthographic: the first few degrees above the horizon are a fraction of a pixel wide at
    // the ring (R (1 - cos 5 deg) is under a pixel), so the check starts above them.
    for (let alt = 6; alt < 89; alt += 2.9) {
      for (let az = 0; az < 360; az += 7.3) {
        const dec = declinationAt(lat, alt, az);
        if (Math.abs(Math.abs(dec) - EPS) < 0.6) continue;
        const inside = regionContains(band, R, skyXY(alt, az, R));
        expect(inside, `lat ${lat}: alt ${alt} az ${az} dec ${dec.toFixed(2)}`).toBe(Math.abs(dec) < EPS);
        tested++;
        if (inside) insideCount++;
      }
    }
    expect(tested).toBeGreaterThan(400);
    if (Math.abs(lat) < 66) expect(insideCount).toBeGreaterThan(0);
    expect(regionPath(band, R).length).toBeGreaterThan(0);
  }

  it('mid-northern latitude (Philadelphia)', () => checkBand(39.95));
  it('mid-southern latitude (Sydney)', () => checkBand(-33.86));
  it('in the tropics, where the June Sun passes north of the zenith', () => checkBand(10));
  it('on the equator', () => checkBand(0.2));
  it('inside the Arctic Circle (midnight Sun, polar night)', () => checkBand(69.65));
  it('inside the Antarctic Circle', () => checkBand(-72));
  it('near the North Pole', () => checkBand(88));

  it('a path that never sets encloses the region round the visible pole', () => {
    const north = declinationRegion(diurnal(70, EPS), 70);
    expect(north.rings).toHaveLength(1);
    expect(north.discs).toBe(0);
    const south = declinationRegion(diurnal(-70, -EPS), -70);
    expect(south.discs).toBe(1); // everything except inside the loop
    const never = declinationRegion(diurnal(70, -EPS), 70);
    expect(never).toEqual({ rings: [], discs: 1 });
    expect(declinationRegion(diurnal(-70, EPS), -70)).toEqual({ rings: [], discs: 0 });
  });
});

describe('the Moon glyph', () => {
  it('points the lit side towards the zenith (the centre) when the limb is "up"', () => {
    // Moon due south at 45 degrees: the centre is straight up on the screen.
    const angle = brightLimbScreenAngle(45, 180, 0);
    expect(Math.cos(angle)).toBeCloseTo(0, 9);
    expect(Math.sin(angle)).toBeCloseTo(-1, 9); // -y is up
  });

  it('mirrors left and right: the dial is the sky seen from above', () => {
    // Facing south, the observer's left is east; on the dial (north up) east is on the right.
    const angle = brightLimbScreenAngle(45, 180, 90);
    expect(Math.cos(angle)).toBeCloseTo(1, 9);
  });

  it('near the horizon, a lit side facing down-right points along the ring', () => {
    // Crescent in the west-south-west after sunset, lit towards the Sun below and right.
    const angle = brightLimbScreenAngle(2, 240, 225);
    // Mostly along the clockwise tangent at azimuth 240 (up and to the left on the dial).
    const tangent = [Math.cos(240 * RAD), Math.sin(240 * RAD)];
    expect(Math.cos(angle) * tangent[0]! + Math.sin(angle) * tangent[1]!).toBeGreaterThan(0.99);
  });

  it('draws the lit part of the disc', () => {
    expect(moonLitPath(0, 10)).toBe('');
    expect(moonLitPath(1, 10)).toContain('A10 10 0 1 1');
    expect(moonLitPath(0.5, 10)).toBe('M0 -10A10 10 0 0 1 0 10A0 10 0 0 1 0 -10Z');
    expect(moonLitPath(0.25, 10)).toBe('M0 -10A10 10 0 0 1 0 10A5 10 0 0 0 0 -10Z');
    expect(moonLitPath(0.75, 10)).toBe('M0 -10A10 10 0 0 1 0 10A5 10 0 0 1 0 -10Z');
  });
});

describe('labels', () => {
  it('anchors labels away from the ring', () => {
    expect(labelPlacement(90, 100)).toMatchObject({ tx: '0%', ty: '-50%' });
    expect(labelPlacement(270, 100)).toMatchObject({ tx: '-100%', ty: '-50%' });
    expect(labelPlacement(0, 100)).toMatchObject({ tx: '-50%', ty: '-100%' });
    expect(labelPlacement(180, 100)).toMatchObject({ tx: '-50%', ty: '0%' });
    const p = labelPlacement(90, 100, 12);
    expect(p.x).toBeCloseTo(112, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });
});
