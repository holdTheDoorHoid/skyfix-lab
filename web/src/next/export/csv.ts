/**
 * Tables as CSV files: what a view's Table view shows, in a form a spreadsheet opens.
 * OWNER: charts2 agent (expansion programme Q5); shared by any view that saves a table.
 *
 *   saveText(tablesToCsv(tables, ['SkyFix Lab — Sunrise and sunset · 2026']), 'skyfix-year-2026.csv');
 *
 * Rules, so a file means the same thing as the screen:
 *
 * - A cell is its text as shown, unless it carries `data-csv` (on the cell or on one element
 *   inside it): then that value. Views put machine-friendly values there — decimal degrees
 *   for an angle shown as `42° 18′`, a bare number for a height whose unit is in the column
 *   heading — and a heading may carry `data-csv` too (`Height (degrees)`).
 * - True minus signs (U+2212) become ASCII hyphen-minus and the narrow and no-break spaces
 *   that group digits become ordinary spaces, so numbers parse in a spreadsheet.
 * - A row that only groups others (a month heading, `<th scope="rowgroup">`) is left out:
 *   every data row carries its own date.
 * - Lines starting with `#` before the first table say what the file is (title, place,
 *   clock, the estimate's label); each table after the first starts with a `#` line naming
 *   it and is separated from the one before by an empty line.
 * - RFC 4180 quoting, CRLF line ends, and a UTF-8 byte-order mark so that spreadsheet
 *   programs read `°` and `′` correctly.
 *
 * Pure functions except `saveText` (which needs a document) and `tableRows` (which reads a
 * table element, or anything shaped like one: the tests pass plain objects).
 */

export type CsvCell = string | number | null | undefined;

const BOM = '﻿';
const EOL = '\r\n';

/** One field, quoted when it holds a comma, a quote, a line break or edge spaces. */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Plain text for a file: ASCII minus signs, ordinary spaces, one line. */
export function cellText(text: string): string {
  return text
    .replace(/−/g, '-')
    .replace(/[    ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CsvOptions {
  /** Lines written first, each prefixed with `# `. */
  comments?: readonly string[];
  /** A UTF-8 byte-order mark at the start (default true). */
  bom?: boolean;
}

/** Rows as CSV text. */
export function rowsToCsv(rows: readonly (readonly CsvCell[])[], options: CsvOptions = {}): string {
  const lines: string[] = [];
  for (const c of options.comments ?? []) lines.push(commentLine(c));
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${options.bom === false ? '' : BOM}${lines.join(EOL)}${EOL}`;
}

/** A comment line: `# text` on one line (a comment never needs quoting). */
export function commentLine(text: string): string {
  return `# ${cellText(text)}`;
}

// ---------------------------------------------------------------------------------------
// Reading a table element

/** What `tableRows` reads: an HTMLTableElement, or a plain stand-in in tests. */
export interface CellLike {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector?(selector: string): { getAttribute(name: string): string | null } | null;
  readonly colSpan?: number;
  readonly tagName?: string;
}

export interface RowLike {
  readonly cells: ArrayLike<CellLike>;
}

export interface TableLike {
  readonly rows: ArrayLike<RowLike>;
  readonly caption?: { readonly textContent: string | null } | null;
}

/** The value a cell contributes: its `data-csv`, or that of the first element inside it that has one, or its text. */
export function cellValue(cell: CellLike): string {
  const own = cell.getAttribute('data-csv');
  if (own !== null) return cellText(own);
  const inner = cell.querySelector?.('[data-csv]')?.getAttribute('data-csv');
  if (inner !== null && inner !== undefined) return cellText(inner);
  return cellText(cell.textContent ?? '');
}

/** A row that only groups the rows below it (a month heading). */
function isGroupRow(row: RowLike): boolean {
  const cells = Array.from(row.cells);
  return cells.length === 1 && cells[0]!.getAttribute('scope') === 'rowgroup';
}

/** The table's rows as text, header row first, grouping rows left out, spans filled with empty fields. */
export function tableRows(table: TableLike): string[][] {
  const out: string[][] = [];
  for (const row of Array.from(table.rows)) {
    if (isGroupRow(row)) continue;
    const cells: string[] = [];
    for (const cell of Array.from(row.cells)) {
      cells.push(cellValue(cell));
      const span = Math.max(1, Math.floor(cell.colSpan ?? 1));
      for (let k = 1; k < span; k += 1) cells.push('');
    }
    out.push(cells);
  }
  return out;
}

/** Several tables in one file: the comments first, then each table, named by its caption. */
export function tablesToCsv(tables: readonly TableLike[], comments: readonly string[] = [], options: { bom?: boolean } = {}): string {
  const lines: string[] = comments.map(commentLine);
  tables.forEach((table, i) => {
    const caption = cellText(table.caption?.textContent ?? '');
    if (i > 0) lines.push('');
    if (caption && (i > 0 || tables.length > 1)) lines.push(commentLine(caption));
    for (const row of tableRows(table)) lines.push(row.map(csvField).join(','));
  });
  return `${options.bom === false ? '' : BOM}${lines.join(EOL)}${EOL}`;
}

// ---------------------------------------------------------------------------------------
// File names and saving

/** Lower-case words joined by dashes, safe in a file name on every system: `sun-path-2026-09-24`. */
export function fileSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** `skyfix-sun-path-2026-09-24.csv` from its parts (empty parts are skipped). */
export function fileName(parts: readonly (string | number | null | undefined)[], extension: string): string {
  const stem = ['skyfix', ...parts]
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .map((p) => fileSlug(String(p)))
    .filter(Boolean)
    .join('-');
  return `${stem}.${extension.replace(/^\./, '')}`;
}

/** Hand a blob to the browser as a download named `name` (nothing leaves the device). */
export function saveBlob(blob: Blob, name: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.append(a);
  a.click();
  a.remove();
  // Long enough for every browser to have started the download.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Save text as a file (CSV by default). */
export function saveText(text: string, name: string, type = 'text/csv;charset=utf-8'): void {
  saveBlob(new Blob([text], { type }), name);
}
