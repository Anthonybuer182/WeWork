import { useCallback, useRef } from 'react';
import { PanelRail } from './panel-rail';
import { PanelSlot } from './panel-slot';
import { PanelTabMenu } from './panel-tabs';
import { useSplitActive } from './use-split';
import { usePanelStore, type PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * Sidebar panel host: Rail (switcher) + Slot (the focused panel, with the
 * rest of the open tabs mounted hidden). All content — host and plugin alike
 * — is contributed through the panel registry. Panels render their own
 * headers; which column is visible at all is the title bar's layout toggles'
 * business, not the host's.
 *
 * The right column can SPLIT into two slots side by side (决策二: internal,
 * left-right, two slots max — never a free grid). The split engages only in
 * the wide form: below `SPLIT_MIN_WIDTH` the second slot hides but its tabs
 * and its store state stay, so narrowing the column is not destructive.
 *
 * The tab STRIP lives in the layout's header band (passed by the app as
 * rightHeader); this host renders only the tab context MENU row above the
 * slots — a floating menu anchored to the strip would be covered by the
 * native view in the slot, so the menu is a flow row here instead.
 * Left keeps pure rail-switching; the menu is region-generic if that ever
 * changes.
 */
export function PanelHost({ region = 'right' }: { region?: PanelRegion }) {
  const splitRatio = usePanelStore((s) => s.splitRatio[region]);
  const setSplit = usePanelStore((s) => s.setSplit);
  const splitActive = useSplitActive(region);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Pointer-drag the divider: the fraction is measured against the SLOTS
  // container (the strip above and the rail beside are not part of the
  // split). Clamped to [0.25, 0.75] — a slot narrower than a quarter of the
  // column is not usable, and the clamp doubles as the "no accidental
  // collapse" guard.
  const onSplitterMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplit(region, Math.min(0.75, Math.max(0.25, ratio)));
    },
    [region, setSplit],
  );

  const startSplitDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const move = (ev: PointerEvent) => onSplitterMove(ev);
      const up = () => {
        draggingRef.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onSplitterMove],
  );

  return (
    <div className="flex h-full w-full">
      <PanelRail region={region} />
      <div className="flex min-w-0 flex-1 flex-col">
        {region === 'right' && <PanelTabMenu region={region} />}
        <div ref={containerRef} className="flex min-h-0 flex-1" data-panel-slots={region}>
          <div
            className="flex min-w-0 flex-col"
            style={splitActive ? { flex: `0 0 ${((splitRatio ?? 0.5) * 100).toFixed(2)}%` } : { flex: '1 1 auto' }}
          >
            <PanelSlot region={region} slot="A" />
          </div>
          {splitActive && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调整分屏比例"
                data-panel-splitter={region}
                onPointerDown={startSplitDrag}
                className="group flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border/60 transition-colors hover:bg-primary/50"
              >
                <span className="pointer-events-none h-8 w-px bg-muted-foreground/40 group-hover:bg-primary-foreground/60" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <PanelSlot region={region} slot="B" />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
