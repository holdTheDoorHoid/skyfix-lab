/**
 * Optional data packs, at build time: the manifest the page reads to offer them. OWNER:
 * packs agent. Contract: docs/EXPLORER_API.md, "Packs"; CONVENTIONS §15.5.
 *
 * A producer (the deep-time, tides-us or lunar-limb generator) writes two files into
 * `web/public/data/packs/`:
 *
 *   <name>-<rev>.bin   the pack (common header, EXPLORER_API "Packs"); rev = the first 16
 *                      hex digits of its SHA-256, like the precache's revisions
 *   <name>.json        its sidecar: {name, version, bytes, label, description, provides}
 *
 * Vite copies both into the site as they are. This plugin then
 *
 *  1. checks every pair: the name is a pack name, the file's hash is the rev in its name,
 *     its size is the sidecar's `bytes`, its header names the same pack and its checksum
 *     holds; one file per sidecar, no file without one, nothing else in the folder;
 *  2. writes `data/packs/manifest.json` (schema `skyfix.packs/1`), which the service worker
 *     precaches, so the page knows offline what exists;
 *  3. removes the sidecars from the built site: they are inputs, the manifest replaces
 *     them. The `.bin` files stay, and are never precached (the page stores the ones a
 *     person chooses in its own cache; web/plugins/pwa.ts `networkOnly`).
 *
 * The development server answers `data/packs/manifest.json` the same way, built on each
 * request. No pack need exist: the manifest is then empty, and the page offers nothing.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import type { Plugin, ResolvedConfig } from 'vite';

/** Site path of the folder, relative to the site root (and to `public/`). */
export const PACKS_DIR = 'data/packs';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA = 'skyfix.packs/1';

/** One pack as the page sees it (`data/packs/manifest.json`). */
export interface PackManifestEntry {
  readonly name: string;
  /** The data's own version (a date, say), from the sidecar. */
  readonly version: string;
  /** SHA-256 of the file, first 16 hex digits. */
  readonly rev: string;
  /** The file, relative to the manifest: `<name>-<rev>.bin`. */
  readonly file: string;
  readonly bytes: number;
  readonly label: string;
  readonly description: string;
  readonly provides: readonly string[];
}

export interface PackManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly packs: readonly PackManifestEntry[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BIN = /^(?<name>[a-z0-9][a-z0-9-]*)-(?<rev>[0-9a-f]{16})\.bin$/;
const MAGIC = 'SKYFIXPK';

/** Same digest and length as the precache (precache.ts `revisionOf`). */
export function packRev(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * The name in a pack file's header, after checking the layout and the payload's CRC-32
 * (the same checks as `skyfix_wasm::packs::parse`, so a damaged file fails the build and
 * not a visitor's download).
 */
export function packHeaderName(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('not a SkyFix Lab data pack (no SKYFIXPK at the start)');
  }
  const version = view.getUint16(8, true);
  if (version !== 1) throw new Error(`pack format version ${version}; the site reads version 1`);
  const nameLength = view.getUint16(10, true);
  if (bytes.byteLength < 20 + nameLength) throw new Error('the file is cut short');
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + nameLength));
  const at = 12 + nameLength;
  const payloadLength = view.getUint32(at, true);
  if (at + 4 + payloadLength + 4 !== bytes.byteLength) {
    throw new Error(`its header announces ${payloadLength} bytes of data, which does not fit a ${bytes.byteLength}-byte file`);
  }
  const payload = bytes.subarray(at + 4, at + 4 + payloadLength);
  const stored = view.getUint32(at + 4 + payloadLength, true);
  const actual = crc32(payload) >>> 0;
  if (stored !== actual) throw new Error(`the checksum does not hold (${actual.toString(16)} computed, ${stored.toString(16)} stored)`);
  return name;
}

/** Write a pack file (tests, and producers who build with Node). Same layout as `skyfix_wasm::packs::encode`. */
export function encodePack(name: string, payload: Uint8Array): Uint8Array {
  if (!NAME.test(name)) throw new Error(`pack name ${JSON.stringify(name)}: lowercase letters, digits and hyphens`);
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(20 + nameBytes.length + payload.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint16(8, 1, true);
  view.setUint16(10, nameBytes.length, true);
  out.set(nameBytes, 12);
  view.setUint32(12 + nameBytes.length, payload.length, true);
  out.set(payload, 16 + nameBytes.length);
  view.setUint32(16 + nameBytes.length + payload.length, crc32(payload) >>> 0, true);
  return out;
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where}: "${field}" must be a non-empty string`);
  return value;
}

/**
 * Build the manifest from the folder's files (file name -> bytes). Pure: the plugin reads
 * the folder and writes the result. Throws with every problem found, one per line.
 */
export function buildPackManifest(files: ReadonlyMap<string, Uint8Array>): { manifest: PackManifest; sidecars: string[] } {
  const problems: string[] = [];
  const packs: PackManifestEntry[] = [];
  const sidecars = [...files.keys()].filter((f) => f.endsWith('.json') && f !== MANIFEST_FILE).sort();
  const claimed = new Set<string>(sidecars);

  if (files.has(MANIFEST_FILE)) {
    problems.push(`${MANIFEST_FILE}: the build writes it; remove it from public/${PACKS_DIR}/`);
    claimed.add(MANIFEST_FILE);
  }
  for (const sidecar of sidecars) {
    const name = sidecar.slice(0, -'.json'.length);
    try {
      if (!NAME.test(name)) throw new Error(`${sidecar}: a pack name is lowercase letters, digits and hyphens`);
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(new TextDecoder().decode(files.get(sidecar))) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`${sidecar}: not JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      if (meta.name !== name) throw new Error(`${sidecar}: "name" is ${JSON.stringify(meta.name)}, expected "${name}"`);
      const version = text(meta.version, 'version', sidecar);
      const label = text(meta.label, 'label', sidecar);
      const description = text(meta.description, 'description', sidecar);
      if (!Array.isArray(meta.provides) || !meta.provides.every((p) => typeof p === 'string')) {
        throw new Error(`${sidecar}: "provides" must be a list of strings`);
      }
      if (typeof meta.bytes !== 'number' || !Number.isInteger(meta.bytes) || meta.bytes <= 0) {
        throw new Error(`${sidecar}: "bytes" must be the file's size in bytes`);
      }
      const bins = [...files.keys()].filter((f) => BIN.exec(f)?.groups?.name === name);
      for (const b of bins) claimed.add(b);
      if (bins.length !== 1) {
        throw new Error(
          bins.length === 0
            ? `${sidecar}: no ${name}-<rev>.bin beside it`
            : `${sidecar}: ${bins.length} files for one pack (${bins.join(', ')}); keep only the current one`,
        );
      }
      const file = bins[0]!;
      const bytes = files.get(file)!;
      const rev = packRev(bytes);
      const named = BIN.exec(file)!.groups!.rev;
      if (named !== rev) throw new Error(`${file}: its content hash is ${rev}; rename it ${name}-${rev}.bin`);
      if (bytes.byteLength !== meta.bytes) throw new Error(`${file}: ${bytes.byteLength} bytes, but ${sidecar} says ${meta.bytes}`);
      let inside: string;
      try {
        inside = packHeaderName(bytes);
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (inside !== name) throw new Error(`${file}: the file is the ${JSON.stringify(inside)} pack`);
      packs.push({ name, version, rev, file, bytes: bytes.byteLength, label, description, provides: [...(meta.provides as string[])] });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const f of files.keys()) {
    if (!claimed.has(f)) problems.push(`${f}: not a pack of this folder (every <name>-<rev>.bin needs its <name>.json, and nothing else belongs here)`);
  }
  if (problems.length > 0) throw new Error(`data packs (public/${PACKS_DIR}/):\n  ${problems.join('\n  ')}`);
  return { manifest: { schema: MANIFEST_SCHEMA, packs: packs.sort((a, b) => a.name.localeCompare(b.name)) }, sidecars };
}

function readFolder(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isFile()) files.set(entry, readFileSync(full));
    else files.set(`${entry}/`, new Uint8Array());
  }
  return files;
}

export function manifestText(manifest: PackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The Vite plugin: build and development server. */
export function skyfixPacks(): Plugin {
  let config: ResolvedConfig;
  let built: { manifest: PackManifest; sidecars: string[] } | null = null;
  const folder = (): string => resolve(config.publicDir || resolve(config.root, 'public'), PACKS_DIR);

  return {
    name: 'skyfix-packs',

    configResolved(resolved) {
      config = resolved;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.endsWith(`/${PACKS_DIR}/${MANIFEST_FILE}`)) return next();
        try {
          const { manifest } = buildPackManifest(readFolder(folder()));
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(manifestText(manifest));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(error instanceof Error ? error.message : String(error));
        }
      });
    },

    buildStart() {
      if (config.command !== 'build') return;
      try {
        built = buildPackManifest(readFolder(folder()));
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      const { packs } = built!.manifest;
      config.logger.info(
        `skyfix-packs: ${packs.length === 0 ? 'no data packs' : packs.map((p) => `${p.name} ${(p.bytes / 1e6).toFixed(2)} MB`).join(', ')}`,
      );
    },

    generateBundle() {
      if (!built) return;
      this.emitFile({ type: 'asset', fileName: `${PACKS_DIR}/${MANIFEST_FILE}`, source: manifestText(built.manifest) });
    },

    writeBundle(options) {
      if (!built) return;
      const outDir = options.dir ?? resolve(config.root, config.build.outDir);
      for (const sidecar of built.sidecars) rmSync(join(outDir, PACKS_DIR, sidecar), { force: true });
    },
  };
}
