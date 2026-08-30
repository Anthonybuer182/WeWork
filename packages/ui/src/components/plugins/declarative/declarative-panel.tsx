import { useEffect, useState } from 'react';
import type { UiNode } from '@pi/types';
import { getPluginBridge } from '@/stores/plugin-store';
import { usePanelStore } from '@/stores/panel-store';
import { DeclarativeRenderer, type UiEventContext } from './declarative-renderer';
import { ensureRelayInstalled, registerTarget, unregisterTarget, sendPluginEvent } from '../plugin-panel';

export interface DeclarativePanelHostProps {
  pluginId: string;
  panelId: string;
}

/**
 * Tier 0 panel host: the backend owns the state and streams UiNode trees;
 * the host is a pure renderer. Event ids loop back to the backend, which
 * recomputes and re-renders — remounting this panel is always free.
 */
export function DeclarativePanelHost({ pluginId, panelId }: DeclarativePanelHostProps) {
  const [tree, setTree] = useState<UiNode | null>(null);
  const [ready, setReady] = useState(false);
  const panelKey = `plugin:${pluginId}:${panelId}`;
  // Open params (e.g. { file } for preview panels) — watched so re-opening the
  // SAME active panel with new params notifies the backend.
  const params = usePanelStore((s) => s.params[panelKey]);

  useEffect(() => {
    const bridge = getPluginBridge();
    if (!bridge) return;

    ensureRelayInstalled();
    registerTarget({
      kind: 'declarative',
      pluginId,
      panelId,
      handler: (payload) => {
        const msg = payload as { kind?: string; event?: string; data?: { tree?: UiNode }; panelId?: string };
        if (msg?.kind === 'event' && msg.event === 'ui.render' && msg.panelId === panelId && msg.data?.tree) {
          setTree(msg.data.tree);
          setReady(true);
        }
      },
    });
    bridge.ensurePort(pluginId).catch(() => {});

    return () => {
      unregisterTarget(pluginId, panelId);
    };
  }, [pluginId, panelId]);

  // Ask the backend for the initial render — and re-ask whenever open params
  // change (mount OR same-panel re-open with new params).
  useEffect(() => {
    sendPluginEvent(pluginId, 'panel.mounted', { panelId, params }, panelId);
  }, [pluginId, panelId, params]);

  const handleEvent = (event: 'click' | 'submit', ctx: UiEventContext, data?: unknown) => {
    sendPluginEvent(
      pluginId,
      'ui.event',
      { type: event, eventId: ctx.eventId, data },
      panelId,
    );
  };

  if (!ready || !tree) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-panel-kind="declarative">
        加载中…
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto p-3" data-panel-kind="declarative">
      <DeclarativeRenderer tree={tree} onEvent={handleEvent} />
    </div>
  );
}
