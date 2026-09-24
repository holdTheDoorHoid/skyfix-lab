/**
 * Engine selection policy (mirrors src/api/index.ts): the mock only when asked for, or
 * as a loud development fallback; never silently in a production build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineUnavailableError,
  requestedEngine,
  selectEngine,
} from '../../src/next/engine/index.js';
import type { ExplorerEngine } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports, type WasmLoad } from '../../src/next/engine/wasm.js';

const mock = { kind: 'mock', description: 'mock' } as unknown as ExplorerEngine;
const loadMock = vi.fn(async () => mock);
const realEngine = new WasmEngine({} as ExplorerWasmExports);

const ready: WasmLoad = { status: 'ready', engine: realEngine, missingOptional: [] };
const absent: WasmLoad = { status: 'absent' };
const incomplete: WasmLoad = {
  status: 'incomplete',
  missing: ['sky_state', 'day_events'],
  missingOptional: ['constellation_boundaries'],
  version: '0.1.0',
};

describe('engine selection', () => {
  afterEach(() => {
    loadMock.mockClear();
    vi.restoreAllMocks();
  });

  it('reads ?engine=mock and nothing else', () => {
    expect(requestedEngine('?engine=mock')).toBe('mock');
    expect(requestedEngine('?engine=wasm')).toBe('auto');
    expect(requestedEngine('?api=mock')).toBe('auto');
    expect(requestedEngine('')).toBe('auto');
  });

  it('uses the mock when asked, even in production, and says so', async () => {
    const loadWasm = vi.fn(async () => ready);
    const s = await selectEngine({ search: '?engine=mock', production: true, loadWasm, loadMock });
    expect(s.engine).toBe(mock);
    expect(s.requested).toBe('mock');
    expect(loadWasm).not.toHaveBeenCalled();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]!.text).toMatch(/illustrative/);
  });

  it('uses the WASM core when it is complete, with no notice', async () => {
    const s = await selectEngine({ search: '', production: true, loadWasm: async () => ready, loadMock });
    expect(s.engine).toBe(realEngine);
    expect(s.notices).toEqual([]);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('mentions a missing optional export without falling back', async () => {
    const partial: WasmLoad = { status: 'ready', engine: realEngine, missingOptional: ['constellation_boundaries'] };
    const s = await selectEngine({ search: '', production: true, loadWasm: async () => partial, loadMock });
    expect(s.engine).toBe(realEngine);
    expect(s.notices).toEqual([{ level: 'info', text: expect.stringMatching(/boundaries/) }]);
  });

  it('falls back to the mock in development when no package is built, loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await selectEngine({ search: '', production: false, loadWasm: async () => absent, loadMock });
    expect(s.engine).toBe(mock);
    expect(s.notices[0]!.level).toBe('caution');
    expect(s.notices[0]!.text).toMatch(/^MOCK ENGINE/);
    expect(s.notices[0]!.text).toMatch(/npm run wasm/);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back in development when the package lacks explorer exports, naming them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await selectEngine({ search: '', production: false, loadWasm: async () => incomplete, loadMock });
    expect(s.engine).toBe(mock);
    expect(s.notices[0]!.text).toContain('sky_state, day_events');
    expect(s.notices[0]!.text).toContain('0.1.0');
  });

  it('refuses to start a production build with no package', async () => {
    const run = selectEngine({ search: '', production: true, loadWasm: async () => absent, loadMock });
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toThrow(/no WebAssembly core/);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('refuses to start a production build whose package lacks the explorer, naming what is missing', async () => {
    const error = await selectEngine({
      search: '',
      production: true,
      loadWasm: async () => incomplete,
      loadMock,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).missing).toEqual(['sky_state', 'day_events']);
    expect((error as Error).message).toMatch(/sky_state, day_events/);
    expect((error as Error).message).toMatch(/never used to produce results/);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('treats a package that fails to load as a fault, in development too', async () => {
    const broken = async (): Promise<WasmLoad> => {
      throw new Error('CompileError: invalid magic number');
    };
    await expect(selectEngine({ search: '', production: false, loadWasm: broken, loadMock })).rejects.toThrow(
      /invalid magic/,
    );
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('loads the real mock module on demand', async () => {
    const s = await selectEngine({ search: '?engine=mock' });
    expect(s.engine.kind).toBe('mock');
    expect(s.engine.bodies()).toHaveLength(67);
  });
});
