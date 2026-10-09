import { Shield, ShieldAlert, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUIStore } from '@/stores/ui-store';
import { usePermissionStore, type PermissionMode } from '@/stores/permission-store';

const MODE_LABELS: Record<PermissionMode, { title: string; hint: string }> = {
  default: { title: '默认', hint: '高危操作逐条批准' },
  full: { title: '完全访问', hint: '不拦截，仅记录审计日志' },
};

/**
 * The session-scoped permission mode toggle, in the composer's bottom tools
 * row. Quiet in default mode (icon only); loud in 完全访问 (red icon + label)
 * because an open door must stay visible, not remembered.
 *
 * Hidden in the web build: there is no main process to enforce anything, and
 * a toggle that only pretends would be worse than none.
 */
export function PermissionModeButton() {
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  // Keyless state (no session yet) maps to main's 'default' key — same
  // fallback the chat service uses when the first message creates a session.
  const mode = usePermissionStore(
    (s) => s.modeBySession[activeSessionId ?? 'default'] ?? 'default',
  );
  const setMode = usePermissionStore((s) => s.setMode);

  // Web build: no electronAPI → nothing enforces the gate → hide the control.
  if (
    !(window as unknown as { electronAPI?: unknown }).electronAPI
  ) {
    return null;
  }

  const isFull = mode === 'full';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={
            isFull
              ? 'h-8 gap-1.5 text-xs text-red-600 dark:text-red-400 hover:text-red-600 dark:hover:text-red-400'
              : 'h-8 gap-1.5 text-xs text-muted-foreground'
          }
          title="权限模式（仅当前会话生效，重启后恢复默认）"
        >
          {isFull ? (
            <ShieldAlert className="h-3.5 w-3.5" />
          ) : (
            <Shield className="h-3.5 w-3.5" />
          )}
          {isFull && MODE_LABELS[mode].title}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {(Object.keys(MODE_LABELS) as PermissionMode[]).map((key) => (
          <DropdownMenuItem
            key={key}
            onClick={() => setMode(activeSessionId ?? 'default', key)}
            className="flex flex-col items-start gap-0.5 cursor-pointer"
          >
            <span
              className={
                key === 'full' ? 'text-red-600 dark:text-red-400 font-medium' : 'font-medium'
              }
            >
              {MODE_LABELS[key].title}
              {mode === key && <span className="ml-1.5 text-[10px] opacity-60">当前</span>}
            </span>
            <span className="text-[10px] text-muted-foreground font-normal">
              {MODE_LABELS[key].hint}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
