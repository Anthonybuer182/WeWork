import { SPLIT_MIN_WIDTH, usePanelStore, type PanelRegion } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * Whether a region's split is currently DISPLAYED.
 *
 * The store answers whether a split is *configured* (`splitRatio != null`);
 * this adds the layout gate — a narrow column shows one slot even while a
 * split is configured, because two 200px slots are worse than one 400px one.
 * The configuration and its tabs survive; widening the column brings the
 * second slot back (决策二: 分屏前置条件是宽栏形态).
 *
 * EVERY surface that mirrors the split — the host's slots, the strip's two
 * segments — must gate on this same hook, or the strip would show two
 * segments over a single body slot.
 */
export function useSplitActive(region: PanelRegion): boolean {
  const splitRatio = usePanelStore((s) => s.splitRatio[region]);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  if (splitRatio == null) return false;
  if (region !== 'right') return false; // left never splits
  return rightPanelWidth >= SPLIT_MIN_WIDTH;
}
