import { useRef, useCallback, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { Presentation, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import type { PptxSlide, PptxShape, PptxParagraph, PptxTextRun, PptxTableCell, PptxTable } from '@pi/sdk-wrapper';

/** EMU to pixel conversion (1 EMU = 1/9525 px at 96 DPI) */
const EMU_PER_PX = 9525;

function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}

function shapeStyle(shape: PptxShape): React.CSSProperties {
  return {
    position: 'absolute',
    left: `${emuToPx(shape.x)}px`,
    top: `${emuToPx(shape.y)}px`,
    width: `${emuToPx(shape.width)}px`,
    height: `${emuToPx(shape.height)}px`,
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
  if (outline.dashStyle === 'none') return {};
  const widthPx = outline.width ? Math.max(0, outline.width / 9525) : 0; // EMU to px
  if (widthPx <= 0) return {};
  const color = outline.color ? `#${outline.color}` : '#000000';
  const dash = outline.dashStyle === 'dash' ? 'dashed'
    : outline.dashStyle === 'dot' ? 'dotted'
    : outline.dashStyle === 'dashDot' ? 'dashed' // CSS doesn't support dashdot, use dashed
    : 'solid';
  return { border: `${Math.max(0.5, widthPx)}px ${dash} ${color}` };
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
    const cssAngle = slide.background.gradientAngle != null ? (slide.background.gradientAngle + 90) % 360 : 90;
    return <div className="absolute inset-0" style={{ background: `linear-gradient(${cssAngle}deg, ${gradient})` }} />;
  }

  return null;
}

function TextShape({ shape }: { shape: PptxShape }) {
  const baseStyle = shapeStyle(shape);
  // Use text body margins (EMU → px) when available, otherwise PPTX defaults:
  // left/right: 91440 EMU = 0.1in ≈ 9.6px, top/bottom: 45720 EMU = 0.05in ≈ 4.8px
  const defaultPad = { left: 91440, top: 45720, right: 91440, bottom: 45720 };
  const margin = shape.textMargin ?? defaultPad;
  const padT = emuToPx(margin.top ?? defaultPad.top);
  const padR = emuToPx(margin.right ?? defaultPad.right);
  const padB = emuToPx(margin.bottom ?? defaultPad.bottom);
  const padL = emuToPx(margin.left ?? defaultPad.left);

  const style: React.CSSProperties = {
    ...baseStyle,
    padding: `${padT}px ${padR}px ${padB}px ${padL}px`,
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
    padding: 0,
    textAlign: para.alignment ?? 'left',
    whiteSpace: 'pre-wrap',
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

function ImageShape({ shape }: { shape: PptxShape }) {
  if (!shape.image) return null;

  const style: React.CSSProperties = {
    ...shapeStyle(shape),
    objectFit: 'contain',
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

function GroupShape({ shape }: { shape: PptxShape }) {
  const style: React.CSSProperties = {
    ...shapeStyle(shape),
  };

  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`;
    style.transformOrigin = 'center';
  }

  return (
    <div style={style}>
      {shape.children?.map((child, i) => (
        <ShapeView key={i} shape={child} />
      ))}
    </div>
  );
}

function TableShape({ shape }: { shape: PptxShape }) {
  if (!shape.table) return null;
  const table = shape.table;
  const totalColWidth = table.columns.reduce((sum, col) => sum + col.width, 0);

  const containerStyle: React.CSSProperties = {
    ...shapeStyle(shape),
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
                  fontStyle: cell.italic ? 'italic' : undefined,
                  fontFamily: cell.fontFamily ?? undefined,
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

function ShapeView({ shape }: { shape: PptxShape }) {
  if (shape.type === 'image') return <ImageShape shape={shape} />;
  if (shape.type === 'group') return <GroupShape shape={shape} />;
  if (shape.type === 'table') return <TableShape shape={shape} />;
  return <TextShape shape={shape} />;
}

function SlideView({
  slide,
  slideWidth,
  slideHeight,
  scale,
}: {
  slide: PptxSlide;
  slideWidth: number;
  slideHeight: number;
  scale: number;
}) {
  const nativeWidth = emuToPx(slideWidth);
  const nativeHeight = emuToPx(slideHeight);
  // Add a 2px buffer to prevent sub-pixel clipping from transform:scale()
  const wrapperWidth = Math.ceil(nativeWidth * scale) + 2;
  const wrapperHeight = Math.ceil(nativeHeight * scale) + 2;

  return (
    <div
      style={{
        width: `${wrapperWidth}px`,
        height: `${wrapperHeight}px`,
        overflow: 'visible',
        paddingBottom: '0px',
      }}
      className="mx-auto"
    >
      <div
        className="relative bg-white shadow-xl rounded-sm overflow-hidden"
        style={{
          width: `${nativeWidth}px`,
          height: `${nativeHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <SlideBackground slide={slide} />
        {slide.shapes.map((shape, i) => (
          <ShapeView key={i} shape={shape} />
        ))}
      </div>
    </div>
  );
}

/**
 * Simplified text shape renderer for thumbnails.
 * Renders actual text content (not just colored blocks) so thumbnails look like
 * real slide previews. Text is rendered at native size and scaled down by CSS
 * transform, keeping the layout proportional.
 */
function MiniTextShape({ shape }: { shape: PptxShape }) {
  const baseStyle = shapeStyle(shape);
  const minH = baseStyle.height;
  const defaultPad = { left: 91440, top: 45720, right: 91440, bottom: 45720 };
  const margin = shape.textMargin ?? defaultPad;
  const padT = emuToPx(margin.top ?? defaultPad.top);
  const padR = emuToPx(margin.right ?? defaultPad.right);
  const padB = emuToPx(margin.bottom ?? defaultPad.bottom);
  const padL = emuToPx(margin.left ?? defaultPad.left);

  const style: React.CSSProperties = {
    ...baseStyle,
    minHeight: minH,
    height: 'auto',
    ...fillStyle(shape.fill),
    ...outlineStyle(shape.outline),
    ...geometryStyle(shape.geometry),
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    padding: `${padT}px ${padR}px ${padB}px ${padL}px`,
  };

  if (shape.textAnchor === 'middle') {
    style.justifyContent = 'center';
  } else if (shape.textAnchor === 'bottom') {
    style.justifyContent = 'flex-end';
  }

  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`;
    style.transformOrigin = 'center';
  }

  return (
    <div style={style}>
      {shape.paragraphs?.slice(0, 3).map((para, pi) => {
        const pStyle: React.CSSProperties = {
          margin: 0,
          padding: 0,
          textAlign: para.alignment ?? 'left',
          lineHeight: 1.2,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        };
        if (para.level && para.level > 0) {
          pStyle.marginLeft = `${para.level * 16}px`;
        }

        let bulletPrefix = '';
        if (para.bullet) {
          if (para.bullet.type === 'char' && para.bullet.char) {
            bulletPrefix = para.bullet.char + ' ';
          } else if (para.bullet.type === 'autoNum') {
            bulletPrefix = '\u2022 ';
          }
        }

        return (
          <p key={pi} style={pStyle}>
            {bulletPrefix && <span>{bulletPrefix}</span>}
            {para.runs.slice(0, 2).map((run, ri) => {
              const rStyle: React.CSSProperties = {};
              if (run.fontSize) rStyle.fontSize = `${run.fontSize}pt`;
              if (run.color) rStyle.color = `#${run.color}`;
              if (run.bold) rStyle.fontWeight = 'bold';
              if (run.italic) rStyle.fontStyle = 'italic';
              return (
                <span key={ri} style={rStyle}>
                  {run.text}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

/** Recursively render shapes for the mini/thumbnail view, showing real text content. */
function MiniShapeList({ shapes }: { shapes: PptxShape[] }) {
  return (
    <>
      {shapes.map((shape, i) => {
        // Image shapes
        if (shape.type === 'image' && shape.image) {
          return (
            <img
              key={i}
              src={`data:${shape.image.mimeType};base64,${shape.image.data}`}
              alt=""
              style={{ ...shapeStyle(shape), objectFit: 'contain' }}
            />
          );
        }

        // Group shapes: recurse into children
        if (shape.type === 'group' && shape.children) {
          return (
            <div key={i} style={shapeStyle(shape)}>
              <MiniShapeList shapes={shape.children} />
            </div>
          );
        }

        // Table shapes: simplified table with text
        if (shape.type === 'table' && shape.table) {
          return (
            <div
              key={i}
              style={{
                ...shapeStyle(shape),
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              {shape.table.rows.slice(0, 4).map((row, ri) => (
                <div
                  key={ri}
                  style={{
                    display: 'flex',
                    flex: 1,
                    height: row.height ? `${row.height / 9525}px` : undefined,
                  }}
                >
                  {row.cells.slice(0, 4).map((cell, ci) => (
                    <div
                      key={ci}
                      style={{
                        flex: 1,
                        border: '0.5px solid #ccc',
                        padding: '1px 2px',
                        fontSize: '6pt',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        backgroundColor: cell.fill ? `#${cell.fill}` : undefined,
                      }}
                    >
                      {cell.text || '\u00A0'}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        }

        // Text shapes (default): render with actual text content
        return <MiniTextShape key={i} shape={shape} />;
      })}
    </>
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
  const nativeWidth = emuToPx(slideWidth);
  const nativeHeight = emuToPx(slideHeight);
  const thumbScale = Math.min(140 / nativeWidth, 1);
  // Add a 2px buffer to prevent sub-pixel clipping from transform:scale()
  const wrapperWidth = Math.ceil(nativeWidth * thumbScale) + 2;
  const wrapperHeight = Math.ceil(nativeHeight * thumbScale) + 2;

  return (
    <div
      style={{
        width: `${wrapperWidth}px`,
        height: `${wrapperHeight}px`,
        overflow: 'visible',
      }}
      className="mx-auto"
    >
      <div
        className="relative bg-white rounded-sm overflow-hidden border"
        style={{
          width: `${nativeWidth}px`,
          height: `${nativeHeight}px`,
          transform: `scale(${thumbScale})`,
          transformOrigin: 'top left',
        }}
      >
        <SlideBackground slide={slide} />
        {/* Render simplified shapes for thumbnail */}
        <MiniShapeList shapes={slide.shapes} />
      </div>
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
  const [zoom, setZoom] = useState(1);
  const [autoScale, setAutoScale] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ['office', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.readOffice(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath && activePreviewFilePath.endsWith('.pptx'),
  });

  // ResizeObserver: auto-scale slides to fit container width
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !data || data.doc.type !== 'pptx') return;

    const nativeSlideWidth = emuToPx(data.doc.slideWidth);

    const updateScale = () => {
      const containerWidth = container.clientWidth - 32; // p-4 = 16px * 2
      if (nativeSlideWidth > 0) {
        setAutoScale(Math.min(containerWidth / nativeSlideWidth, 1));
      }
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(container);
    return () => observer.disconnect();
  }, [data]);

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
              <SlideView slide={slide} slideWidth={slideWidth} slideHeight={slideHeight} scale={autoScale * zoom} />
              {slide.notes && (
                <div className="mt-2 w-full text-xs text-muted-foreground bg-muted/30 rounded p-2">
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
