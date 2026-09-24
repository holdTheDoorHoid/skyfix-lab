/**
 * Every layer flag in the store has a switch somewhere: the shell has no Layers menu of its
 * own, so each one must be in the map's (map/controls.ts) or the sky's (sky/view.ts).
 * A flag added to `Layers` without a switch would be stuck at its default.
 */
import { describe, expect, it } from 'vitest';
import { MAP_LAYER_OPTIONS } from '../../src/next/map/controls.js';
import { SKY_LAYER_OPTIONS } from '../../src/next/sky/view.js';
import { DEFAULT_LAYERS, type Layers } from '../../src/next/state.js';

describe('layer switches', () => {
  const offered = new Set<keyof Layers>([...MAP_LAYER_OPTIONS.map((o) => o.key), ...SKY_LAYER_OPTIONS.map((o) => o.key)]);

  it('offers every layer flag in the map’s or the sky’s Layers menu', () => {
    const missing = (Object.keys(DEFAULT_LAYERS) as (keyof Layers)[]).filter((k) => !offered.has(k));
    expect(missing).toEqual([]);
  });

  it('offers the newer flags where they are drawn', () => {
    const map = MAP_LAYER_OPTIONS.map((o) => o.key);
    const sky = SKY_LAYER_OPTIONS.map((o) => o.key);
    expect(map).toContain('altitudeRings');
    expect(map).toContain('scaleBar');
    expect(sky).toContain('constellationBoundaries');
  });

  it('names each switch once per menu', () => {
    for (const list of [MAP_LAYER_OPTIONS, SKY_LAYER_OPTIONS]) {
      const keys = list.map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
