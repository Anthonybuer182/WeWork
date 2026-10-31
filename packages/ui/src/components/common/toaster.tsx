import { useToastStore } from '@/stores/toast-store';
import { cn } from '@/lib/utils';

/** Renders the toast queue. Mounted once by AppShell, above the app content. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={cn(
            'pointer-events-auto max-w-[80vw] rounded-md border px-4 py-2 text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2',
            toast.kind === 'error'
              ? 'border-destructive/40 bg-destructive text-destructive-foreground'
              : 'border-border bg-popover text-popover-foreground',
          )}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
