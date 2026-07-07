import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { Download, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import type { XlsxSheet, XlsxCell, XlsxMerge } from '@pi/sdk-wrapper';

function cellStyle(cell: XlsxCell, defaultFont?: { name?: string; size?: number }): React.CSSProperties {
  const style: React.CSSProperties = {};

  // Font - apply default font first, then override with cell-specific values
  const font = cell.font ?? {};
  const fontName = font.name ?? defaultFont?.name;
  const fontSize = font.size ?? defaultFont?.size;
  if (fontName) style.fontFamily = fontName;
  if (fontSize) style.fontSize = `${fontSize}pt`;
  if (font.bold) style.fontWeight = 'bold';
  if (font.italic) style.fontStyle = 'italic';
  if (font.color) style.color = `#${font.color}`;

  // Fill
  if (cell.fill?.color) {
    style.backgroundColor = `#${cell.fill.color}`;
  }

  // Border
  if (cell.border) {
    const borderStyleMap: Record<string, string> = {
      thin: '1px solid',
      medium: '2px solid',
      thick: '3px solid',
      dotted: '1px dotted',
      dashed: '1px dashed',
      double: '3px double',
      hair: '1px solid',
    };
    const bs = (b: { style?: string; color?: string }) => {
      if (!b?.style || b.style === 'none') return undefined;
      const width = borderStyleMap[b.style] ?? '1px solid';
      const color = b.color ? `#${b.color}` : '#ccc';
      return `${width.split(' ')[0]} ${width.split(' ')[1]} ${color}` as const;
    };
    const borders: React.CSSProperties = {};
    if (cell.border.top) borders.borderTop = bs(cell.border.top) as string;
    if (cell.border.bottom) borders.borderBottom = bs(cell.border.bottom) as string;
    if (cell.border.left) borders.borderLeft = bs(cell.border.left) as string;
    if (cell.border.right) borders.borderRight = bs(cell.border.right) as string;
    Object.assign(style, borders);
  }

  // Alignment
  if (cell.alignment) {
    if (cell.alignment.horizontal) {
      // Map Excel alignment values to valid CSS textAlign values
      const alignMap: Record<string, React.CSSProperties['textAlign']> = {
        left: 'left',
        center: 'center',
        right: 'right',
        justify: 'justify',
        fill: 'left',
        centerContinuous: 'center',
        distributed: 'justify',
      };
      style.textAlign = alignMap[cell.alignment.horizontal] ?? 'left';
    }
    if (cell.alignment.vertical) {
      const vAlignMap: Record<string, React.CSSProperties['verticalAlign']> = {
        top: 'top',
        middle: 'middle',
        bottom: 'bottom',
        distributed: 'baseline',
        justify: 'baseline',
      };
      style.verticalAlign = vAlignMap[cell.alignment.vertical] ?? 'middle';
    }
    if (cell.alignment.wrapText) style.whiteSpace = 'pre-wrap';
    // Note: textRotation is handled in the cell rendering, not here,
    // because it should rotate the text, not the entire cell.
    if (cell.alignment.textRotation === 255) {
      // 255 means vertical stacked text in Excel
      style.writingMode = 'vertical-rl';
      style.textOrientation = 'upright';
    }
  }

  return style;
}

function SheetView({ sheet }: { sheet: XlsxSheet }) {
  const { columns, merges, rows, freeze, defaultFont } = sheet;
  const freezeRows = freeze?.ySplit ?? 0;
  const freezeCols = freeze?.xSplit ?? 0;

  // Build a merge lookup map for efficient checking
  const mergeMap = useMemo(() => {
    const map = new Map<string, { merge: XlsxMerge; isOrigin: boolean }>();
    for (const merge of merges) {
      for (let r = merge.top; r <= merge.bottom; r++) {
        for (let c = merge.left; c <= merge.right; c++) {
          map.set(`${r},${c}`, { merge, isOrigin: r === merge.top && c === merge.left });
        }
      }
    }
    return map;
  }, [merges]);

  // Check if any row has a fill color (to disable zebra striping)
  const hasAnyFill = useMemo(() => {
    return rows.some((row) =>
      row.cells.some((cell) => cell.fill?.color),
    );
  }, [rows]);

  return (
    <table className="border-collapse text-xs table-auto" style={{ minWidth: '100%' }}>
      <colgroup>
        {/* Row number column */}
        <col style={{ width: 40 }} />
        {columns.map((col, i) => (
          <col key={i} style={{ width: col.width ? `${Math.max(col.width * 7.5 + 5, 50)}px` : undefined }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th
            className="border border-border bg-muted/50 sticky top-0 z-30"
            style={{ width: 40 }}
          >
            #
          </th>
          {columns.map((_, i) => (
            <th
              key={i}
              className="border border-border bg-muted/50 sticky top-0 z-20 text-center font-medium text-muted-foreground"
              style={{ width: columns[i]?.width ? `${Math.max(columns[i].width! * 7.5 + 5, 50)}px` : undefined }}
            >
              {columnLetter(i)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(() => {
          // Precompute cumulative row heights for frozen row sticky offsets
          const headerHeight = 28; // approximate header row height
          let cumulativeTop = headerHeight;
          const frozenRowTops: number[] = [];
          for (let i = 0; i < freezeRows && i < rows.length; i++) {
            frozenRowTops[i] = cumulativeTop;
            cumulativeTop += rows[i].height ?? 22; // default 22px if no height
          }

          return rows.map((row, rowIdx) => {
          const excelRowIdx = rowIdx + 1;
          const isFrozenRow = rowIdx < freezeRows;
          return (
            <tr
              key={rowIdx}
              style={{
                height: row.height ? `${row.height}px` : undefined,
                ...(isFrozenRow ? { position: 'sticky', top: `${frozenRowTops[rowIdx]}px`, zIndex: 10 } : {}),
              }}
              className={!hasAnyFill && rowIdx % 2 === 1 ? 'bg-muted/5' : ''}
            >
              {/* Row number */}
              <td
                className={`border border-border bg-muted/20 text-muted-foreground text-center sticky left-0 ${isFrozenRow ? 'z-30' : 'z-10'}`}
                style={{ width: 40 }}
              >
                {excelRowIdx}
              </td>
              {row.cells.map((cell, colIdx) => {
                const excelColIdx = colIdx + 1;
                const mergeInfo = mergeMap.get(`${excelRowIdx},${excelColIdx}`);

                // Skip cells that are part of a merge but not the origin
                if (mergeInfo && !mergeInfo.isOrigin) {
                  return null;
                }

                const style = cellStyle(cell, defaultFont);

                // Apply border to all sides if no specific border set
                if (!cell.border) {
                  style.border = '1px solid #e5e5e5';
                } else {
                  // Fill in missing borders with default
                  const defaultBorder = '1px solid #e5e5e5';
                  if (!cell.border.top && !style.borderTop) style.borderTop = defaultBorder;
                  if (!cell.border.bottom && !style.borderBottom) style.borderBottom = defaultBorder;
                  if (!cell.border.left && !style.borderLeft) style.borderLeft = defaultBorder;
                  if (!cell.border.right && !style.borderRight) style.borderRight = defaultBorder;
                }

                // Frozen column sticky positioning
                const isFrozenCol = colIdx < freezeCols;
                if (isFrozenCol) {
                  // Calculate left offset: row number column (40px) + sum of previous frozen column widths
                  let leftOffset = 40;
                  for (let fc = 0; fc < colIdx; fc++) {
                    leftOffset += columns[fc]?.width ? Math.max(columns[fc].width! * 7.5 + 5, 50) : 80;
                  }
                  style.position = 'sticky';
                  style.left = `${leftOffset}px`;
                  style.zIndex = isFrozenRow ? 25 : 15;
                }

                const colSpan = mergeInfo ? mergeInfo.merge.right - mergeInfo.merge.left + 1 : 1;
                const rowSpan = mergeInfo ? mergeInfo.merge.bottom - mergeInfo.merge.top + 1 : 1;

                const hasWrap = cell.alignment?.wrapText;
                return (
                  <td
                    key={colIdx}
                    style={style}
                    colSpan={colSpan > 1 ? colSpan : undefined}
                    rowSpan={rowSpan > 1 ? rowSpan : undefined}
                    className={hasWrap ? 'px-2 py-1 whitespace-pre-wrap break-words' : 'px-2 py-1 break-words'}
                    title={cell.value}
                  >
                    {cell.alignment?.textRotation && cell.alignment.textRotation !== 255 ? (
                      <span style={{ display: 'inline-block', transform: `rotate(${cell.alignment.textRotation}deg)` }}>
                        {cell.value || '\u00A0'}
                      </span>
                    ) : (
                      cell.value || '\u00A0'
                    )}
                  </td>
                );
              })}
            </tr>
          );
        });
        })()}
      </tbody>
    </table>
  );
}

function columnLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function XlsxPreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const [activeSheetName, setActiveSheetName] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ['office', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.readOffice(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath && activePreviewFilePath.endsWith('.xlsx'),
  });

  if (!activePreviewFilePath) return null;
  if (isLoading) return <LoadingSpinner message="Loading spreadsheet..." />;

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'Spreadsheet.xlsx';

  if (error || !data || data.doc.type !== 'xlsx') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <div className="flex flex-col items-center gap-2">
          <Download className="h-8 w-8" />
          <span>{error ? 'Failed to load spreadsheet' : 'Unsupported spreadsheet'}</span>
        </div>
      </div>
    );
  }

  const sheets: XlsxSheet[] = data.doc.sheets;
  const activeSheet: XlsxSheet =
    sheets.find((s) => s.name === activeSheetName) ?? sheets[0];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-xs text-muted-foreground truncate flex-1 mr-2">
          {fileName}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            className="h-7 w-7 p-0"
            title="Zoom out"
          >
            <ZoomOut className="h-3 w-3" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            className="h-7 w-7 p-0"
            title="Zoom in"
          >
            <ZoomIn className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openWithSystemApp(activePreviewFilePath!, activeWorkspaceId!)}
            className="h-7 text-xs gap-1.5"
            title="Open with system app"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center border-b bg-muted/10 px-2 shrink-0 overflow-x-auto">
          {sheets.map((sheet) => (
            <button
              key={sheet.name}
              className={`shrink-0 px-3 py-1.5 text-xs border-b-2 transition-colors ${
                activeSheet.name === sheet.name
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setActiveSheetName(sheet.name)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto bg-white" data-sheet-name={activeSheet.name} style={{ zoom }}>
        {activeSheet && activeSheet.rows.length > 0 ? (
          <SheetView sheet={activeSheet} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Empty sheet
          </div>
        )}
      </div>
    </div>
  );
}
