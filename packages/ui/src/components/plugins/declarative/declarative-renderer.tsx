import type { ReactNode } from 'react';
import type { UiNode } from '@pi/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface UiEventContext {
  eventId: string;
  node: UiNode;
}

interface RendererProps {
  tree: UiNode;
  onEvent: (event: 'click' | 'submit', ctx: UiEventContext, data?: unknown) => void;
}

/**
 * Tier 0 renderer: maps declarative UiNode trees to host components.
 * The plugin ships data, never UI code — theming/a11y/scrolling come free.
 */
export function DeclarativeRenderer({ tree, onEvent }: RendererProps) {
  return <NodeView node={tree} onEvent={onEvent} />;
}

function NodeView({ node, onEvent }: { node: UiNode; onEvent: RendererProps['onEvent'] }) {
  const { component, props = {}, events, children } = node;

  switch (component) {
    case 'Column':
      return (
        <div className={cn('flex flex-col', gapClass(props.gap), padClass(props.padding))} style={alignStyle(props.align)}>
          <Children nodes={children} onEvent={onEvent} />
        </div>
      );

    case 'Row':
      return (
        <div className={cn('flex flex-row items-center', gapClass(props.gap), padClass(props.padding))}>
          <Children nodes={children} onEvent={onEvent} />
        </div>
      );

    case 'Text': {
      const variant = String(props.variant ?? 'default');
      return (
        <span
          className={cn(
            variant === 'muted' && 'text-sm text-muted-foreground',
            variant === 'small' && 'text-xs text-muted-foreground',
            variant === 'title' && 'text-base font-semibold',
            variant === 'default' && 'text-sm',
            props.weight === 'bold' && 'font-semibold',
          )}
        >
          {String(props.text ?? '')}
        </span>
      );
    }

    case 'Button':
      return (
        <Button
          variant={props.variant === 'secondary' ? 'secondary' : props.variant === 'ghost' ? 'ghost' : 'default'}
          size="sm"
          disabled={props.disabled === true}
          data-ui-event={events?.onClick}
          onClick={() => events?.onClick && onEvent('click', { eventId: events.onClick, node }, props)}
        >
          {String(props.label ?? '按钮')}
        </Button>
      );

    case 'Input': {
      const eventId = events?.onSubmit;
      return (
        <Input
          placeholder={props.placeholder ? String(props.placeholder) : undefined}
          defaultValue={props.value !== undefined ? String(props.value) : undefined}
          className="h-8 text-sm"
          data-ui-event={eventId}
          onKeyDown={(e) => {
            if (eventId && e.key === 'Enter') {
              onEvent('submit', { eventId, node }, (e.target as HTMLInputElement).value);
            }
          }}
        />
      );
    }

    case 'Card':
      return (
        <div className="rounded-lg border bg-card p-3">
          {props.title ? <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{String(props.title)}</div> : null}
          <Children nodes={children} onEvent={onEvent} />
        </div>
      );

    case 'Badge':
      return <Badge variant={props.variant === 'secondary' ? 'secondary' : 'default'}>{String(props.text ?? '')}</Badge>;

    case 'List': {
      const items = (props.items ?? []) as Array<{ key?: string; label: string; description?: string; badge?: string | number }>;
      return (
        <div className="flex flex-col gap-1">
          {items.map((item, i) => (
            <button
              key={item.key ?? i}
              type="button"
              data-ui-event={events?.onClick}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                events?.onClick && 'hover:bg-accent',
              )}
              onClick={() => events?.onClick && onEvent('click', { eventId: events.onClick, node }, { key: item.key, label: item.label })}
            >
              <span className="font-medium">{item.label}</span>
              {item.description ? <span className="flex-1 truncate text-xs text-muted-foreground">{item.description}</span> : null}
              {item.badge !== undefined ? <Badge variant="secondary">{item.badge}</Badge> : null}
            </button>
          ))}
        </div>
      );
    }

    case 'Separator':
      return <Separator className="my-2" />;

    case 'Image': {
      const src = typeof props.source === 'string' && props.source.startsWith('data:')
        ? String(props.source)
        : `data:${String(props.mimeType ?? 'image/png')};base64,${String(props.source ?? '')}`;
      const maxHeight = typeof props.maxHeight === 'number' ? props.maxHeight : 280;
      return (
        <img
          src={src}
          alt={String(props.alt ?? '')}
          style={{ maxHeight }}
          className="max-w-full rounded-md border"
        />
      );
    }

    case 'KeyValue': {
      const items = (props.items ?? []) as Array<{ key: string; value: unknown }>;
      return (
        <div className="flex flex-col gap-1">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className="w-20 shrink-0 text-muted-foreground">{String(item.key)}</span>
              <span className="min-w-0 flex-1 break-words">{String(item.value ?? '')}</span>
            </div>
          ))}
        </div>
      );
    }

    case 'Spinner':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {props.label ? String(props.label) : null}
        </div>
      );

    case 'EmptyState':
      return (
        <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
          <span className="text-sm font-medium">{String(props.title ?? '暂无内容')}</span>
          {props.description ? <span className="text-xs text-muted-foreground">{String(props.description)}</span> : null}
        </div>
      );

    default:
      return null;
  }
}

function Children({ nodes, onEvent }: { nodes?: UiNode[]; onEvent: RendererProps['onEvent'] }): ReactNode {
  if (!nodes?.length) return null;
  return (
    <>
      {nodes.map((child, i) => (
        <NodeView key={i} node={child} onEvent={onEvent} />
      ))}
    </>
  );
}

function gapClass(gap: unknown): string {
  switch (gap) {
    case 'sm': return 'gap-1';
    case 'md': return 'gap-2';
    case 'lg': return 'gap-4';
    default: return 'gap-2';
  }
}

function padClass(padding: unknown): string {
  switch (padding) {
    case 'sm': return 'p-1';
    case 'md': return 'p-2';
    case 'lg': return 'p-4';
    case 'none': return '';
    default: return '';
  }
}

function alignStyle(align: unknown): { alignItems?: string } | undefined {
  if (align === 'center') return { alignItems: 'center' };
  return undefined;
}
