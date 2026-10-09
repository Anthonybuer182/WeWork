import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePermissionStore, type PermissionRequest } from '@/stores/permission-store';

/**
 * What the user is agreeing to when they click 总是允许, in the same coarse
 * units main actually remembers: bash by first word, everything else by tool.
 */
function alwaysScope(request: PermissionRequest): string {
  const command = request.args?.command;
  if (request.toolName === 'bash' && typeof command === 'string') {
    const firstWord = command.trim().split(/\s+/)[0];
    if (firstWord) return `本会话内放行所有以 ${firstWord} 开头的命令`;
  }
  return `本会话内放行 ${request.toolName} 的所有调用`;
}

/**
 * The inline approval card, rendered inside the waiting tool call's block —
 * at the call site, not as a modal, so the user sees exactly which command or
 * path is asking. Three verdicts: deny / allow once / allow for the session.
 */
export function PermissionRequestCard({ request }: { request: PermissionRequest }) {
  const resolve = usePermissionStore((s) => s.resolve);

  return (
    <div className="border-t border-amber-300/50 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
            高危操作，等待批准
          </div>
          {request.summary && (
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/80">
              {request.summary}
            </pre>
          )}
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px] border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => resolve(request, 'deny')}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => resolve(request, 'once')}
            >
              允许一次
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              title={alwaysScope(request)}
              onClick={() => resolve(request, 'always')}
            >
              总是允许
            </Button>
          </div>
          <div className="mt-1.5 text-[10px] text-muted-foreground/70">
            总是允许：{alwaysScope(request)}
          </div>
        </div>
      </div>
    </div>
  );
}
