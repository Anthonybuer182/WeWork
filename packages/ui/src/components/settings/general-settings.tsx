import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import type { Config, ThemeMode } from '@pi/types';
import { useSDK } from '@/hooks/use-sdk';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { ErrorState } from '@/components/common/error-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

const THINK_OPTIONS: { value: Config['defaultThinkLevel']; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '不显示思考过程' },
  { value: 'low', label: '低', hint: '更快，思考更少' },
  { value: 'medium', label: '中', hint: '默认' },
  { value: 'high', label: '高', hint: '更慢，思考更充分' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/**
 * 通用 — the settings that apply to the whole app rather than to one provider
 * or one conversation.
 *
 * Appearance is a client preference and lives in the theme store (it must
 * apply instantly and survive without the backend). The rest are written to
 * `~/.pi/agent/settings.json` through `config.update`.
 */
export function GeneralSettingsPage() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const {
    data: config,
    isLoading,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: ['config'],
    queryFn: () => sdk.config.get(),
  });

  const { data: models } = useQuery({
    queryKey: ['models'],
    queryFn: () => sdk.config.listModels(),
  });

  const update = useMutation({
    mutationFn: (data: Partial<Config>) => sdk.config.update(data),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (loadError || !config) {
    return (
      <div className="flex h-full items-center justify-center">
        <ErrorState
          title="读取通用设置失败"
          description={loadError instanceof Error ? loadError.message : '未知错误'}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-2">
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <div className="divide-y">
        <Row label="外观" hint="整个应用的配色，立即生效。">
          <div className="flex rounded-md border p-0.5">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={theme === opt.value}
                onClick={() => setTheme(opt.value)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  theme === opt.value
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Row>

        <Row label="默认模型" hint="新对话开始时使用的模型。">
          <Select
            value={config.defaultModelId || undefined}
            onValueChange={(id: string) => update.mutate({ defaultModelId: id })}
          >
            <SelectTrigger className="w-[220px]" aria-label="默认模型">
              <SelectValue placeholder="未选择" />
            </SelectTrigger>
            <SelectContent>
              {models?.map((m) => (
                <SelectItem key={m.id} value={m.id} disabled={!m.isAvailable}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label="思考等级" hint="模型在回答前投入多少推理。">
          <Select
            value={config.defaultThinkLevel}
            onValueChange={(level: string) =>
              update.mutate({ defaultThinkLevel: level as Config['defaultThinkLevel'] })
            }
          >
            <SelectTrigger className="w-[220px]" aria-label="思考等级">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINK_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="flex items-center gap-2">
                    {opt.label}
                    <span className="text-[10px] text-muted-foreground">{opt.hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row
          label="自动压缩对话"
          hint="上下文快满时，自动把较早的内容压缩成摘要继续对话。关闭后长对话会直接失败，需要手动清理。"
        >
          <Switch
            aria-label="自动压缩对话"
            checked={config.compactionEnabled}
            onCheckedChange={(checked: boolean) => update.mutate({ compactionEnabled: checked })}
          />
        </Row>
      </div>

      <p className="pb-4 pt-2 text-[11px] text-muted-foreground/70">
        后三项写入 ~/.pi/agent/settings.json；外观保存在本机。
      </p>
    </div>
  );
}
