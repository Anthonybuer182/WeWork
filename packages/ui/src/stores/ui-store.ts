import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePanelStore } from './panel-store';

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

interface MemoryPreview {
  fileName: string;
  mimeType: string;
  data: string;
}

interface UIState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  activePreviewFilePath: string | null;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  compactMode: boolean;
  selectedSkills: string[];
  connectionStatus: ConnectionStatus;
  searchQuery: string;
  memoryPreviews: Record<string, MemoryPreview>;
  browserUrl: string;

  setActiveWorkspace: (id: string | null) => void;
  setActiveSession: (id: string | null) => void;
  setActivePreviewFile: (path: string | null) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setCompactMode: (compact: boolean) => void;
  toggleSkill: (skillId: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setSearchQuery: (query: string) => void;
  setMemoryPreview: (id: string, info: MemoryPreview) => void;
  clearMemoryPreview: (id: string) => void;
  setBrowserUrl: (url: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      activeSessionId: null,
      activePreviewFilePath: null,
      sidebarOpen: true,
      rightPanelOpen: true,
      rightPanelWidth: 600,
      compactMode: false,
      selectedSkills: [],
      connectionStatus: 'connecting',
      searchQuery: '',
      memoryPreviews: {},
      browserUrl: 'about:blank',

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id, activeSessionId: null }),
      setActiveSession: (id) => set({ activeSessionId: id }),
      // File selection routes through the filePreview contribution chain:
      // a plugin panel claims the extension, otherwise the host preview.
      setActivePreviewFile: (path) => {
        set({ activePreviewFilePath: path, rightPanelOpen: true });
        if (!path) return;
        const api = (window as unknown as {
          electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
        }).electronAPI;
        const openFallback = () =>
          usePanelStore.getState().openPanel('host:preview', { focus: true, params: { file: path } });
        if (!api?.invoke) {
          openFallback();
          return;
        }
        api
          .invoke('pi:plugin:find-preview', { path })
          .then((res) => {
            const panelId = (res as { panelId?: string | null } | undefined)?.panelId;
            if (panelId) {
              usePanelStore.getState().openPanel(panelId, { focus: true, params: { file: path } });
            } else {
              openFallback();
            }
          })
          .catch(() => openFallback());
      },
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
      setCompactMode: (compact) => set({ compactMode: compact }),
      toggleSkill: (skillId) =>
        set((s) => ({
          selectedSkills: s.selectedSkills.includes(skillId)
            ? s.selectedSkills.filter((id) => id !== skillId)
            : [...s.selectedSkills, skillId],
        })),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setMemoryPreview: (id, info) =>
        set((s) => ({ memoryPreviews: { ...s.memoryPreviews, [id]: info } })),
      clearMemoryPreview: (id) =>
        set((s) => {
          const next = { ...s.memoryPreviews };
          delete next[id];
          return { memoryPreviews: next };
        }),
      setBrowserUrl: (url) => set({ browserUrl: url }),
    }),
    {
      name: 'pi-ui-storage',
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activeSessionId: state.activeSessionId,
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelWidth: state.rightPanelWidth,
        compactMode: state.compactMode,
        selectedSkills: state.selectedSkills,
      }),
    },
  ),
);
