import { CheckCircle2, Circle, ListTodo, Loader2, XCircle } from 'lucide-react';
import type { TodoItem, TodoPriority, TodoSnapshot } from '@pi/types';
import { cn } from '@/lib/utils';
import { useI18n, type MessageKey } from '@/i18n';

const PRIORITY_LABEL: Record<TodoPriority, MessageKey> = {
  high: '高',
  medium: '中',
  low: '低',
};

const PRIORITY_STYLE: Record<TodoPriority, string> = {
  high: 'border-red-400/40 text-red-600 dark:text-red-400',
  medium: 'border-amber-400/40 text-amber-600 dark:text-amber-400',
  low: 'border-border text-muted-foreground',
};

/**
 * The agent's working checklist.
 *
 * Rendered from the store rather than from the tool's arguments, so the card
 * is live: a second `todotool` call replaces the list in place instead of
 * appending another card. The snapshot is the whole state — no merge.
 */
export function TodoCard({ snapshot }: { snapshot: TodoSnapshot | null }) {
  const { t } = useI18n();
  const todos = snapshot?.todos ?? [];
  const completed = todos.filter((todo) => todo.status === 'completed').length;

  return (
    <div className="border-t border-border/40 bg-background/60 px-3 py-2" data-todo-card>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <ListTodo className="h-3 w-3" />
        {t('任务清单')}
        {todos.length > 0 && (
          <span className="ml-auto tabular-nums normal-case tracking-normal">
            {completed}/{todos.length}
          </span>
        )}
      </div>

      {todos.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/60">{t('暂无任务')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {todos.map((todo, index) => (
            <TodoRow key={`${index}-${todo.content}`} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const { t } = useI18n();
  const done = todo.status === 'completed';
  const cancelled = todo.status === 'cancelled';
  const running = todo.status === 'in_progress';

  return (
    <li className={cn('flex items-start gap-1.5 text-xs leading-5', cancelled && 'opacity-60')}>
      <span className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : cancelled ? (
          <XCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
        ) : running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
        ) : (
          <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          done && 'text-muted-foreground line-through',
          cancelled && 'text-muted-foreground line-through',
          running && 'font-medium text-foreground',
        )}
      >
        {todo.content}
      </span>
      {todo.priority && todo.priority !== 'low' && (
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded border px-1 text-[9px] leading-4',
            PRIORITY_STYLE[todo.priority],
          )}
        >
          {t(PRIORITY_LABEL[todo.priority])}
        </span>
      )}
    </li>
  );
}
