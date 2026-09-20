import { PanelRail } from './panel-rail';
import { PanelChrome } from './panel-chrome';
import { PanelSlot } from './panel-slot';
import type { PanelRegion } from '@/stores/panel-store';

export { PanelRail };

/**
 * Sidebar panel host: Rail (switcher) + Chrome (title bar) + Slot (single active
 * panel). All content — host and plugin alike — is contributed through the panel
 * registry.
 *
 * `chrome={false}` drops the title bar for regions whose views render their own
 * header (the left sidebar's file tree and session list both do), which would
 * otherwise stack two headers.
 */
export function PanelHost({
  region = 'right',
  chrome = true,
}: {
  region?: PanelRegion;
  chrome?: boolean;
}) {
  return (
    <div className="flex h-full w-full">
      <PanelRail region={region} />
      <div className="flex min-w-0 flex-1 flex-col">
        {chrome && <PanelChrome region={region} />}
        <PanelSlot region={region} />
      </div>
    </div>
  );
}
