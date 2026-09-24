/**
 * Every layer flag in the store has a switch somewhere: the shell has no Layers menu of its
 * own, so each one must be in the map's (map/controls.ts) or the sky's (sky/view.ts).
 * A flag added to `Layers` without a switch would be stuck at its default.
 */
import { describe, expect, it } from 'vitest';
import { OVERLAY_PREFIX as EVENTS_PREFIX } from '../../src/next/events/mapping.js';
import { drawnGroups, idsOfGroup, MAP_LAYER_OPTIONS, OVERLAY_OWNERS } from '../../src/next/map/controls.js';
import { OVERLAY_PREFIX as NAVIGATE_PREFIX } from '../../src/next/navigate/overlays.js';
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

describe('other views’ drawings on the map', () => {
  const ids = ['navigate-cop-1', 'navigate-fix', 'events-eclipse-path', 'learn-truth', 'learn-frame', 'demo-ellipse'];

  it('are grouped by the view that drew them, in a fixed order, the rest last', () => {
    expect(drawnGroups(ids).map((g) => [g.prefix, g.count])).toEqual([
      ['navigate-', 2],
      ['events-', 1],
      ['learn-', 2],
      ['', 1],
    ]);
    expect(drawnGroups([])).toEqual([]);
  });

  it('removes exactly one group', () => {
    expect(idsOfGroup(ids, 'navigate-')).toEqual(['navigate-cop-1', 'navigate-fix']);
    expect(idsOfGroup(ids, '')).toEqual(['demo-ellipse']);
  });

  it('knows every view that publishes overlays', () => {
    expect(OVERLAY_OWNERS.map((o) => o.prefix)).toEqual(expect.arrayContaining([NAVIGATE_PREFIX, 'events-', 'learn-']));
    expect(EVENTS_PREFIX.startsWith('events-')).toBe(true);
  });
});
