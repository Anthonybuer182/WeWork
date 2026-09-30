/**
 * xlsx reading and editing, on GenOffice's own gateway.
 *
 * GenOffice's save path is called `saveWorkbookViaSidecar`, but the sidecar is
 * only the archive transport. The work is `planCellEditsToXlsx`, which takes a
 * plain `EntrySource` — in that interface's own words, "read access to the
 * entries of a source package, independent of whether the bytes live in an
 * in-memory JSZip buffer or behind the sidecar" — and hands back a
 * `MutationPlan` of what to replace, add and drop. Implementing that interface
 * over JSZip is the whole difference, and it is three methods.
 *
 * That is why this plugin can edit xlsx at all. The renderer's READ model had
 * to settle for SheetJS because the Rust sidecar cannot be spawned here; the
 * write path never needed it, because GenOffice designed the transports as
 * swappable and we simply supply the other one.
 *
 * Nothing in vendor/ is modified — this file only calls into it.
 */
import JSZip from 'jszip';
import {
  planCellEditsToXlsx,
  readBasicWorkbook,
} from '@genoffice/xlsx-gateway/gateway/xlsx-gateway';
import { normalizeOoxmlPartPrefix } from '@genoffice/xlsx-gateway/gateway/xlsx-namespace';
import type { CellEdit, EntrySource } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway';
// The gateway consumes `CellState` but does not re-export it — it is declared in
// the domain types, so that is where it has to be read from.
import type { CellState } from '@genoffice/xlsx-gateway/domain/workbook.types';

/**
 * An `EntrySource` over an already-parsed archive.
 *
 * Text is normalized on the way out, which is where the gateway expects it: its
 * patch pipeline matches unprefixed element names, while OpenXML-SDK-family
 * producers bind the spreadsheetml namespace to a prefix (`<x:workbook>`,
 * `<x:sheetData>`) that the matcher cannot see. Without this, editing a
 * perfectly valid workbook fails with the misleading `Sheet "Sheet1" was not
 * found in workbook.xml`. Normalizing on read is also safe for the rest of the
 * file: only entries the planner rewrites are written back, so untouched parts
 * keep their original bytes.
 */
function zipEntrySource(zip: JSZip): EntrySource {
  return {
    paths: async () => Object.keys(zip.files),
    has: async (path) => zip.file(path) !== null,
    readText: async (path) => {
      const file = zip.file(path);
      if (!file) throw new Error(`workbook is missing ${path}`);
      // A leading BOM is another producer quirk that defeats the same matcher.
      return normalizeOoxmlPartPrefix((await file.async('string')).replace(/^﻿/, ''));
    },
  };
}

/** One cell as the agent sees it. */
export interface CellView {
  address: string;
  value: string | number | boolean | null;
  formula?: string;
}

export interface SheetView {
  id: string;
  name: string;
  cells: CellView[];
}

/**
 * The workbook's structure for `office_read`.
 *
 * Addresses are what an edit targets, so they are the point of this call: an
 * agent reads first, then edits by address, rather than guessing at a layout
 * it cannot see.
 */
export async function readXlsxStructure(bytes: Uint8Array): Promise<SheetView[]> {
  const { snapshot } = await readBasicWorkbook(Buffer.from(bytes));
  return snapshot.sheets.map((sheet) => ({
    id: sheet.id,
    name: sheet.name,
    cells: Object.entries(sheet.cells).map(([address, cell]) => ({
      address,
      value: cell.value,
      ...(cell.formula ? { formula: cell.formula } : {}),
    })),
  }));
}

/** An op as the agent writes it — flatter than the gateway's `CellEdit`. */
export interface CellOp {
  /** Sheet name as returned by office_read. */
  sheet: string;
  /** A1-style address, e.g. "B7". */
  cell: string;
  /** The new value. `null` clears the cell. */
  value: string | number | boolean | null;
}

/** "B7" → { row, column } (0-based, as the gateway counts). */
function addressToRowColumn(address: string): { row: number; column: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(address.trim());
  if (!match) throw new Error(`not an A1-style address: ${address}`);
  const [, letters, digits] = match as unknown as [string, string, string];
  let column = 0;
  for (const ch of letters.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: Number(digits) - 1, column: column - 1 };
}

function toCellEdit(op: CellOp): CellEdit {
  const { row, column } = addressToRowColumn(op.cell);
  const cell: CellState = { value: op.value };
  return {
    sheetName: op.sheet,
    row,
    column,
    writeValue: true,
    cell,
  };
}

/** What a batch of cell ops would change, without writing anything. */
export interface XlsxEditPlan {
  touchedEntries: string[];
  addedEntries: string[];
  removedEntries: string[];
}

/** Plan only — the `dryRun` half of an edit. */
export async function planXlsxEdits(
  bytes: Uint8Array,
  ops: readonly CellOp[],
): Promise<XlsxEditPlan> {
  if (ops.length === 0) throw new Error('no ops to apply');
  const zip = await JSZip.loadAsync(bytes);
  const plan = await planCellEditsToXlsx(zipEntrySource(zip), ops.map(toCellEdit));
  return {
    touchedEntries: [...plan.touchedEntries],
    addedEntries: [...plan.addedEntries],
    removedEntries: [...plan.removedEntries],
  };
}

/**
 * Apply cell ops and return the new workbook bytes.
 *
 * The plan is applied by hand rather than through `saveWorkbookViaSidecar`:
 * that function is built around a streaming archive client with temp files and
 * CRC verification for a write path that may not fit in memory. Here it always
 * is in memory, so the plan is a handful of map operations on the JSZip
 * instance that produced the source in the first place.
 */
export async function applyXlsxEdits(
  bytes: Uint8Array,
  ops: readonly CellOp[],
): Promise<Uint8Array> {
  if (ops.length === 0) throw new Error('no ops to apply');
  const zip = await JSZip.loadAsync(bytes);
  const plan = await planCellEditsToXlsx(
    zipEntrySource(zip),
    ops.map(toCellEdit),
  );

  for (const name of plan.removedEntries) zip.remove(name);
  for (const [name, text] of plan.replaced) zip.file(name, text);
  for (const [name, text] of plan.added) zip.file(name, text);
  for (const [name, data] of plan.addedBinary) zip.file(name, data);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
