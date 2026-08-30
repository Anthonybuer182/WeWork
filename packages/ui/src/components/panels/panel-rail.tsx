import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelStore, type PanelEntry } from '@/stores/panel-store';
import { panelIcon } from './panel-icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';function RailButton({ panel }: { panel: PanelEntry }) {
  const activePanelId = usePanelStore((s) => s.activePanelId);
  const openPanel = usePanelStore((s) => s.openPanel);
  const runtime = usePanelStore((s) => s.runtime[panel.id]);
  const Icon = panelIcon(panel.icon);

  const active = activePanelId === panel.id;
  const badge = runtime?.badge;
  const pending = runtime?.pending;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={panel.title}
          aria-pressed={active}
          data-panel-id={panel.id}
          data-state={active ? 'active' : 'inactive'}
          data-pending={pending ? 'true' : undefined}
          onClick={() => openPanel(panel.id, { focus: true })}
          className={cn(
            'relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            active && 'bg-accent text-accent-foreground',
            pending && !active && 'text-foreground',
          )}
        >
          <Icon className="h-4.5 w-4.5" />
          {badge !== undefined && badge !== null && badge !== '' && (
            <span
              data-panel-badge
              className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground"
            >
              {badge}
            </span>
          )}
          {pending && badge === undefined && (
            <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-primary" />
          )}
          {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{panel.title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Right-edge icon rail: the plugin panel switcher. Host panels and plugin
 * panels live side by side; badges/active dots stay visible even when the
 * panel body is collapsed.
 */
export function PanelRail() {
  const panels = usePanelStore((s) => s.panels);
  const openPanel = usePanelStore((s) => s.openPanel);
  const hasPluginCenter = panels.some((p) => p.id === 'host:plugins');

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2" data-testid="panel-rail">
      {panels.map((panel) => (
        <RailButton key={panel.id} panel={panel} />
      ))}
      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="插件中心"
              disabled={!hasPluginCenter}
              data-rail-plugin-center
              onClick={() => hasPluginCenter && openPanel('host:plugins', { focus: true })}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-md transition-colors',
                hasPluginCenter
                  ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  : 'text-muted-foreground/40',
              )}
            >
              <Plus className="h-4.5 w-4.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">插件中心</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
