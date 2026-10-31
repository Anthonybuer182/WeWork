import { MessageSquare, MoreHorizontal, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Session } from '@pi/types';
import { useI18n } from '@/i18n';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete?: () => void;
  /** Desktop only: open this conversation in its own window. */
  onOpenInNewWindow?: () => void;
}

export function SessionItem({
  session,
  isActive,
  onClick,
  onDelete,
  onOpenInNewWindow,
}: SessionItemProps) {
  const { t } = useI18n();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      aria-current={isActive ? 'page' : undefined}
      aria-label={t('切换到会话：{title}', { title: session.title })}
      className={cn(
        'group flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer transition-colors',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50 text-foreground',
      )}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{session.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {session.messageCount}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
            aria-label={t('更多选项')}
          >
            <MoreHorizontal className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {onOpenInNewWindow && (
            <DropdownMenuItem onClick={() => onOpenInNewWindow()}>
              <SquareArrowOutUpRight className="mr-2 h-4 w-4" />
              {t('在新窗口打开')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => onDelete?.()}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('删除')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
