import { PanelRail } from './panel-rail';
import { PanelChrome } from './panel-chrome';
import { PanelSlot } from './panel-slot';

export { PanelRail };

/**
 * Right sidebar panel host: Rail (switcher) + Chrome (title bar) + Slot
 * (single active panel). All content — host and plugin alike — is
 * contributed through the panel registry.
 */
export function PanelHost() {
  return (
    <div className="flex h-full w-full">
      <PanelRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <PanelChrome />
        <PanelSlot />
      </div>
    </div>
  );
}
