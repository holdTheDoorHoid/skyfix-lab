/**
 * The data packs at build time (web/plugins/packs.ts): the manifest built from the
 * producers' files, on a sample pack made here (no real pack exists yet; the deeptime agent
 * writes the first), and every way a producer's folder can be wrong.
 */

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { revisionOf } from '../plugins/precache.ts';
import { buildPackManifest, encodePack, MANIFEST_SCHEMA, manifestText, packHeaderName, packRev } from '../plugins/packs.ts';

const enc = new TextEncoder();

/** A producer's two files for a pack: `<name>-<rev>.bin` and `<name>.json`. */
function produce(name: string, payload: Uint8Array, meta: Record<string, unknown> = {}): [string, Uint8Array][] {
  const file = encodePack(name, payload);
  const sidecar = {
    name,
    version: '2026-09-24',
    bytes: file.byteLength,
    label: 'Sample',
    description: 'A pack made by a test.',
    provides: ['test:sample'],
    ...meta,
  };
  return [
    [`${name}-${packRev(file)}.bin`, file],
    [`${name}.json`, enc.encode(JSON.stringify(sidecar))],
  ];
}

const folder = (...pairs: [string, Uint8Array][][]): Map<string, Uint8Array> => new Map(pairs.flat());

describe('the pack file layout, as the Rust dispatcher reads it', () => {
  it('matches skyfix_wasm::packs byte for byte', () => {
    const file = encodePack('ab', new Uint8Array([1, 2, 3]));
    expect([...file]).toEqual([
      ...enc.encode('SKYFIXPK'),
      1, 0, // format version 1, little-endian
      2, 0, // name length
      ...enc.encode('ab'),
      3, 0, 0, 0, // payload length
      1, 2, 3,
      0x1d, 0x80, 0xbc, 0x55, // CRC-32 of the payload, 0x55bc801d, little-endian
    ]);
    expect(crc32(enc.encode('123456789')) >>> 0).toBe(0xcbf43926);
    expect(packHeaderName(file)).toBe('ab');
  });

  it('uses the precache’s revision for the name', () => {
    const file = encodePack('sample', enc.encode('x'));
    expect(packRev(file)).toBe(revisionOf(file));
    expect(packRev(file)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a damaged or foreign file', () => {
    const file = encodePack('sample', enc.encode('payload'));
    const flipped = file.slice();
    flipped[25] = (flipped[25] ?? 0) ^ 1;
    expect(() => packHeaderName(flipped)).toThrow(/checksum/);
    expect(() => packHeaderName(file.subarray(0, file.length - 1))).toThrow(/does not fit/);
    expect(() => packHeaderName(enc.encode('GIF89a and so on....'))).toThrow(/SKYFIXPK/);
    const v2 = file.slice();
    v2[8] = 2;
    expect(() => packHeaderName(v2)).toThrow(/version 2/);
    expect(() => encodePack('Deep time', new Uint8Array())).toThrow(/lowercase/);
  });
});

describe('buildPackManifest', () => {
  it('is empty when there are no packs, which is the case today', () => {
    const { manifest, sidecars } = buildPackManifest(new Map());
    expect(manifest).toEqual({ schema: MANIFEST_SCHEMA, packs: [] });
    expect(sidecars).toEqual([]);
    expect(manifestText(manifest)).toBe('{\n  "schema": "skyfix.packs/1",\n  "packs": []\n}\n');
  });

  it('lists each pack with its revision, file and size, sorted by name, and drops the sidecars', () => {
    const deep = produce('deep-time', new Uint8Array(4000).map((_, i) => i % 251), {
      label: 'Deep time',
      description: 'Positions from 2000 BC to AD 3000',
      provides: ['ephemeris:-2000..3000'],
    });
    const tides = produce('tides-us', enc.encode('stations'), { version: '2026-09-20', label: 'US tides', provides: [] });
    const { manifest, sidecars } = buildPackManifest(folder(tides, deep));
    const file = deep[0]![1];
    expect(manifest.packs.map((p) => p.name)).toEqual(['deep-time', 'tides-us']);
    expect(manifest.packs[0]).toEqual({
      name: 'deep-time',
      version: '2026-09-24',
      rev: packRev(file),
      file: `deep-time-${packRev(file)}.bin`,
      bytes: file.byteLength,
      label: 'Deep time',
      description: 'Positions from 2000 BC to AD 3000',
      provides: ['ephemeris:-2000..3000'],
    });
    expect(manifest.packs[1]!.provides).toEqual([]);
    expect(sidecars).toEqual(['deep-time.json', 'tides-us.json']);
  });

  it('refuses a file whose name is not its content hash (a stale or hand-renamed pack)', () => {
    const [[bin, bytes], side] = produce('sample', enc.encode('v1')) as [[string, Uint8Array], [string, Uint8Array]];
    const wrong = bin.replace(/-[0-9a-f]{16}\.bin$/, '-0000000000000000.bin');
    expect(() => buildPackManifest(new Map([[wrong, bytes], side]))).toThrow(/content hash is [0-9a-f]{16}; rename it sample-/);
  });

  it('refuses two revisions of one pack side by side, and a pack without its sidecar', () => {
    const v1 = produce('sample', enc.encode('v1'));
    const v2 = produce('sample', enc.encode('v2'));
    expect(() => buildPackManifest(folder(v1, [v2[0]!]))).toThrow(/2 files for one pack/);
    expect(() => buildPackManifest(folder([v1[0]!]))).toThrow(/needs its <name>\.json/);
    expect(() => buildPackManifest(folder([v1[1]!]))).toThrow(/no sample-<rev>\.bin beside it/);
  });

  it('refuses a sidecar that disagrees with its file or leaves a field out', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ bytes: 3 }, /bytes, but sample\.json says 3/],
      [{ name: 'other' }, /"name" is "other", expected "sample"/],
      [{ version: '' }, /"version" must be a non-empty string/],
      [{ label: 7 }, /"label" must be a non-empty string/],
      [{ description: undefined }, /"description" must be a non-empty string/],
      [{ provides: 'ephemeris' }, /"provides" must be a list of strings/],
      [{ bytes: -1 }, /"bytes" must be the file's size/],
    ];
    for (const [meta, error] of cases) {
      expect(() => buildPackManifest(folder(produce('sample', enc.encode('v1'), meta))), JSON.stringify(meta)).toThrow(error);
    }
  });

  it('refuses a pack file that is damaged or is another pack', () => {
    const [[bin, bytes], side] = produce('sample', enc.encode('payload')) as [[string, Uint8Array], [string, Uint8Array]];
    const damaged = bytes.slice();
    damaged[damaged.length - 6] = (damaged[damaged.length - 6] ?? 0) ^ 0x10;
    const damagedName = `sample-${packRev(damaged)}.bin`;
    expect(() => buildPackManifest(new Map([[damagedName, damaged], side]))).toThrow(/checksum does not hold/);
    // A tides file under the sample's name.
    const other = encodePack('tides-us', enc.encode('payload'));
    const sidecar = enc.encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(side[1])), bytes: other.byteLength }));
    expect(() => buildPackManifest(new Map([[`sample-${packRev(other)}.bin`, other], ['sample.json', sidecar]]))).toThrow(
      /the file is the "tides-us" pack/,
    );
    expect(bin).toMatch(/^sample-[0-9a-f]{16}\.bin$/);
  });

  it('refuses a committed manifest, stray files and bad names, listing every problem at once', () => {
    const files = folder(produce('sample', enc.encode('v1')));
    files.set('manifest.json', enc.encode('{}'));
    files.set('notes.txt', enc.encode('hello'));
    files.set('Bad Name.json', enc.encode('{}'));
    files.set('drafts/', new Uint8Array());
    let message = '';
    try {
      buildPackManifest(files);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/manifest\.json: the build writes it/);
    expect(message).toMatch(/notes\.txt: not a pack of this folder/);
    expect(message).toMatch(/Bad Name\.json: a pack name is lowercase/);
    expect(message).toMatch(/drafts\/: not a pack of this folder/);
  });
});
