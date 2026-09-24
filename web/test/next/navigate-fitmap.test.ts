/**
 * The frame Navigate asks the fit map for (navigate/plot.ts plotDefaultBounds): what the
 * chart shows at "Fit", a little enlarged, as misfit_grid bounds — the fix inside it, the
 * longitudes continuous across the antimeridian as the grid allows.
 */
import { describe, expect, it } from 'vitest';
import { emptyPlotSpec, plotDefaultBounds } from '../../src/next/navigate/plot.js';

const SIZE = { width: 560, height: 380 };

describe('the fit map’s frame in Navigate', () => {
  it('holds the fix and the chart’s own frame, a little enlarged', () => {
    const spec = emptyPlotSpec();
    spec.fix = { lat_deg: 39.95, lon_deg: -75.16 };
    spec.ellipse = { centre: spec.fix, ellipse: { semi_major_m: 1500, semi_minor_m: 900, orientation_deg: 30 } as never };
    const b = plotDefaultBounds(spec, SIZE);
    expect(b.south_deg).toBeLessThan(39.95);
    expect(b.north_deg).toBeGreaterThan(39.95);
    expect(b.west_deg).toBeLessThan(-75.16);
    expect(b.east_deg).toBeGreaterThan(-75.16);
    const plain = plotDefaultBounds(spec, SIZE, 0);
    expect(b.north_deg - b.south_deg).toBeCloseTo((plain.north_deg - plain.south_deg) * 1.3, 9);
  });

  it('runs east past 180 across the antimeridian instead of wrapping', () => {
    const spec = emptyPlotSpec();
    spec.fix = { lat_deg: -17.5, lon_deg: 179.99 };
    const b = plotDefaultBounds(spec, SIZE);
    expect(b.west_deg).toBeLessThan(179.99);
    expect(b.east_deg).toBeGreaterThan(180);
    expect(b.east_deg - b.west_deg).toBeLessThan(10);
  });
});
