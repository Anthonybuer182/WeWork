import { useQuery } from '@tanstack/react-query';
import { DollarSign, Hash, Zap } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/i18n';

export function UsageStatistics() {
  const { t } = useI18n();
  const sdk = useSDK();
  const activeSessionId = useUIStore((s) => s.activeSessionId);

  const { data: session } = useQuery({
    queryKey: ['session', activeSessionId],
    queryFn: () => sdk.session.get(activeSessionId!),
    enabled: !!activeSessionId,
  });

  // Calculate total tokens from messages
  const totalTokens = session?.messages.reduce(
    (sum, m) => sum + (m.role === 'assistant' ? (m as any).usage?.totalTokens ?? 0 : 0),
    0,
  ) ?? 0;

  return (
    <div className="flex items-center gap-3 px-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        <Hash className="h-3 w-3" />
        <span className="tabular-nums">{totalTokens.toLocaleString()}</span>
        <span className="hidden lg:inline">tokens</span>
      </div>
      <div className="flex items-center gap-1">
        <Zap className="h-3 w-3" />
        <span className="tabular-nums">{session?.messages.filter(m => m.role === 'user').length ?? 0}</span>
        <span className="hidden lg:inline">{t('条')}</span>
      </div>
      <div className="flex items-center gap-1">
        <DollarSign className="h-3 w-3" />
        <span className="tabular-nums">
          ${((totalTokens / 1000) * 0.015).toFixed(3)}
        </span>
      </div>
    </div>
  );
}
