import { useMemo } from 'react';
import { ArrowUp, ArrowDown, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useComposerStore } from '@/stores/composer-store';
import type { Message, AssistantMessage, SessionStatsInfo, ContextUsageInfo } from '@pi/types';

interface SessionStatsBarProps {
  messages: Message[];
  contextUsage?: ContextUsageInfo;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCostUSD(cost: number): string {
  if (cost < 0.001) return '< $0.001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Compute session stats from messages when no live stats available */
function computeStatsFromMessages(messages: Message[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let cost = 0;

  for (const m of messages) {
    if (m.role === 'assistant') {
      const usage = (m as AssistantMessage).usage;
      if (usage) {
        input += usage.inputTokens;
        output += usage.outputTokens;
        total += usage.totalTokens;
        cacheRead += usage.cacheReadTokens ?? 0;
        cacheWrite += usage.cacheWriteTokens ?? 0;
        cost += usage.cost ?? 0;
      }
    }
  }

  return { input, output, cacheRead, cacheWrite, total, cost };
}

export function SessionStatsBar({ messages, contextUsage }: SessionStatsBarProps) {
  const liveStats = useComposerStore((s) => s.sessionStats);
  const messageTiming = useComposerStore((s) => s.messageTiming);

  // Prefer live stats during/after streaming, fallback to computed
  const { tokens, cost } = useMemo(() => {
    if (liveStats) {
      return { tokens: liveStats.tokens, cost: liveStats.cost };
    }
    const computed = computeStatsFromMessages(messages);
    return { tokens: computed, cost: computed.cost };
  }, [liveStats, messages]);

  const ctx = liveStats?.contextUsage ?? contextUsage;

  const hasData = tokens.total > 0;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b bg-muted/30 text-[11px] text-muted-foreground/80 shrink-0">
      {hasData ? (
        <>
          {/* Input tokens */}
          <span
            className="flex items-center gap-0.5"
            title={`Input tokens: ${tokens.input.toLocaleString()}`}
          >
            <ArrowUp className="h-3 w-3" />
            {formatTokens(tokens.input)}
          </span>
          {/* Output tokens */}
          <span
            className="flex items-center gap-0.5"
            title={`Output tokens: ${tokens.output.toLocaleString()}`}
          >
            <ArrowDown className="h-3 w-3" />
            {formatTokens(tokens.output)}
          </span>
          {/* Cache read */}
          {tokens.cacheRead > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={`Cache read: ${tokens.cacheRead.toLocaleString()}\nCache write: ${tokens.cacheWrite.toLocaleString()}`}
            >
              <RotateCw className="h-3 w-3" />
              {formatTokens(tokens.cacheRead)}
            </span>
          )}
          {/* Cost */}
          {typeof cost === 'number' && (
            <span className="font-mono tabular-nums text-muted-foreground" title={`Session cost: $${cost.toFixed(6)}`}>
              {formatCostUSD(cost)}
            </span>
          )}
          {/* TPS if available */}
          {messageTiming && (
            <span className="text-muted-foreground/60">
              {messageTiming.tps} t/s
            </span>
          )}
          <div className="flex-1" />
          {/* Context window usage */}
          {ctx && ctx.percent != null && (
            <span
              title={`Context: ${ctx.tokens?.toLocaleString() ?? '?'} / ${ctx.contextWindow.toLocaleString()} (${(ctx.percent * 100).toFixed(1)}%)`}
              className="flex items-center gap-1.5"
            >
              <div className="h-1.5 w-20 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500',
                    ctx.percent > 0.8 ? 'bg-destructive/80' : ctx.percent > 0.6 ? 'bg-amber-400/80' : 'bg-foreground/40',
                  )}
                  style={{ width: `${Math.min(ctx.percent * 100, 100)}%` }}
                />
              </div>
              <span className="text-[10px]">{(ctx.percent * 100).toFixed(0)}%</span>
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground/40 text-[10px]">No usage data yet</span>
      )}
    </div>
  );
}
