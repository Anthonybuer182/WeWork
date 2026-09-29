/**
 * The xlsx edit path: read a workbook, change a cell, confirm it landed and
 * that nothing else moved.
 *
 * This pins the thing that made xlsx editing look impossible — GenOffice's
 * save path is named `saveWorkbookViaSidecar` and the Rust sidecar cannot be
 * spawned here. It turns out the sidecar is only the archive transport: the
 * planner takes an `EntrySource`, and `backend/xlsx.ts` supplies one over JSZip.
 * If someone later "simplifies" that module back onto the sidecar, or the
 * vendored gateway changes which transport abstraction it takes, these
 * assertions are what notice.
 *
 * What is actually being pinned:
 *   - a workbook round-trips: read gives addresses, the addresses are what an
 *     edit takes
 *   - an edit lands, and survives a re-read
 *   - the edit is SURGICAL: the other cells and the other sheets are untouched
 *   - an unknown sheet is refused rather than silently ignored
 */
import JSZip from 'jszip';
import { applyXlsxEdits, readXlsxStructure } from '../src/backend/xlsx';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * A workbook with two sheets, so "only the targeted sheet changed" is testable.
 *
 * Written out longhand rather than with a spreadsheet library: the fixture then
 * does not share code with the thing under test, and the cells are inline
 * strings so there is no sharedStrings table to get wrong.
 */
async function fixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  zip.file('xl/workbook.xml', XML +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    '<sheet name="Sheet1" sheetId="1" r:id="rId1"/>' +
    '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>' +
    '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '</Relationships>');
  const cell = (ref: string, text: string | number) =>
    typeof text === 'number'
      ? `<c r="${ref}"><v>${text}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  zip.file('xl/worksheets/sheet1.xml', XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    `<row r="1">${cell('A1', '项目')}${cell('B1', '金额')}${cell('C1', '备注')}</row>` +
    `<row r="2">${cell('A2', '差旅')}${cell('B2', 1200)}${cell('C2', 'Q3')}</row>` +
    `<row r="3">${cell('A3', '办公')}${cell('B3', 340)}${cell('C3', 'Q3')}</row>` +
    '</sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    `<row r="1">${cell('A1', '另一张表')}</row>` +
    `<row r="2">${cell('A2', '不许动我')}</row>` +
    '</sheetData></worksheet>');
  return zip.generateAsync({ type: 'uint8array' });
}

const cellAt = (sheets: Awaited<ReturnType<typeof readXlsxStructure>>, sheet: string, address: string) =>
  sheets.find((s) => s.name === sheet)?.cells.find((c) => c.address === address);

console.log('xlsx edit path\n');

// ── read ────────────────────────────────────────────────────────────────
const input = await fixture();
const before = await readXlsxStructure(input);
console.log(`  fixture: ${before.length} sheet(s) — ${before.map((s) => `${s.name}(${s.cells.length})`).join(', ')}`);

check('the workbook has both sheets', before.length === 2, `got ${before.length}`);
check('the first sheet is addressable by name', before[0]?.name === 'Sheet1', `got ${before[0]?.name}`);
check('a known cell reads back its value', cellAt(before, 'Sheet1', 'A2')?.value === '差旅',
  `got ${JSON.stringify(cellAt(before, 'Sheet1', 'A2')?.value)}`);
check('a numeric cell stays numeric', cellAt(before, 'Sheet1', 'B2')?.value === 1200,
  `got ${JSON.stringify(cellAt(before, 'Sheet1', 'B2')?.value)}`);

// ── edit ────────────────────────────────────────────────────────────────
const edited = await applyXlsxEdits(input, [
  { sheet: 'Sheet1', cell: 'B2', value: 4321 },
]);
check('an edit produces different bytes', edited.byteLength !== input.byteLength || !edited.every((b, i) => b === input[i]));

const after = await readXlsxStructure(edited);
check('the edit survives a re-read', cellAt(after, 'Sheet1', 'B2')?.value === 4321,
  `got ${JSON.stringify(cellAt(after, 'Sheet1', 'B2')?.value)}`);
check('the edited cell is written as a number', typeof cellAt(after, 'Sheet1', 'B2')?.value === 'number');

// ── surgical ────────────────────────────────────────────────────────────
check('a neighbouring cell is untouched', cellAt(after, 'Sheet1', 'A2')?.value === '差旅',
  `got ${JSON.stringify(cellAt(after, 'Sheet1', 'A2')?.value)}`);
check('a header cell is untouched', cellAt(after, 'Sheet1', 'C1')?.value === '备注');
check('the second sheet is untouched', cellAt(after, 'Sheet2', 'A2')?.value === '不许动我',
  `got ${JSON.stringify(cellAt(after, 'Sheet2', 'A2')?.value)}`);
check('both sheets still exist', after.length === 2);

// ── refusals ────────────────────────────────────────────────────────────
let refused = false;
try {
  await applyXlsxEdits(input, [{ sheet: 'NoSuchSheet', cell: 'A1', value: 'x' }]);
} catch {
  refused = true;
}
check('an unknown sheet is refused, not ignored', refused);

let badAddress = false;
try {
  await applyXlsxEdits(input, [{ sheet: 'Sheet1', cell: 'not-an-address', value: 'x' }]);
} catch {
  badAddress = true;
}
check('a malformed address is refused', badAddress);

// ── producer quirks ─────────────────────────────────────────────────────
//
// OpenXML-SDK-family writers bind the spreadsheetml namespace to a prefix and
// sometimes emit a BOM. The gateway's patch pipeline matches unprefixed element
// names, so without normalization in the EntrySource a perfectly valid workbook
// fails with the misleading `Sheet "Sheet1" was not found in workbook.xml`.
// Real files do this — this is the case that was found by hand.
async function prefixed(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  for (const name of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
    const xml = await zip.file(name)!.async('string');
    // The real shape: the namespace is BOUND to the prefix
    // (`xmlns:x="…spreadsheetml…"`), and elements use it. Renaming the tags
    // without moving the binding would just be invalid XML.
    const rewritten = xml
      .replace(/xmlns="([^"]+)"/g, 'xmlns:x="$1"')
      .replace(/<(\/?)([a-zA-Z]+)([\s/>])/g, '<$1x:$2$3');
    zip.file(name, '﻿' + rewritten);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

const quirky = await prefixed(input);
const quirkyEdited = await applyXlsxEdits(quirky, [{ sheet: 'Sheet1', cell: 'C2', value: 'Q4' }]);
const quirkyAfter = await readXlsxStructure(quirkyEdited);
check('a namespace-prefixed workbook can be edited', cellAt(quirkyAfter, 'Sheet1', 'C2')?.value === 'Q4',
  `got ${JSON.stringify(cellAt(quirkyAfter, 'Sheet1', 'C2')?.value)}`);
check('the prefixed workbook keeps its other cells',
  cellAt(quirkyAfter, 'Sheet1', 'A2')?.value === '差旅' && cellAt(quirkyAfter, 'Sheet1', 'B2')?.value === 1200);

console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
