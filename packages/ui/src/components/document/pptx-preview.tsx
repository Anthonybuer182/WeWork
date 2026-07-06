import { useRef, useCallback, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { Presentation, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import type { PptxSlide, PptxShape, PptxParagraph, PptxTextRun, PptxTableCell, PptxTable } from '@pi/sdk-wrapper';

function shapeStyle(shape: PptxShape, slideWidth: number, slideHeight: number): React.CSSProperties {
  return {
    position: 'absolute',
    left: `${(shape.x / slideWidth) * 100}%`,
    top: `${(shape.y / slideHeight) * 100}%`,
    width: `${(shape.width / slideWidth) * 100}%`,
    height: `${(shape.height / slideHeight) * 100}%`,
  };
}

/** Apply shape geometry (border radius, clip path) based on preset */
function geometryStyle(geometry?: PptxShape['geometry']): React.CSSProperties {
  if (!geometry) return {};
  switch (geometry) {
    case 'roundRect':
      return { borderRadius: '10%' };
    case 'ellipse':
      return { borderRadius: '50%' };
    case 'triangle':
      return { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' };
    case 'rtTriangle':
      return { clipPath: 'polygon(0% 0%, 0% 100%, 100% 100%)' };
    case 'diamond':
      return { clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' };
    case 'chevron':
      return { clipPath: 'polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%, 20% 50%)' };
    case 'pentagon':
      return { clipPath: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)' };
    case 'hexagon':
      return { clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' };
    case 'octagon':
      return { clipPath: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)' };
    case 'star5':
      return { clipPath: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' };
    default:
      return {};
  }
}

/** Convert shape fill to CSS background properties */
function fillStyle(fill?: PptxShape['fill']): React.CSSProperties {
  if (!fill) return {};
  if (fill.type === 'solid' && fill.color) {
    return { backgroundColor: `#${fill.color}` };
  }
  if (fill.type === 'gradient' && fill.stops && fill.stops.length > 0) {
    const gradient = fill.stops
      .map((stop) => `#${stop.color} ${Math.round(stop.position * 100)}%`)
      .join(', ');
    // OOXML angle: 0 = left-to-right, 90 = top-to-bottom
    // CSS angle: 0deg = bottom-to-top, 90deg = left-to-right
    // Conversion: CSS = OOXML + 90
    const cssAngle = fill.gradientAngle != null ? (fill.gradientAngle + 90) % 360 : 90;
    return { background: `linear-gradient(${cssAngle}deg, ${gradient})` };
  }
  return {};
}

/** Convert shape outline to CSS border properties */
function outlineStyle(outline?: PptxShape['outline']): React.CSSProperties {
  if (!outline) return {};
  const widthPx = outline.width ? Math.max(1, outline.width / 9525) : 1; // EMU to px
  const color = outline.color ? `#${outline.color}` : '#000000';
  const dash = outline.dashStyle === 'dash' ? 'dashed'
    : outline.dashStyle === 'dot' ? 'dotted'
    : outline.dashStyle === 'dashDot' ? 'dashed' // CSS doesn't support dashdot, use dashed
    : 'solid';
  return { border: `${widthPx}px ${dash} ${color}` };
}

function SlideBackground({ slide }: { slide: PptxSlide }) {
  if (!slide.background) return null;

  if (slide.background.type === 'solid') {
    return (
      <div
        className="absolute inset-0"
        style={{ backgroundColor: `#${slide.background.color}` }}
      />
    );
  }

  if (slide.background.type === 'gradient' && slide.background.stops.length > 0) {
    const gradient = slide.background.stops
      .map((stop) => `#${stop.color} ${Math.round(stop.position * 100)}%`)
      .join(', ');
    return <div className="absolute inset-0" style={{ background: `linear-gradient(90deg, ${gradient})` }} />;
  }

  return null;
}

function TextShape({ shape, slideWidth, slideHeight }: { shape: PptxShape; slideWidth: number; slideHeight: number }) {
  const style: React.CSSProperties = {
    ...shapeStyle(shape, slideWidth, slideHeight),
    ...fillStyle(shape.fill),
    ...outlineStyle(shape.outline),
    ...geometryStyle(shape.geometry),
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  // Apply text anchor (vertical alignment)
  if (shape.textAnchor === 'middle') {
    style.justifyContent = 'center';
  } else if (shape.textAnchor === 'bottom') {
    style.justifyContent = 'flex-end';
  } else {
    style.justifyContent = 'flex-start';
  }

  // Apply rotation if present
  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`;
    style.transformOrigin = 'center';
  }

  return (
    <div style={style}>
      {shape.paragraphs?.map((para: PptxParagraph, i: number) => (
        <ParagraphView key={i} para={para} />
      ))}
    </div>
  );
}

function ParagraphView({ para }: { para: PptxParagraph }) {
  const style: React.CSSProperties = {
    margin: 0,
    padding: '2px 4px',
    textAlign: para.alignment ?? 'left',
  };

  // Add indentation for list levels
  if (para.level && para.level > 0) {
    style.marginLeft = `${para.level * 20}px`;
  }

  // Line spacing
  if (para.lineSpacing) {
    style.lineHeight = `${para.lineSpacing}`;
  }

  // Space before/after
  if (para.spaceBefore) {
    style.marginTop = `${para.spaceBefore}pt`;
  }
  if (para.spaceAfter) {
    style.marginBottom = `${para.spaceAfter}pt`;
  }

  // Bullet prefix
  let bulletPrefix = '';
  if (para.bullet) {
    if (para.bullet.type === 'char' && para.bullet.char) {
      bulletPrefix = para.bullet.char + ' ';
    } else if (para.bullet.type === 'autoNum') {
      bulletPrefix = '• '; // Simplified: just show a bullet for auto-numbered lists
    }
  }

  return (
    <p style={style}>
      {bulletPrefix && <span>{bulletPrefix}</span>}
      {para.runs.map((run: PptxTextRun, i: number) => (
        <RunView key={i} run={run} />
      ))}
    </p>
  );
}

function RunView({ run }: { run: PptxTextRun }) {
  const style: React.CSSProperties = {};

  if (run.fontSize) style.fontSize = `${run.fontSize}pt`;
  if (run.color) style.color = `#${run.color}`;
  if (run.bold) style.fontWeight = 'bold';
  if (run.italic) style.fontStyle = 'italic';
  if (run.underline) style.textDecoration = 'underline';
  if (run.strikethrough) {
    style.textDecoration = style.textDecoration ? `${style.textDecoration} line-through` : 'line-through';
  }
  if (run.fontFamily) style.fontFamily = run.fontFamily;

  return <span style={style}>{run.text}</span>;
}

function ImageShape({ shape, slideWidth, slideHeight }: { shape: PptxShape; slideWidth: number; slideHeight: number }) {
  if (!shape.image) return null;

  const style: React.CSSProperties = {
    ...shapeStyle(shape, slideWidth, slideHeight),
    objectFit: 'fill',
  };

  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`;
    style.transformOrigin = 'center';
  }

  return (
    <img
      src={`data:${shape.image.mimeType};base64,${shape.image.data}`}
      alt=""
      style={style}
      draggable={false}
    />
  );
}

function GroupShape({ shape, slideWidth, slideHeight }: { shape: PptxShape; slideWidth: number; slideHeight: number }) {
  const style: React.CSSProperties = {
    ...shapeStyle(shape, slideWidth, slideHeight),
  };

  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`;
    style.transformOrigin = 'center';
  }

  return (
    <div style={style}>
      {shape.children?.map((child, i) => (
        <ShapeView key={i} shape={child} slideWidth={slideWidth} slideHeight={slideHeight} />
      ))}
    </div>
  );
}

function TableShape({ shape, slideWidth, slideHeight }: { shape: PptxShape; slideWidth: number; slideHeight: number }) {
  if (!shape.table) return null;
  const table = shape.table;
  const totalColWidth = table.columns.reduce((sum, col) => sum + col.width, 0);

  const containerStyle: React.CSSProperties = {
    ...shapeStyle(shape, slideWidth, slideHeight),
    overflow: 'hidden',
  };

  return (
    <div style={containerStyle}>
      <table
        className="w-full h-full border-collapse"
        style={{ tableLayout: 'fixed' }}
      >
        <colgroup>
          {table.columns.map((col, i) => (
            <col key={i} style={{ width: `${(col.width / totalColWidth) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} style={{ height: row.height ? `${row.height / 9525}px` : undefined }}>
              {row.cells.map((cell: PptxTableCell, ci) => {
                const cellStyle: React.CSSProperties = {
                  border: '1px solid #ccc',
                  padding: '4px 6px',
                  verticalAlign: 'middle',
                  textAlign: cell.align ?? 'left',
                  fontSize: cell.fontSize ? `${cell.fontSize}pt` : undefined,
                  color: cell.color ? `#${cell.color}` : undefined,
                  fontWeight: cell.bold ? 'bold' : undefined,
                };
                if (cell.fill) {
                  cellStyle.backgroundColor = `#${cell.fill}`;
                }
                return (
                  <td
                    key={ci}
                    style={cellStyle}
                    colSpan={cell.colSpan && cell.colSpan > 1 ? cell.colSpan : undefined}
                    rowSpan={cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  >
                    {cell.text || '\u00A0'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShapeView({ shape, slideWidth, slideHeight }: { shape: PptxShape; slideWidth: number; slideHeight: number }) {
  if (shape.type === 'image') return <ImageShape shape={shape} slideWidth={slideWidth} slideHeight={slideHeight} />;
  if (shape.type === 'group') return <GroupShape shape={shape} slideWidth={slideWidth} slideHeight={slideHeight} />;
  if (shape.type === 'table') return <TableShape shape={shape} slideWidth={slideWidth} slideHeight={slideHeight} />;
  return <TextShape shape={shape} slideWidth={slideWidth} slideHeight={slideHeight} />;
}

function SlideView({
  slide,
  slideWidth,
  slideHeight,
}: {
  slide: PptxSlide;
  slideWidth: number;
  slideHeight: number;
}) {
  const aspectRatio = slideWidth / slideHeight;

  return (
    <div
      className="relative w-full bg-white shadow-xl rounded-sm overflow-hidden mx-auto"
      style={{ aspectRatio: `${aspectRatio}`, maxWidth: '900px' }}
    >
      <SlideBackground slide={slide} />
      {slide.shapes.map((shape, i) => (
        <ShapeView key={i} shape={shape} slideWidth={slideWidth} slideHeight={slideHeight} />
      ))}
    </div>
  );
}

function MiniSlideView({
  slide,
  slideWidth,
  slideHeight,
}: {
  slide: PptxSlide;
  slideWidth: number;
  slideHeight: number;
}) {
  const aspectRatio = slideWidth / slideHeight;

  return (
    <div
      className="relative w-full bg-white rounded-sm overflow-hidden border"
      style={{ aspectRatio: `${aspectRatio}` }}
    >
      <SlideBackground slide={slide} />
      {/* Render simplified shapes for thumbnail */}
      {slide.shapes.map((shape, i) => {
        const baseStyle = shapeStyle(shape, slideWidth, slideHeight);

        // Image shapes
        if (shape.type === 'image' && shape.image) {
          return (
            <img
              key={i}
              src={`data:${shape.image.mimeType};base64,${shape.image.data}`}
              alt=""
              style={{ ...baseStyle, objectFit: 'fill' }}
            />
          );
        }

        // Group shapes: render children recursively
        if (shape.type === 'group' && shape.children) {
          return (
            <div key={i} style={baseStyle}>
              {shape.children.map((child, ci) => {
                const childStyle = shapeStyle(child, slideWidth, slideHeight);
                if (child.type === 'image' && child.image) {
                  return (
                    <img
                      key={ci}
                      src={`data:${child.image.mimeType};base64,${child.image.data}`}
                      alt=""
                      style={{ ...childStyle, objectFit: 'fill' }}
                    />
                  );
                }
                // Apply fill to child shapes in thumbnail
                const fillBg = fillStyle(child.fill);
                const text = child.paragraphs
                  ?.map((p) => p.runs.map((r) => r.text).join(''))
                  .join(' ');
                return (
                  <div
                    key={ci}
                    className="absolute overflow-hidden text-[6px] leading-tight"
                    style={{
                      ...childStyle,
                      ...fillBg,
                      color: child.paragraphs?.[0]?.runs[0]?.color
                        ? `#${child.paragraphs[0].runs[0].color}`
                        : undefined,
                    }}
                  >
                    {text}
                  </div>
                );
              })}
            </div>
          );
        }

        // Table shapes: render as colored blocks
        if (shape.type === 'table' && shape.table) {
          return (
            <div
              key={i}
              style={{
                ...baseStyle,
                backgroundColor: '#f0f0f0',
                border: '1px solid #ccc',
              }}
            />
          );
        }

        // Text shapes with fill
        const fillBg = fillStyle(shape.fill);
        const text = shape.paragraphs
          ?.map((p) => p.runs.map((r) => r.text).join(''))
          .join(' ');
        if (!text && !fillBg.backgroundColor && !fillBg.background) return null;
        return (
          <div
            key={i}
            className="absolute overflow-hidden text-[6px] leading-tight"
            style={{
              ...baseStyle,
              ...fillBg,
              ...geometryStyle(shape.geometry),
              color: shape.paragraphs?.[0]?.runs[0]?.color
                ? `#${shape.paragraphs[0].runs[0].color}`
                : undefined,
            }}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}

export function PptxPreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const scrollRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [activeIdx, setActiveIdx] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ['office', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.readOffice(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath && activePreviewFilePath.endsWith('.pptx'),
  });

  const scrollToSlide = useCallback((index: number) => {
    const el = slideRefs.current.get(index);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // IntersectionObserver for scroll-sync
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !data || data.doc.type !== 'pptx') return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: { idx: number; ratio: number } = { idx: -1, ratio: 0 };
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > best.ratio) {
            const idx = Number((entry.target as HTMLElement).dataset.slideIdx);
            if (!isNaN(idx)) {
              best = { idx, ratio: entry.intersectionRatio };
            }
          }
        }
        if (best.idx >= 0) {
          setActiveIdx(best.idx);
        }
      },
      {
        root: container,
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );

    slideRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [data]);

  if (!activePreviewFilePath) return null;
  if (isLoading) return <LoadingSpinner message="Loading presentation..." />;

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'Presentation.pptx';

  if (error || !data || data.doc.type !== 'pptx') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <div className="flex flex-col items-center gap-2">
          <Presentation className="h-8 w-8" />
          <span>{error ? 'Failed to load presentation' : 'Unsupported presentation'}</span>
        </div>
      </div>
    );
  }

  const { slideWidth, slideHeight, slides } = data.doc;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-xs text-muted-foreground truncate flex-1 mr-2">
          {fileName} ({slides.length} slides)
        </span>
        <span className="text-xs text-muted-foreground mr-2 tabular-nums">
          {activeIdx + 1} / {slides.length}
        </span>
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

      {/* Main content: thumbnails + slide list */}
      <div className="flex flex-1 min-h-0">
        {/* Slide thumbnails sidebar */}
        <div className="w-40 border-r bg-muted/10 overflow-y-auto shrink-0 p-2">
          {slides.map((slide: PptxSlide, i: number) => (
            <button
              key={slide.index}
              onClick={() => scrollToSlide(i)}
              className={`w-full text-left p-1.5 mb-2 rounded border-2 transition-all ${
                i === activeIdx
                  ? 'border-primary bg-primary/10'
                  : 'border-transparent hover:border-border hover:bg-muted/30'
              }`}
            >
              <MiniSlideView slide={slide} slideWidth={slideWidth} slideHeight={slideHeight} />
              <div className="text-[10px] text-muted-foreground text-center mt-1">
                {i + 1}
              </div>
            </button>
          ))}
        </div>

        {/* Slides stacked vertically */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-neutral-200 dark:bg-neutral-800 p-4 space-y-6">
          {slides.map((slide: PptxSlide, i: number) => (
            <div
              key={slide.index}
              data-slide-idx={i}
              ref={(el) => {
                if (el) slideRefs.current.set(i, el);
                else slideRefs.current.delete(i);
              }}
              className="flex flex-col items-center"
            >
              <div className="text-xs text-muted-foreground mb-2">
                Slide {i + 1} of {slides.length}
              </div>
              <SlideView slide={slide} slideWidth={slideWidth} slideHeight={slideHeight} />
              {slide.notes && (
                <div className="mt-2 max-w-[900px] w-full text-xs text-muted-foreground bg-muted/30 rounded p-2">
                  <span className="font-medium">Notes:</span> {slide.notes}
                </div>
              )}
            </div>
          ))}
          <div className="h-8" />
        </div>
      </div>
    </div>
  );
}
