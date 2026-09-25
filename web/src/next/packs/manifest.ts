/**
 * The site's list of data packs, `data/packs/manifest.json` (schema `skyfix.packs/1`),
 * written at build time by web/plugins/packs.ts and precached by the service worker, so
 * the page knows offline what exists. OWNER: packs agent. Contract: EXPLORER_API "Packs".
 */

/** Where the manifest lives, relative to the site root. */
export const MANIFEST_PATH = 'data/packs/manifest.json';
export const MANIFEST_SCHEMA = 'skyfix.packs/1';

/** One pack the site offers (the fields web/plugins/packs.ts writes). */
export interface PackManifestEntry {
  readonly name: string;
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

export const EMPTY_MANIFEST: PackManifest = { schema: MANIFEST_SCHEMA, packs: [] };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REV = /^[0-9a-f]{16}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check a manifest from the network (or the precache). A malformed entry is dropped, not
 * trusted; a document of another schema is refused. The file name must be the one the
 * build writes, so a manifest can never point the page outside the packs folder.
 */
export function parseManifest(raw: unknown): PackManifest {
  if (!isRecord(raw) || raw.schema !== MANIFEST_SCHEMA || !Array.isArray(raw.packs)) {
    throw new Error(`not a ${MANIFEST_SCHEMA} document`);
  }
  const packs: PackManifestEntry[] = [];
  for (const p of raw.packs) {
    if (!isRecord(p)) continue;
    const { name, version, rev, file, bytes, label, description, provides } = p;
    if (typeof name !== 'string' || !NAME.test(name)) continue;
    if (typeof rev !== 'string' || !REV.test(rev) || file !== `${name}-${rev}.bin`) continue;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) continue;
    if (typeof version !== 'string' || typeof label !== 'string' || typeof description !== 'string') continue;
    const list = Array.isArray(provides) ? provides.filter((x): x is string => typeof x === 'string') : [];
    if (packs.some((q) => q.name === name)) continue;
    packs.push({ name, version, rev, file, bytes, label: label || name, description, provides: list });
  }
  return { schema: MANIFEST_SCHEMA, packs };
}

/** `0.4 MB`, `86 KB`, `12 MB` (decimal units, as the build reports sizes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 100_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  const mb = bytes / 1e6;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
