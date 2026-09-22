import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePanelStore } from './panel-store';
import { openWithSystemApp } from '@/lib/utils';

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

interface UIState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  activePreviewFilePath: string | null;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  /**
   * Right panel expanded over the centre area for focused work. Deliberately
   * not persisted, like `rightPanelOpen` — the panel should not come back
   * fullscreen on the next launch.
   */
  rightPanelMaximized: boolean;
  rightPanelWidth: number;
  leftPanelWidth: number;
  compactMode: boolean;
  selectedSkills: string[];
  connectionStatus: ConnectionStatus;

  setActiveWorkspace: (id: string | null) => void;
  /**
   * Set workspace and session in one update. Use when the session for the new
   * workspace is already prepared — see `switchWorkspace()` in lib/. Setting
   * them separately renders a frame with a workspace but no session, which
   * makes the centre panel flash.
   */
  setActiveWorkspaceAndSession: (workspaceId: string | null, sessionId: string | null) => void;
  setActiveSession: (id: string | null) => void;
  setActivePreviewFile: (path: string | null) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanelMaximized: () => void;
  setRightPanelMaximized: (maximized: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setLeftPanelWidth: (width: number) => void;
  setCompactMode: (compact: boolean) => void;
  toggleSkill: (skillId: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      activeSessionId: null,
      activePreviewFilePath: null,
      sidebarOpen: true,
      rightPanelOpen: false,
      rightPanelMaximized: false,
      rightPanelWidth: 600,
      // Wider than the old hardcoded 260 default: the left sidebar hosts
      // settings as a view, whose forms need the room.
      leftPanelWidth: 300,
      compactMode: false,
      selectedSkills: [],
      connectionStatus: 'connecting',

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id, activeSessionId: null }),
      setActiveWorkspaceAndSession: (workspaceId, sessionId) =>
        set({ activeWorkspaceId: workspaceId, activeSessionId: sessionId }),
      setActiveSession: (id) => set({ activeSessionId: id }),
      // File selection routes through the filePreview contribution chain:
      // a plugin panel claims the extension — there is no host fallback
      // (preview is fully plugin-owned).
      setActivePreviewFile: (path) => {
        set({ activePreviewFilePath: path });
        if (!path) return;
        const api = (window as unknown as {
          electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
        }).electronAPI;
        if (!api?.invoke) return;
        api
          .invoke('pi:plugin:find-preview', { path })
          .then((res) => {
            const panelId = (res as { panelId?: string | null } | undefined)?.panelId;
            if (panelId) {
              set({ rightPanelOpen: true });
              usePanelStore.getState().openPanel(panelId, { focus: true, params: { file: path } });
            } else {
              // No preview plugin claims this extension. `isPreviewableInRightPanel`
              // also covers images, video, html and plain code files, which no
              // plugin handles — that combination used to fall through silently
              // and made the click look broken. Hand it to the system instead.
              openWithSystemApp(path, useUIStore.getState().activeWorkspaceId ?? undefined);
            }
          })
          .catch(() => {});
      },
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      setRightPanelOpen: (open) =>
        set(open ? { rightPanelOpen: true } : { rightPanelOpen: false, rightPanelMaximized: false }),
      toggleRightPanelMaximized: () => set((s) => ({ rightPanelMaximized: !s.rightPanelMaximized })),
      setRightPanelMaximized: (maximized) => set({ rightPanelMaximized: maximized }),
      setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
      setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
      setCompactMode: (compact: boolean) => set({ compactMode: compact }),
      toggleSkill: (skillId: string) =>
        set((s) => ({
          selectedSkills: s.selectedSkills.includes(skillId)
            ? s.selectedSkills.filter((id) => id !== skillId)
            : [...s.selectedSkills, skillId],
        })),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
    }),
    {
      name: 'pi-ui-storage',
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activeSessionId: state.activeSessionId,
        sidebarOpen: state.sidebarOpen,
        // rightPanelOpen is intentionally NOT persisted: the right side
        // defaults to the icon rail only — panels open on explicit action
        // (rail click) or agent event, never restored open across restarts.
        rightPanelWidth: state.rightPanelWidth,
        leftPanelWidth: state.leftPanelWidth,
        compactMode: state.compactMode,
        selectedSkills: state.selectedSkills,
      }),
    },
  ),
);
