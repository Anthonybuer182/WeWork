import { X, Loader2, CircleAlert } from 'lucide-react';
import { usePanelStore } from '@/stores/panel-store';
import { panelIcon } from './panel-icons';

/**
 * Host-owned panel chrome: every panel (host or plugin) gets the same
 * title bar — title, activity indicator, badge — for a consistent look.
 */
export function PanelChrome() {
  const activePanelId = usePanelStore((s) => s.activePanelId);
  const panels = usePanelStore((s) => s.panels);
  const runtime = usePanelStore((s) => (activePanelId ? s.runtime[activePanelId] : undefined));
  const closePanel = usePanelStore((s) => s.closePanel);

  const panel = panels.find((p) => p.id === activePanelId);
  if (!panel) {
    return (
      <div className="flex h-10 shrink-0 items-center border-b px-3 text-sm text-muted-foreground">
        面板
      </div>
    );
  }

  const Icon = panelIcon(panel.icon);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3" data-testid="panel-chrome" data-panel-title={panel.title}>
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium">{panel.title}</span>
      {runtime?.activity === 'streaming' || runtime?.activity === 'working' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
      ) : null}
      {runtime?.activity === 'error' ? <CircleAlert className="h-3.5 w-3.5 text-destructive" /> : null}
      {runtime?.badge !== undefined && runtime.badge !== '' ? (
        <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">{runtime.badge}</span>
      ) : null}
      <span className="ml-auto" />
      <button
        type="button"
        aria-label="关闭面板"
        onClick={closePanel}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
