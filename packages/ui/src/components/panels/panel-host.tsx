import { PanelRail } from './panel-rail';
import { PanelSlot } from './panel-slot';
import type { PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * Sidebar panel host: Rail (switcher) + Slot (single active panel). All
 * content — host and plugin alike — is contributed through the panel
 * registry. Panels render their own headers; which column is visible at all
 * is the title bar's layout toggles' business, not the host's.
 */
export function PanelHost({ region = 'right' }: { region?: PanelRegion }) {
  return (
    <div className="flex h-full w-full">
      <PanelRail region={region} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PanelSlot region={region} />
      </div>
    </div>
  );
}
