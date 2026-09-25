/**
 * The mock engine's data packs (EXPLORER_API "Packs"): the registry the real core will
 * have once the producers land (deep-time, tides-us, lunar-limb), and a `loadPack` that
 * accepts any bytes, so the interface can be worked on before any pack exists. Nothing is
 * installed: the mock's numbers do not change. OWNER: packs agent.
 */

import type { PackInfo, PackStatus } from '../types.js';

interface MockPack {
  name: string;
  label: string;
  description: string;
  provides: string[];
}

/** The packs of EXPANSION_PLAN §3, as their producers describe them. */
export const MOCK_PACKS: readonly MockPack[] = [
  { name: 'deep-time', label: 'Deep time', description: 'Positions from 2000 BC to AD 3000', provides: ['ephemeris:-2000..3000'] },
  { name: 'tides-us', label: 'US tides', description: 'Tide predictions for NOAA stations in the United States', provides: ['tides:us'] },
  { name: 'lunar-limb', label: 'Lunar limb', description: "The mountains and valleys at the Moon's edge, for eclipse contact times and Baily's beads", provides: ['eclipses:lunar-limb'] },
];

export class MockPacks {
  private readonly loaded = new Map<string, PackInfo>();

  packs(): PackStatus[] {
    const known = MOCK_PACKS.map((p) => this.status(p.name, p));
    const others = [...this.loaded.keys()].filter((n) => !MOCK_PACKS.some((p) => p.name === n)).map((n) => this.status(n, null));
    return [...known, ...others];
  }

  /** Accepts anything: the mock checks nothing and installs nothing. */
  loadPack(name: string, bytes: Uint8Array): PackInfo {
    const known = MOCK_PACKS.find((p) => p.name === name);
    const info: PackInfo = { name, version: 'mock', bytes: bytes.byteLength, provides: [...(known?.provides ?? [])] };
    this.loaded.set(name, info);
    return info;
  }

  private status(name: string, p: MockPack | null): PackStatus {
    const info = this.loaded.get(name);
    return {
      name,
      version: info?.version ?? '',
      label: p?.label ?? name,
      description: p?.description ?? '',
      bytes: info?.bytes ?? 0,
      provides: info?.provides ?? [...(p?.provides ?? [])],
      loaded: Boolean(info),
    };
  }
}
