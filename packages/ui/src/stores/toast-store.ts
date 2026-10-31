import { create } from 'zustand';

/**
 * Minimal toast queue for cross-window feedback.
 *
 * Multi-window actions can be refused in main (a conversation already open in
 * another window, a workspace owned by a closing window). A refusal that only
 * lands in the console reads as "nothing happened"; a toast is the smallest
 * honest surface. In-memory only — a toast has no meaning after a restart.
 */
export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, kind?: Toast['kind'], ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, kind = 'info', ttlMs = 4000) => {
    if (!message) return;
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismiss(id), ttlMs);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Fire-and-forget from non-React code (window actions, stores). */
export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  useToastStore.getState().push(message, kind);
}
