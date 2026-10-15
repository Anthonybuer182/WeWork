import { PanelRail } from './panel-rail';
import { PanelSlot } from './panel-slot';
import { PanelTabs } from './panel-tabs';
import type { PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * Sidebar panel host: Rail (switcher) + Tabs (open panels) + Slot (the focused
 * panel, with the rest of the open tabs mounted hidden). All content — host
 * and plugin alike — is contributed through the panel registry. Panels render
 * their own headers; which column is visible at all is the title bar's layout
 * toggles' business, not the host's.
 *
 * The tab strip ships on the right column only: that is where panels
 * accumulate (plugin panels, file previews). The left column stays a
 * rail-switched single view; the strip is region-generic, so turning it on
 * there is a one-word change if that ever changes.
 */
export function PanelHost({ region = 'right' }: { region?: PanelRegion }) {
  return (
    <div className="flex h-full w-full">
      <PanelRail region={region} />
      <div className="flex min-w-0 flex-1 flex-col">
        {region === 'right' && <PanelTabs region={region} />}
        <PanelSlot region={region} />
      </div>
    </div>
  );
}
