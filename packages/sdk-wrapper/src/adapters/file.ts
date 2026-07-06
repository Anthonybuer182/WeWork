import type { FileService, FileEntry, FileContent, OfficeContent, DocxContent, XlsxContent, XlsxSheet, XlsxRow, XlsxCell, PptxContent, PptxSlide, PptxShape, PptxParagraph, PptxTextRun, PptxShapeFill, PptxShapeOutline, PptxTable, PptxTableCell, PptxTableRow } from '../services/file.js';
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.sql': 'sql',
};

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif',
  '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
  '.mp4', '.avi', '.mov', '.wmv', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
]);

const MIME_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

export function createRealFileService(): FileService {
  return {
    async list(workspaceId: string, dirPath?: string): Promise<FileEntry[]> {
      const dir = dirPath || workspaceId;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          path: join(dir, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? statSync(join(dir, entry.name)).size : undefined,
          modifiedAt: statSync(join(dir, entry.name)).mtime.toISOString(),
        }));
      } catch {
        return [];
      }
    },

    async read(_workspaceId: string, filePath: string): Promise<FileContent> {
      const ext = extname(filePath).toLowerCase();
      const isBinary = BINARY_EXTENSIONS.has(ext);
      const stat = statSync(filePath);

      if (isBinary) {
        const buffer = readFileSync(filePath);
        const content = buffer.toString('base64');
        return {
          path: filePath,
          content,
          encoding: 'base64',
          mimeType: MIME_TYPE_MAP[ext],
          size: stat.size,
        };
      }

      const content = readFileSync(filePath, 'utf-8');
      return {
        path: filePath,
        content,
        encoding: 'utf-8',
        language: LANGUAGE_MAP[ext],
        size: stat.size,
      };
    },

    async write(_workspaceId: string, filePath: string, content: string): Promise<void> {
      writeFileSync(filePath, content, 'utf-8');
    },

    async delete(_workspaceId: string, filePath: string): Promise<void> {
      unlinkSync(filePath);
    },

    async readOffice(_workspaceId: string, filePath: string): Promise<OfficeContent> {
      const ext = extname(filePath).toLowerCase();
      const buffer = readFileSync(filePath);
      const stat = statSync(filePath);

      if (ext === '.docx') {
        return { path: filePath, size: stat.size, doc: parseDocx(buffer) };
      }
      if (ext === '.xlsx') {
        return { path: filePath, size: stat.size, doc: await parseXlsx(buffer) };
      }
      if (ext === '.pptx') {
        return { path: filePath, size: stat.size, doc: parsePptx(buffer) };
      }

      throw new Error(`Unsupported Office file type: ${ext}`);
    },
  };
}

// --- Office parsing helpers ---

/** DOCX: return raw base64 data for client-side docx-preview rendering */
function parseDocx(buffer: Buffer): DocxContent {
  return { type: 'docx', data: buffer.toString('base64') };
}

/** XLSX: parse with exceljs to extract complete style data */
async function parseXlsx(buffer: Buffer): Promise<XlsxContent> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // Fallback: if exceljs can't parse (e.g. minimal xlsx from SheetJS),
    // return empty sheets with a message
    return {
      type: 'xlsx',
      sheets: [{
        name: 'Sheet1',
        columns: [],
        merges: [],
        rows: [{ height: undefined, cells: [{ value: 'Unable to parse this spreadsheet format' }] }],
      }],
    };
  }

  const sheets: XlsxSheet[] = [];

  for (const worksheet of workbook.worksheets) {
    const merges: XlsxContent['sheets'][0]['merges'] = [];
    // Extract merge ranges from worksheet model
    const mergeModel = (worksheet as any).model?.merges;
    if (Array.isArray(mergeModel)) {
      for (const merge of mergeModel) {
        if (merge && merge.top !== undefined && merge.left !== undefined && merge.bottom !== undefined && merge.right !== undefined) {
          merges.push({ top: merge.top, left: merge.left, bottom: merge.bottom, right: merge.right });
        }
      }
    }

    // Extract column widths
    const columns: { width?: number }[] = [];
    const colCount = worksheet.columnCount;
    for (let c = 1; c <= colCount; c++) {
      const col = worksheet.getColumn(c);
      const width = col.width;
      columns.push({ width: typeof width === 'number' ? width : undefined });
    }

    // Extract rows and cell data
    const rows: XlsxRow[] = [];
    const rowCount = worksheet.rowCount;
    for (let r = 1; r <= rowCount; r++) {
      const row = worksheet.getRow(r);
      const cells: XlsxCell[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        cells.push(extractXlsxCell(cell, r));
      }
      rows.push({
        height: row.height ?? undefined,
        cells,
      });
    }

    sheets.push({ name: worksheet.name, columns, merges, rows, freeze: extractFreeze(worksheet), defaultFont: extractDefaultFont(workbook) });
  }

  return { type: 'xlsx', sheets };
}

function extractFreeze(worksheet: any): XlsxSheet['freeze'] | undefined {
  const views = worksheet.views;
  if (!Array.isArray(views)) return undefined;
  for (const view of views) {
    if (view.state === 'frozen' || view.state === 'frozenSplit') {
      return {
        xSplit: view.xSplit ?? 0,
        ySplit: view.ySplit ?? 0,
        topLeftCell: view.topLeftCell ?? '',
      };
    }
  }
  return undefined;
}

function extractDefaultFont(workbook: any): { name?: string; size?: number } | undefined {
  // Try to get default font from workbook model
  try {
    const model = workbook.model;
    if (model?.wbProperties?.defaultFont) {
      return model.wbProperties.defaultFont;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function extractXlsxCell(cell: any, rowIdx: number): XlsxCell {
  // Get value as string
  let value = '';
  const isDate = cell.value instanceof Date;
  if (cell.value === null || cell.value === undefined) {
    value = '';
  } else if (typeof cell.value === 'string') {
    value = cell.value;
  } else if (typeof cell.value === 'number') {
    value = String(cell.value);
  } else if (typeof cell.value === 'boolean') {
    value = cell.value ? 'TRUE' : 'FALSE';
  } else if (cell.value instanceof Date) {
    value = cell.value.toLocaleDateString();
  } else if (typeof cell.value === 'object') {
    // Formula result or rich text
    if (cell.value.result !== undefined && cell.value.result !== null) {
      if (cell.value.result instanceof Date) {
        value = cell.value.result.toLocaleDateString();
      } else {
        value = String(cell.value.result);
      }
    } else if (cell.value.richText && Array.isArray(cell.value.richText)) {
      value = cell.value.richText.map((rt: any) => rt.text || '').join('');
    } else if (cell.value.text) {
      value = cell.value.text;
    } else {
      value = String(cell.value);
    }
  } else {
    value = String(cell.value);
  }

  // Apply number format if available
  const numFmt = cell.numFmt;
  if (numFmt && cell.value !== null && cell.value !== undefined) {
    try {
      if (isDate || cell.value instanceof Date) {
        value = formatDate(cell.value, numFmt);
      } else if (typeof cell.value === 'number') {
        value = formatNumber(cell.value, numFmt);
      }
    } catch {
      // keep original
    }
  }

  const result: XlsxCell = { value };

  // Font
  if (cell.font) {
    const font: XlsxCell['font'] = {};
    if (cell.font.name) font.name = cell.font.name;
    if (cell.font.size) font.size = cell.font.size;
    if (cell.font.bold) font.bold = true;
    if (cell.font.italic) font.italic = true;
    if (cell.font.color?.argb) {
      // argb format: AARRGGBB, strip alpha for CSS
      const argb = cell.font.color.argb;
      font.color = argb.length === 8 ? argb.slice(2) : argb;
    } else if (cell.font.color?.rgb) {
      font.color = cell.font.color.rgb;
    }
    if (Object.keys(font).length > 0) result.font = font;
  }

  // Fill
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid') {
    const fgColor = cell.fill.fgColor;
    if (fgColor?.argb) {
      const argb = fgColor.argb;
      result.fill = { color: argb.length === 8 ? argb.slice(2) : argb };
    } else if (fgColor?.rgb) {
      result.fill = { color: fgColor.rgb };
    }
  }

  // Border
  if (cell.border) {
    const border: XlsxCell['border'] = {};
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const b = cell.border[side];
      if (b && b.style && b.style !== 'none') {
        const borderSide: NonNullable<XlsxCell['border']>[typeof side] = { style: b.style as any };
        if (b.color?.argb) {
          const argb = b.color.argb;
          borderSide.color = argb.length === 8 ? argb.slice(2) : argb;
        } else if (b.color?.rgb) {
          borderSide.color = b.color.rgb;
        }
        border[side] = borderSide;
      }
    }
    if (Object.keys(border).length > 0) result.border = border;
  }

  // Alignment
  if (cell.alignment) {
    const alignment: XlsxCell['alignment'] = {};
    if (cell.alignment.horizontal) alignment.horizontal = cell.alignment.horizontal;
    if (cell.alignment.vertical) alignment.vertical = cell.alignment.vertical;
    if (cell.alignment.wrapText) alignment.wrapText = true;
    if (cell.alignment.textRotation) alignment.textRotation = cell.alignment.textRotation;
    if (Object.keys(alignment).length > 0) result.alignment = alignment;
  }

  return result;
}

function formatNumber(value: number, fmt: string): string {
  // Simple number format handling
  if (fmt.includes('0.00')) {
    return value.toFixed(2);
  }
  if (fmt.includes('#,##0') || fmt.includes('#,0')) {
    return value.toLocaleString();
  }
  if (fmt.includes('%')) {
    return (value * 100).toFixed(fmt.includes('0.0') ? 1 : 0) + '%';
  }
  // Currency formats
  if (fmt.includes('"¥"') || fmt.includes('[$¥]')) {
    return '¥' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (fmt.includes('"$"') || fmt.includes('[$$]')) {
    return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (fmt.includes('"€"') || fmt.includes('[$€]')) {
    return '€' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

function formatDate(date: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const yy = String(yyyy).slice(-2);
  const mm = pad(date.getMonth() + 1);
  const m = String(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const d = String(date.getDate());
  const hh = pad(date.getHours());
  const h = String(date.getHours());
  const nn = pad(date.getMinutes()); // minutes
  const ss = pad(date.getSeconds());

  // Common date format patterns
  let result = fmt;

  // Replace year
  result = result.replace(/yyyy/g, String(yyyy));
  result = result.replace(/yy/g, yy);

  // Replace month
  result = result.replace(/mmmm/g, date.toLocaleString('en', { month: 'long' }));
  result = result.replace(/mmm/g, date.toLocaleString('en', { month: 'short' }));
  result = result.replace(/mm/g, mm);
  result = result.replace(/\bm\b/g, m);

  // Replace day
  result = result.replace(/dddd/g, date.toLocaleString('en', { weekday: 'long' }));
  result = result.replace(/ddd/g, date.toLocaleString('en', { weekday: 'short' }));
  result = result.replace(/dd/g, dd);
  result = result.replace(/\bd\b/g, d);

  // Replace time
  result = result.replace(/hh/g, hh);
  result = result.replace(/\bh\b/g, h);
  result = result.replace(/nn/g, nn);
  result = result.replace(/ss/g, ss);

  // Remove escaped chars and format codes
  result = result.replace(/[\\\[\]]/g, '');
  result = result.replace(/"[^"]*"/g, '');

  // Remove remaining format codes like ;@ or ;(
  result = result.replace(/[;@]/g, '').trim();

  return result || date.toLocaleDateString();
}

// --- PPTX deep parsing ---

const EMU_PER_POINT = 12700; // 1pt = 12700 EMU

/** Parse theme colors from ppt/theme/theme1.xml */
function parseThemeColors(zip: AdmZip): Map<string, string> {
  const themeMap = new Map<string, string>();
  const themeEntry = zip.getEntry('ppt/theme/theme1.xml');
  if (!themeEntry) return themeMap;

  const xml = themeEntry.getData().toString('utf-8');

  // Extract color scheme from <a:clrScheme>
  const clrSchemeMatch = xml.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
  if (!clrSchemeMatch) return themeMap;

  const clrXml = clrSchemeMatch[1];

  // Map each scheme color: dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink
  const colorNames = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  for (const name of colorNames) {
    // Match <a:dk1>...<a:srgbClr val="..."/> or <a:sysClr val="..." lastClr="..."/>
    const colorElemMatch = clrXml.match(new RegExp(`<a:${name}[^>]*>([\\s\\S]*?)<\\/a:${name}>`));
    if (colorElemMatch) {
      const colorXml = colorElemMatch[1];
      // srgbClr
      const srgbMatch = colorXml.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
      if (srgbMatch) {
        themeMap.set(name, srgbMatch[1]);
        continue;
      }
      // sysClr with lastClr
      const sysClrMatch = colorXml.match(/<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/);
      if (sysClrMatch) {
        themeMap.set(name, sysClrMatch[1]);
        continue;
      }
    }
  }

  // Also map aliases: tx1=dk1, tx2=dk2, bg1=lt1, bg2=lt2
  if (themeMap.has('dk1')) themeMap.set('tx1', themeMap.get('dk1')!);
  if (themeMap.has('lt1')) themeMap.set('bg1', themeMap.get('lt1')!);
  if (themeMap.has('dk2')) themeMap.set('tx2', themeMap.get('dk2')!);
  if (themeMap.has('lt2')) themeMap.set('bg2', themeMap.get('lt2')!);

  return themeMap;
}

/** System color name to hex mapping */
const SYS_COLOR_MAP: Record<string, string> = {
  windowText: '000000', window: 'FFFFFF', grayText: '808080',
  buttonText: '000000', buttonFace: 'F0F0F0', buttonShadow: '808080',
  captionText: '000000', activeCaption: '99B4D1', inactiveCaption: 'BFC8D6',
  highlight: '3399FF', highlightText: '000000', inactiveBorder: 'F0F0F0',
  activeBorder: 'B4B4B4', infoText: '000000', infoBk: 'FFFFE1',
  menuText: '000000', menu: 'F0F0F0', scrollbar: 'C8C8C8',
  menuBar: 'F0F0F0', menuHighlight: '3399FF',
};

/** Preset color name to hex mapping (subset of most common) */
const PRST_COLOR_MAP: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF', gray: '808080', grey: '808080',
  darkGray: 'A9A9A9', darkGrey: 'A9A9A9', lightGray: 'D3D3D3', lightGrey: 'D3D3D3',
  darkRed: '8B0000', darkGreen: '006400', darkBlue: '00008B', darkYellow: '8B8B00',
  darkCyan: '008B8B', darkMagenta: '8B008B', orange: 'FFA500', pink: 'FFC0CB',
  purple: '800080', brown: 'A52A2A', olive: '808000', navy: '000080', teal: '008080',
  lime: '00FF00', gold: 'FFD700', silver: 'C0C0C0', bronze: 'CD7F32', copper: 'B87333',
  coral: 'FF7F50', salmon: 'FA8072', khaki: 'F0E68C', lavender: 'E6E6FA',
  maroon: '800000', mint: '98FF98', ivory: 'FFFFF0', ruby: 'E0115F',
  skyBlue: '87CEEB', forestGreen: '228B22', tomato: 'FF6347', turquoise: '40E0D0',
  violet: 'EE82EE', wheat: 'F5DEB3', indigo: '4B0082', crimson: 'DC143C',
  darkOliveGreen: '556B2F', darkOrange: 'FF8C00', darkOrchid: '9932CC',
  darkSalmon: 'E9967A', darkSeaGreen: '8FBC8F', darkSlateBlue: '483D8B',
  darkSlateGray: '2F4F4F', darkTurquoise: '00CED1', deepPink: 'FF1493',
  deepSkyBlue: '00BFFF', dimGray: '696969', firebrick: 'B22222',
  floralWhite: 'FFFAF0', gainsboro: 'DCDCDC', ghostWhite: 'F8F8FF',
  goldenrod: 'DAA520', greenYellow: 'ADFF2F', honeydew: 'F0FFF0',
  hotPink: 'FF69B4', indianRed: 'CD5C5C', lawnGreen: '7CFC00',
  lemonChiffon: 'FFFACD', lightBlue: 'ADD8E6', lightCoral: 'F08080',
  lightCyan: 'E0FFFF', lightGoldenrodYellow: 'FAFAD2', lightGreen: '90EE90',
  lightPink: 'FFB6C1', lightSalmon: 'FFA07A', lightSeaGreen: '20B2AA',
  lightSkyBlue: '87CEFA', lightSlateGray: '778899', lightSteelBlue: 'B0C4DE',
  lightYellow: 'FFFFE0', limeGreen: '32CD32', linen: 'FAF0E6',
  mediumAquamarine: '66CDAA', mediumBlue: '0000CD', mediumOrchid: 'BA55D3',
  mediumPurple: '9370DB', mediumSeaGreen: '3CB371', mediumSlateBlue: '7B68EE',
  mediumSpringGreen: '00FA9A', mediumTurquoise: '48D1CC', mediumVioletRed: 'C71585',
  midnightBlue: '191970', moccasin: 'FFE4B5', navajoWhite: 'FFDEAD',
  oldLace: 'FDF5E6', oliveDrab: '6B8E23', orangeRed: 'FF4500',
  orchid: 'DA70D6', paleGoldenrod: 'EEE8AA', paleGreen: '98FB98',
  paleTurquoise: 'AFEEEE', paleVioletRed: 'DB7093', papayaWhip: 'FFEFD5',
  peachPuff: 'FFDAB9', peru: 'CD853F', plum: 'DDA0DD',
  powderBlue: 'B0E0E6', rosyBrown: 'BC8F8F', royalBlue: '4169E1',
  saddleBrown: '8B4513', sandyBrown: 'F4A460', seaGreen: '2E8B57',
  seaShell: 'FFF5EE', sienna: 'A0522D', slateBlue: '6A5ACD',
  slateGray: '708090', snow: 'FFFAFA', springGreen: '00FF7F',
  steelBlue: '4682B4', tan: 'D2B48C', thistle: 'D8BFD8',
  darkKhaki: 'BDB76B', darkViolet: '9400D3', chartreuse: '7FFF00',
  aqua: '00FFFF', aquamarine: '7FFFD4', azure: 'F0FFFF', beige: 'F5F5DC',
  bisque: 'FFE4C4', blanchedAlmond: 'FFEBCD', blueViolet: '8A2BE2',
  burlyWood: 'DEB887', cadetBlue: '5F9EA0', chocolate: 'D2691E',
  cornflowerBlue: '6495ED', cornsilk: 'FFF8DC',
  DodgerBlue: '1E90FF',
};

/** Resolve color from XML containing any color element type (srgbClr, schemeClr, sysClr, prstClr) */
function resolveColor(xml: string, themeColors: Map<string, string>): string | undefined {
  // srgbClr - direct hex value
  const srgbMatch = xml.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
  if (srgbMatch) return srgbMatch[1];

  // schemeClr - theme color reference
  const schemeMatch = xml.match(/<a:schemeClr\s+val="(\w+)"/);
  if (schemeMatch) {
    const color = themeColors.get(schemeMatch[1]);
    if (color) return color;
  }

  // sysClr - system color
  const sysMatch = xml.match(/<a:sysClr\s+val="(\w+)"[^>]*lastClr="([0-9A-Fa-f]{6})"/);
  if (sysMatch) return sysMatch[2]; // Use lastClr (the actual RGB value)
  const sysMatch2 = xml.match(/<a:sysClr\s+val="(\w+)"/);
  if (sysMatch2) return SYS_COLOR_MAP[sysMatch2[1]];

  // prstClr - preset color
  const prstMatch = xml.match(/<a:prstClr\s+val="(\w+)"/);
  if (prstMatch) return PRST_COLOR_MAP[prstMatch[1]];

  return undefined;
}

/** PPTX: deep parse OOXML to extract shapes, images, backgrounds, text formatting */
function parsePptx(buffer: Buffer): PptxContent {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // Parse theme colors for schemeClr resolution
  const themeColors = parseThemeColors(zip);

  // Read presentation.xml for slide dimensions
  let slideWidth = 9144000; // default 10in
  let slideHeight = 6858000; // default 7.5in
  const presXmlEntry = entries.find((e) => e.entryName === 'ppt/presentation.xml');
  if (presXmlEntry) {
    const presXml = presXmlEntry.getData().toString('utf-8');
    const sldSzMatch = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (sldSzMatch) {
      slideWidth = parseInt(sldSzMatch[1]);
      slideHeight = parseInt(sldSzMatch[2]);
    }
  }

  // Find all slide files sorted by index
  const slideEntries = entries
    .filter((e) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/i))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)/)?.[1] ?? '0');
      const nb = parseInt(b.entryName.match(/slide(\d+)/)?.[1] ?? '0');
      return na - nb;
    });

  // Parse notes
  const notesMap = new Map<number, string>();
  const noteEntries = entries.filter((e) => e.entryName.match(/^ppt\/notesSlides\/notesSlide\d+\.xml$/i));
  for (const note of noteEntries) {
    const idx = parseInt(note.entryName.match(/notesSlide(\d+)/)?.[1] ?? '0');
    const xml = note.getData().toString('utf-8');
    const texts = extractXmlTexts(xml);
    notesMap.set(idx, texts.join(' ').trim());
  }

  const slides: PptxSlide[] = [];

  for (const entry of slideEntries) {
    const index = parseInt(entry.entryName.match(/slide(\d+)/)?.[1] ?? '0');
    const xml = entry.getData().toString('utf-8');
    const slide = parseSlideXml(xml, index, zip, entries, themeColors);
    slide.notes = notesMap.get(index) ?? '';
    slides.push(slide);
  }

  return { type: 'pptx', slideWidth, slideHeight, slides };
}

function parseSlideXml(xml: string, index: number, zip: AdmZip, entries: any[], themeColors: Map<string, string>): PptxSlide {
  const shapes: PptxShape[] = [];

  // Parse background
  let background: PptxSlide['background'];
  const bgMatch = xml.match(/<p:bg[^>]*>([\s\S]*?)<\/p:bg>/);
  if (bgMatch) {
    const bgXml = bgMatch[1];
    // Solid fill - use resolveColor for theme color support
    const solidColor = resolveColor(bgXml, themeColors);
    if (solidColor && bgXml.includes('solidFill')) {
      background = { type: 'solid', color: solidColor };
    }
    // Gradient fill
    const gradMatch = bgXml.match(/<a:gradFill[^>]*>([\s\S]*?)<\/a:gradFill>/);
    if (gradMatch) {
      const stops = parseGradientStops(gradMatch[1], themeColors);
      if (stops.length > 0) {
        background = { type: 'gradient', stops };
      }
    }
  }

  // Parse relationships file to resolve image references
  const slideRelsPath = `ppt/slides/_rels/slide${index}.xml.rels`;
  const relsEntry = entries.find((e) => e.entryName === slideRelsPath);
  const relsMap = new Map<string, string>(); // rId -> target path
  if (relsEntry) {
    const relsXml = relsEntry.getData().toString('utf-8');
    const relRegex = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRegex.exec(relsXml)) !== null) {
      relsMap.set(rm[1], rm[2]);
    }
  }

  // Parse shapes (text shapes: <p:sp>)
  const spRegex = /<p:sp[^>]*>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = spRegex.exec(xml)) !== null) {
    const spXml = spMatch[1];
    const shape = parseTextShape(spXml, themeColors);
    if (shape) shapes.push(shape);
  }

  // Parse pictures (<p:pic>)
  const picRegex = /<p:pic[^>]*>([\s\S]*?)<\/p:pic>/g;
  let picMatch: RegExpExecArray | null;
  while ((picMatch = picRegex.exec(xml)) !== null) {
    const picXml = picMatch[1];
    const shape = parsePicShape(picXml, relsMap, zip);
    if (shape) shapes.push(shape);
  }

  // Parse group shapes (<p:grpSp>)
  const grpSpRegex = /<p:grpSp[^>]*>([\s\S]*?)<\/p:grpSp>/g;
  let grpMatch: RegExpExecArray | null;
  while ((grpMatch = grpSpRegex.exec(xml)) !== null) {
    const grpXml = grpMatch[1];
    const groupShape = parseGroupShape(grpXml, relsMap, zip, themeColors);
    if (groupShape) shapes.push(groupShape);
  }

  // Parse graphic frames (tables: <p:graphicFrame>)
  const gfRegex = /<p:graphicFrame[^>]*>([\s\S]*?)<\/p:graphicFrame>/g;
  let gfMatch: RegExpExecArray | null;
  while ((gfMatch = gfRegex.exec(xml)) !== null) {
    const gfXml = gfMatch[1];
    const tableShape = parseTableShape(gfXml, themeColors);
    if (tableShape) shapes.push(tableShape);
  }

  return { index, background, shapes, notes: '' };
}

function parseTextShape(spXml: string, themeColors: Map<string, string>): PptxShape | null {
  // Extract position and size
  const xfrmMatch = spXml.match(/<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/);
  if (!xfrmMatch) return null;

  const offMatch = xfrmMatch[1].match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = xfrmMatch[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;

  const x = parseInt(offMatch[1]);
  const y = parseInt(offMatch[2]);
  const width = parseInt(extMatch[1]);
  const height = parseInt(extMatch[2]);

  // Check for rotation
  const xfrmTagMatch = spXml.match(/<a:xfrm\s+[^>]*rot="(\d+)"/);
  const rotation = xfrmTagMatch ? parseInt(xfrmTagMatch[1]) / 60000 : undefined;

  // Parse shape properties (fill, outline, geometry) from <p:spPr>
  const spPrMatch = spXml.match(/<p:spPr[^>]*>([\s\S]*?)<\/p:spPr>/);
  let fill: PptxShapeFill | undefined;
  let outline: PptxShapeOutline | undefined;
  let geometry: PptxShape['geometry'] | undefined;

  if (spPrMatch) {
    const spPrXml = spPrMatch[1];

    // Geometry
    const prstGeomMatch = spPrXml.match(/<a:prstGeom\s+prst="([^"]+)"/);
    if (prstGeomMatch) {
      const prst = prstGeomMatch[1];
      const validGeoms = ['rect', 'roundRect', 'ellipse', 'triangle', 'diamond', 'rtTriangle', 'chevron', 'pentagon', 'hexagon', 'octagon', 'star5'];
      geometry = (validGeoms.includes(prst) ? prst : 'custom') as PptxShape['geometry'];
    }

    // Fill
    fill = parseShapeFill(spPrXml, themeColors);

    // Outline
    outline = parseShapeOutline(spPrXml, themeColors);
  }

  // Parse text body
  const txBodyMatch = spXml.match(/<p:txBody[^>]*>([\s\S]*?)<\/p:txBody>/);
  if (!txBodyMatch) {
    return { type: 'text', x, y, width, height, paragraphs: [], rotation, fill, outline, geometry };
  }

  // Parse text anchor (vertical alignment) from <a:bodyPr>
  const bodyPrMatch = txBodyMatch[1].match(/<a:bodyPr[^>]*>/);
  let textAnchor: PptxShape['textAnchor'] | undefined;
  if (bodyPrMatch) {
    const anchorMatch = bodyPrMatch[0].match(/anchor="(t|ctr|b)"/);
    if (anchorMatch) {
      textAnchor = anchorMatch[1] === 't' ? 'top' : anchorMatch[1] === 'ctr' ? 'middle' : 'bottom';
    }
  }

  const paragraphs = parseParagraphs(txBodyMatch[1], themeColors);

  return { type: 'text', x, y, width, height, paragraphs, rotation, fill, outline, geometry, textAnchor };
}

/** Parse gradient stops from gradFill XML, resolving theme colors */
function parseGradientStops(gradXml: string, themeColors: Map<string, string>): { color: string; position: number }[] {
  const stops: { color: string; position: number }[] = [];
  const stopRegex = /<a:gs\s+pos="(\d+)">([\s\S]*?)<\/a:gs>/g;
  let sm: RegExpExecArray | null;
  while ((sm = stopRegex.exec(gradXml)) !== null) {
    const color = resolveColor(sm[2], themeColors);
    if (color) {
      stops.push({ position: parseInt(sm[1]) / 100000, color });
    }
  }
  return stops;
}

/** Parse shape fill from spPr XML: solid or gradient */
function parseShapeFill(spPrXml: string, themeColors: Map<string, string>): PptxShapeFill | undefined {
  // Solid fill - use resolveColor for theme color support
  const solidFillMatch = spPrXml.match(/<a:solidFill[^>]*>([\s\S]*?)<\/a:solidFill>/);
  if (solidFillMatch) {
    const color = resolveColor(solidFillMatch[1], themeColors);
    if (color) {
      return { type: 'solid', color };
    }
  }

  // Gradient fill
  const gradFillMatch = spPrXml.match(/<a:gradFill[^>]*>([\s\S]*?)<\/a:gradFill>/);
  if (gradFillMatch) {
    const stops = parseGradientStops(gradFillMatch[1], themeColors);
    // Parse gradient angle from <a:lin ang="..."/>
    const linMatch = gradFillMatch[1].match(/<a:lin\s+ang="(\d+)"/);
    const gradientAngle = linMatch ? parseInt(linMatch[1]) / 60000 : undefined;
    if (stops.length > 0) {
      return { type: 'gradient', stops, gradientAngle };
    }
  }

  return undefined;
}

/** Parse shape outline from spPr XML */
function parseShapeOutline(spPrXml: string, themeColors: Map<string, string>): PptxShapeOutline | undefined {
  const lnMatch = spPrXml.match(/<a:ln\s+([^>]*)>([\s\S]*?)<\/a:ln>/);
  if (!lnMatch) return undefined;

  const lnAttrs = lnMatch[1];
  const lnXml = lnMatch[2];
  const outline: PptxShapeOutline = {};

  // Width
  const wMatch = lnAttrs.match(/w="(\d+)"/);
  if (wMatch) outline.width = parseInt(wMatch[1]);

  // Dash style
  const dashMatch = lnXml.match(/<a:dash\s+val="([^"]+)"/);
  if (dashMatch) {
    const dashVal = dashMatch[1];
    if (dashVal === 'dash') outline.dashStyle = 'dash';
    else if (dashVal === 'dot') outline.dashStyle = 'dot';
    else if (dashVal === 'dashDot') outline.dashStyle = 'dashDot';
    else outline.dashStyle = 'solid';
  } else {
    outline.dashStyle = 'solid';
  }

  // Color - use resolveColor for theme color support
  const color = resolveColor(lnXml, themeColors);
  if (color) outline.color = color;

  return outline;
}

function parseParagraphs(txBodyXml: string, themeColors: Map<string, string>): PptxParagraph[] {
  const paragraphs: PptxParagraph[] = [];
  const pRegex = /<a:p[^>]*>([\s\S]*?)<\/a:p>/g;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(txBodyXml)) !== null) {
    const pXml = pMatch[1];
    const paragraph: PptxParagraph = { runs: [] };

    // Paragraph properties
    const pPrMatch = pXml.match(/<a:pPr[^>]*>([\s\S]*?)<\/a:pPr>/) || pXml.match(/<a:pPr[^>]*\/>/);
    if (pPrMatch) {
      const pPrXml = pPrMatch[1] || pPrMatch[0];
      const algnMatch = pPrXml.match(/algn="(left|center|right|justify)"/);
      if (algnMatch) paragraph.alignment = algnMatch[1] as any;
      const lvlMatch = pPrXml.match(/lvl="(\d+)"/);
      if (lvlMatch) paragraph.level = parseInt(lvlMatch[1]);

      // Line spacing: <a:lnSpc><a:spcPct val="150000"/></a:lnSpc>
      const lnSpcMatch = pPrXml.match(/<a:lnSpc[^>]*>[\s\S]*?<a:spcPct\s+val="(\d+)"/);
      if (lnSpcMatch) {
        paragraph.lineSpacing = parseInt(lnSpcMatch[1]) / 100000;
      }

      // Space before: <a:spcBef><a:spcPts val="600"/></a:spcBef>
      const spcBefMatch = pPrXml.match(/<a:spcBef[^>]*>[\s\S]*?<a:spcPts\s+val="(\d+)"/);
      if (spcBefMatch) {
        paragraph.spaceBefore = parseInt(spcBefMatch[1]) / 100;
      }

      // Space after: <a:spcAft><a:spcPts val="600"/></a:spcAft>
      const spcAftMatch = pPrXml.match(/<a:spcAft[^>]*>[\s\S]*?<a:spcPts\s+val="(\d+)"/);
      if (spcAftMatch) {
        paragraph.spaceAfter = parseInt(spcAftMatch[1]) / 100;
      }

      // Bullet: <a:buChar char="•"/> or <a:buAutoNum type="arabicPeriod"/>
      const buCharMatch = pPrXml.match(/<a:buChar\s+char="([^"]+)"/);
      if (buCharMatch) {
        paragraph.bullet = { type: 'char', char: buCharMatch[1] };
      } else {
        const buAutoNumMatch = pPrXml.match(/<a:buAutoNum\s+type="([^"]+)"/);
        if (buAutoNumMatch) {
          paragraph.bullet = { type: 'autoNum', numType: buAutoNumMatch[1] };
        }
      }
    }

    // Text runs <a:r>
    const rRegex = /<a:r[^>]*>([\s\S]*?)<\/a:r>/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rRegex.exec(pXml)) !== null) {
      const rXml = rMatch[1];
      const run = parseTextRun(rXml, themeColors);
      if (run.text) paragraph.runs.push(run);
    }

    // Also handle <a:br> line breaks
    if (/<a:br[^>]*\/>/g.test(pXml) && paragraph.runs.length > 0) {
      paragraph.runs.push({ text: '\n' });
    }

    if (paragraph.runs.length > 0) {
      paragraphs.push(paragraph);
    }
  }

  return paragraphs;
}

function parseTextRun(rXml: string, themeColors: Map<string, string>): PptxTextRun {
  const run: PptxTextRun = { text: '' };

  // Run properties <a:rPr>
  const rPrMatch = rXml.match(/<a:rPr[^>]*>/);
  if (rPrMatch) {
    const rPr = rPrMatch[0];

    const szMatch = rPr.match(/sz="(\d+)"/);
    if (szMatch) run.fontSize = parseInt(szMatch[1]) / 100; // OOXML stores font size in hundredths of a point

    const bMatch = rPr.match(/\sb="(\d)"/);
    if (bMatch) run.bold = bMatch[1] === '1';

    const iMatch = rPr.match(/\si="(\d)"/);
    if (iMatch) run.italic = iMatch[1] === '1';

    const uMatch = rPr.match(/\su="(\w+)"/);
    if (uMatch && uMatch[1] !== 'none') run.underline = true;

    // Strikethrough
    const strikeMatch = rPr.match(/\sstrike="(\w+)"/);
    if (strikeMatch && strikeMatch[1] !== 'noStrike') run.strikethrough = true;

    // Color - use resolveColor for theme color support
    const color = resolveColor(rXml, themeColors);
    if (color) run.color = color;

    // Font family
    const latinMatch = rXml.match(/<a:latin\s+typeface="([^"]+)"/);
    if (latinMatch) run.fontFamily = latinMatch[1];
  } else {
    // Check for color even without rPr
    const color = resolveColor(rXml, themeColors);
    if (color) run.color = color;
    const latinMatch = rXml.match(/<a:latin\s+typeface="([^"]+)"/);
    if (latinMatch) run.fontFamily = latinMatch[1];
  }

  // Text content <a:t>
  const tMatch = rXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/);
  if (tMatch) {
    run.text = decodeXmlEntities(tMatch[1]);
  }

  return run;
}

function parsePicShape(picXml: string, relsMap: Map<string, string>, zip: AdmZip): PptxShape | null {
  // Extract position and size
  const xfrmMatch = picXml.match(/<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/);
  if (!xfrmMatch) return null;

  const offMatch = xfrmMatch[1].match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = xfrmMatch[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;

  const x = parseInt(offMatch[1]);
  const y = parseInt(offMatch[2]);
  const width = parseInt(extMatch[1]);
  const height = parseInt(extMatch[2]);

  // Get image relationship
  const blipMatch = picXml.match(/<a:blip\s+r:embed="([^"]+)"/);
  if (!blipMatch) return null;

  const rId = blipMatch[1];
  const targetPath = relsMap.get(rId);
  if (!targetPath) return null;

  // Resolve full path (rels targets are relative to ppt/slides/)
  const rawPath = targetPath.startsWith('/')
    ? 'ppt' + targetPath
    : 'ppt/slides/' + targetPath;

  // Normalize path and resolve .. segments
  const pathParts = rawPath.replace(/\\/g, '/').split('/');
  const resolved: string[] = [];
  for (const part of pathParts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  const normalizedPath = resolved.join('/');
  const imageEntry = zip.getEntry(normalizedPath);
  if (!imageEntry) return null;

  const imageData = imageEntry.getData();
  const ext = extname(normalizedPath).toLowerCase();
  const mimeType = IMAGE_MIME_MAP[ext] ?? 'image/png';
  const base64 = imageData.toString('base64');

  return {
    type: 'image',
    x,
    y,
    width,
    height,
    image: { data: base64, mimeType },
  };
}

/** Parse group shape: extract position, child coordinate transform, and nested shapes */
function parseGroupShape(grpXml: string, relsMap: Map<string, string>, zip: AdmZip, themeColors: Map<string, string>): PptxShape | null {
  const xfrmMatch = grpXml.match(/<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/);
  if (!xfrmMatch) return null;

  const offMatch = xfrmMatch[1].match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = xfrmMatch[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  const chOffMatch = xfrmMatch[1].match(/<a:chOff\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const chExtMatch = xfrmMatch[1].match(/<a:chExt\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;

  const groupX = parseInt(offMatch[1]);
  const groupY = parseInt(offMatch[2]);
  const groupW = parseInt(extMatch[1]);
  const groupH = parseInt(extMatch[2]);

  const chOffX = chOffMatch ? parseInt(chOffMatch[1]) : 0;
  const chOffY = chOffMatch ? parseInt(chOffMatch[2]) : 0;
  const chExtW = chExtMatch ? parseInt(chExtMatch[1]) : groupW;
  const chExtH = chExtMatch ? parseInt(chExtMatch[2]) : groupH;

  const scaleX = groupW / chExtW;
  const scaleY = groupH / chExtH;

  const children: PptxShape[] = [];

  // Parse nested text shapes
  const spRegex = /<p:sp[^>]*>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = spRegex.exec(grpXml)) !== null) {
    const shape = parseTextShape(spMatch[1], themeColors);
    if (shape) {
      shape.x = groupX + (shape.x - chOffX) * scaleX;
      shape.y = groupY + (shape.y - chOffY) * scaleY;
      shape.width = shape.width * scaleX;
      shape.height = shape.height * scaleY;
      children.push(shape);
    }
  }

  // Parse nested pictures
  const picRegex = /<p:pic[^>]*>([\s\S]*?)<\/p:pic>/g;
  let picMatch: RegExpExecArray | null;
  while ((picMatch = picRegex.exec(grpXml)) !== null) {
    const shape = parsePicShape(picMatch[1], relsMap, zip);
    if (shape) {
      shape.x = groupX + (shape.x - chOffX) * scaleX;
      shape.y = groupY + (shape.y - chOffY) * scaleY;
      shape.width = shape.width * scaleX;
      shape.height = shape.height * scaleY;
      children.push(shape);
    }
  }

  return { type: 'group', x: groupX, y: groupY, width: groupW, height: groupH, children };
}

/** Parse table shape from <p:graphicFrame> */
function parseTableShape(gfXml: string, themeColors: Map<string, string>): PptxShape | null {
  // Extract position from <p:xfrm>
  const xfrmMatch = gfXml.match(/<p:xfrm[^>]*>([\s\S]*?)<\/p:xfrm>/);
  if (!xfrmMatch) return null;

  const offMatch = xfrmMatch[1].match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = xfrmMatch[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;

  const x = parseInt(offMatch[1]);
  const y = parseInt(offMatch[2]);
  const width = parseInt(extMatch[1]);
  const height = parseInt(extMatch[2]);

  // Find <a:tbl>
  const tblMatch = gfXml.match(/<a:tbl[^>]*>([\s\S]*?)<\/a:tbl>/);
  if (!tblMatch) return null;

  const tblXml = tblMatch[1];

  // Parse column widths
  const columns: { width: number }[] = [];
  const colRegex = /<a:gridCol\s+w="(\d+)"/g;
  let colMatch: RegExpExecArray | null;
  while ((colMatch = colRegex.exec(tblXml)) !== null) {
    columns.push({ width: parseInt(colMatch[1]) });
  }

  // Parse rows
  const rows: PptxTableRow[] = [];
  const trRegex = /<a:tr[^>]*h="(\d+)"[^>]*>([\s\S]*?)<\/a:tr>/g;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tblXml)) !== null) {
    const rowHeight = parseInt(trMatch[1]);
    const trXml = trMatch[2];
    const cells: PptxTableCell[] = [];

    const tcRegex = /<a:tc[^>]*>([\s\S]*?)<\/a:tc>/g;
    let tcMatch: RegExpExecArray | null;
    while ((tcMatch = tcRegex.exec(trXml)) !== null) {
      const tcXml = tcMatch[0];

      // Grid span / row span
      const gridSpanMatch = tcXml.match(/gridSpan="(\d+)"/);
      const rowSpanMatch = tcXml.match(/rowSpan="(\d+)"/);
      const colSpan = gridSpanMatch ? parseInt(gridSpanMatch[1]) : 1;
      const rowSpan = rowSpanMatch ? parseInt(rowSpanMatch[1]) : 1;

      // Cell text
      let text = '';
      const txBodyMatch = tcXml.match(/<a:txBody[^>]*>([\s\S]*?)<\/a:txBody>/);
      let parsedParagraphs: PptxParagraph[] = [];
      if (txBodyMatch) {
        parsedParagraphs = parseParagraphs(txBodyMatch[1], themeColors);
        text = parsedParagraphs
          .map((p) => p.runs.map((r) => r.text).join(''))
          .join('\n');
      }

      // Cell fill color - use resolveColor for theme color support
      let fill: string | undefined;
      const tcPrMatch = tcXml.match(/<a:tcPr[^>]*>([\s\S]*?)<\/a:tcPr>/);
      if (tcPrMatch) {
        const solidFillMatch = tcPrMatch[1].match(/<a:solidFill[^>]*>([\s\S]*?)<\/a:solidFill>/);
        if (solidFillMatch) {
          fill = resolveColor(solidFillMatch[1], themeColors);
        }
      }

      // Cell text formatting from first run
      let fontSize: number | undefined;
      let color: string | undefined;
      let bold: boolean | undefined;
      let align: 'left' | 'center' | 'right' | undefined;
      if (parsedParagraphs.length > 0 && parsedParagraphs[0].runs.length > 0) {
        const run = parsedParagraphs[0].runs[0];
        fontSize = run.fontSize;
        color = run.color;
        bold = run.bold;
      }
      if (parsedParagraphs.length > 0 && parsedParagraphs[0].alignment) {
        const algn = parsedParagraphs[0].alignment;
        align = (algn === 'left' || algn === 'center' || algn === 'right') ? algn : 'left';
      }

      cells.push({ text, colSpan, rowSpan, fill, fontSize, color, bold, align });
    }

    if (cells.length > 0) {
      rows.push({ cells, height: rowHeight });
    }
  }

  if (rows.length === 0) return null;

  return { type: 'table', x, y, width, height, table: { columns, rows } };
}

/** Extract text from `<a:t>` elements in PowerPoint XML */
function extractXmlTexts(xml: string): string[] {
  const results: string[] = [];
  const tRegex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = tRegex.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1]).trim();
    if (text) results.push(text);
  }
  return results;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
