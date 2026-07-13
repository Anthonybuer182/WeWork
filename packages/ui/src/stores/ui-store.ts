import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  rightPanelActiveTab: 'preview' | 'settings' | 'browser';
  compactMode: boolean;
  selectedSkills: string[];
  connectionStatus: ConnectionStatus;
  searchQuery: string;
  memoryPreviews: Record<string, MemoryPreview>;
  browserUrl: string;
  isRecording: boolean;

  setActiveWorkspace: (id: string | null) => void;
  setActiveSession: (id: string | null) => void;
  setActivePreviewFile: (path: string | null) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setRightPanelTab: (tab: string) => void;
  setCompactMode: (compact: boolean) => void;
  toggleSkill: (skillId: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setSearchQuery: (query: string) => void;
  setMemoryPreview: (id: string, info: MemoryPreview) => void;
  clearMemoryPreview: (id: string) => void;
  setBrowserUrl: (url: string) => void;
  setRecording: (recording: boolean) => void;
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
      rightPanelActiveTab: 'preview',
      compactMode: false,
      selectedSkills: [],
      connectionStatus: 'connecting',
      searchQuery: '',
      memoryPreviews: {},
      browserUrl: 'about:blank',
      isRecording: false,

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id, activeSessionId: null }),
      setActiveSession: (id) => set({ activeSessionId: id }),
      setActivePreviewFile: (path) => set({ activePreviewFilePath: path, rightPanelActiveTab: 'preview', rightPanelOpen: true }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
      setRightPanelTab: (tab) => set({ rightPanelActiveTab: tab === 'settings' ? 'settings' : tab === 'browser' ? 'browser' : 'preview' }),
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
      setRecording: (recording) => set({ isRecording: recording }),
    }),
    {
      name: 'pi-ui-storage',
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activeSessionId: state.activeSessionId,
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelActiveTab: state.rightPanelActiveTab,
        compactMode: state.compactMode,
        selectedSkills: state.selectedSkills,
      }),
    },
  ),
);
