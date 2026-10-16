import { PanelRail } from './panel-rail';
import { PanelSlot } from './panel-slot';
import { PanelTabMenu } from './panel-tabs';
import type { PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * Sidebar panel host: Rail (switcher) + Slot (the focused panel, with the
 * rest of the open tabs mounted hidden). All content — host and plugin alike
 * — is contributed through the panel registry. Panels render their own
 * headers; which column is visible at all is the title bar's layout toggles'
 * business, not the host's.
 *
 * The tab STRIP lives in the layout's header band (passed by the app as
 * rightHeader); this host renders only the tab context MENU row above the
 * slot — a floating menu anchored to the strip would be covered by the
 * native view in the slot, so the menu is a flow row here instead.
 * Left keeps pure rail-switching; the menu is region-generic if that ever
 * changes.
 */
export function PanelHost({ region = 'right' }: { region?: PanelRegion }) {
  return (
    <div className="flex h-full w-full">
      <PanelRail region={region} />
      <div className="flex min-w-0 flex-1 flex-col">
        {region === 'right' && <PanelTabMenu region={region} />}
        <PanelSlot region={region} />
      </div>
    </div>
  );
}
