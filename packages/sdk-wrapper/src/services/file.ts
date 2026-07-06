export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: string;
}

export interface FileContent {
  path: string;
  content: string;
  language?: string;
  size: number;
  encoding?: 'utf-8' | 'base64';
  mimeType?: string;
}

// --- Office document structured content ---

export type OfficeFileType = 'docx' | 'xlsx' | 'pptx';

export interface DocxContent {
  type: 'docx';
  data: string; // base64-encoded raw DOCX file
}

export interface XlsxCellFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string; // hex ARGB, e.g. "FF0000" or "FFFF0000"
}

export interface XlsxCellFill {
  color?: string; // hex ARGB
}

export interface XlsxCellBorder {
  style?: 'thin' | 'medium' | 'thick' | 'dotted' | 'dashed' | 'double' | 'hair';
  color?: string;
}

export interface XlsxCellBorderSide {
  top?: XlsxCellBorder;
  bottom?: XlsxCellBorder;
  left?: XlsxCellBorder;
  right?: XlsxCellBorder;
}

export interface XlsxCellAlignment {
  horizontal?: 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
  vertical?: 'top' | 'middle' | 'bottom' | 'distributed' | 'justify';
  wrapText?: boolean;
  textRotation?: number;
}

export interface XlsxCell {
  value: string;
  font?: XlsxCellFont;
  fill?: XlsxCellFill;
  border?: XlsxCellBorderSide;
  alignment?: XlsxCellAlignment;
  isHeader?: boolean;
}

export interface XlsxRow {
  height?: number;
  cells: XlsxCell[];
}

export interface XlsxMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface XlsxSheet {
  name: string;
  columns: { width?: number }[];
  merges: XlsxMerge[];
  rows: XlsxRow[];
  freeze?: { xSplit: number; ySplit: number; topLeftCell: string };
  defaultFont?: { name?: string; size?: number };
}

export interface XlsxContent {
  type: 'xlsx';
  sheets: XlsxSheet[];
}

export interface PptxTextRun {
  text: string;
  fontSize?: number; // in points (already converted from OOXML hundredths)
  color?: string; // hex RRGGBB
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
}

export interface PptxParagraph {
  alignment?: 'left' | 'center' | 'right' | 'justify';
  runs: PptxTextRun[];
  level?: number;
  lineSpacing?: number; // multiple of single line (e.g., 1.5)
  spaceBefore?: number; // in points
  spaceAfter?: number; // in points
  bullet?: { type: 'char' | 'autoNum'; char?: string; numType?: string };
}

export interface PptxShapeFill {
  type: 'solid' | 'gradient';
  color?: string; // for solid
  stops?: { color: string; position: number }[]; // for gradient
  gradientAngle?: number; // in degrees, 0 = left-to-right
}

export interface PptxShapeOutline {
  color?: string;
  width?: number; // in EMU
  dashStyle?: 'solid' | 'dash' | 'dot' | 'dashDot' | 'none';
}

export interface PptxTableCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  fill?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface PptxTableRow {
  cells: PptxTableCell[];
  height?: number;
}

export interface PptxTable {
  columns: { width: number }[];
  rows: PptxTableRow[];
}

export interface PptxShape {
  type: 'text' | 'image' | 'group' | 'table';
  x: number;
  y: number;
  width: number;
  height: number;
  // Text shapes
  paragraphs?: PptxParagraph[];
  // Image shapes
  image?: { data: string; mimeType: string };
  // Rotation in degrees
  rotation?: number;
  // Shape fill
  fill?: PptxShapeFill;
  // Shape outline
  outline?: PptxShapeOutline;
  // Shape geometry (preset)
  geometry?: 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'rtTriangle' | 'chevron' | 'pentagon' | 'hexagon' | 'octagon' | 'star5' | 'custom';
  // Text body anchor (vertical alignment)
  textAnchor?: 'top' | 'middle' | 'bottom';
  // For group shapes
  children?: PptxShape[];
  // For table shapes
  table?: PptxTable;
}

export interface PptxSlide {
  index: number;
  background?: { type: 'solid'; color: string } | { type: 'gradient'; stops: { color: string; position: number }[] };
  shapes: PptxShape[];
  notes: string;
}

export interface PptxContent {
  type: 'pptx';
  slideWidth: number; // EMU
  slideHeight: number; // EMU
  slides: PptxSlide[];
}

export type OfficeDocContent = DocxContent | XlsxContent | PptxContent;

export interface OfficeContent {
  path: string;
  size: number;
  doc: OfficeDocContent;
}

export interface FileService {
  list(workspaceId: string, directory?: string): Promise<FileEntry[]>;
  read(workspaceId: string, filePath: string): Promise<FileContent>;
  write(workspaceId: string, filePath: string, content: string): Promise<void>;
  delete(workspaceId: string, filePath: string): Promise<void>;
  readOffice(workspaceId: string, filePath: string): Promise<OfficeContent>;
}
