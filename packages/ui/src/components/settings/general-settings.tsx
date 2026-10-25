import type { ReactNode } from 'react';
import type { ThemeMode } from '@pi/types';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useUIStore } from '@/stores/ui-store';
import {
  useI18n,
  useLanguageStore,
  LANGUAGE_OPTIONS,
  type Language,
  type MessageKey,
} from '@/i18n';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const THEME_OPTIONS: { value: ThemeMode; label: MessageKey }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
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
 * Both rows are client preferences: the theme lives in the theme store and the
 * language in the language store, so each applies instantly and survives with
 * no backend round-trip. Model, thinking level and skill selection are
 * deliberately absent — the composer already owns those, per conversation.
 */
export function GeneralSettingsPage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const compactMode = useUIStore((s) => s.compactMode);
  const setCompactMode = useUIStore((s) => s.setCompactMode);

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-2">
      <div className="divide-y">
        <Row label={t('外观')} hint={t('整个应用的配色，立即生效。')}>
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
                {t(opt.label)}
              </button>
            ))}
          </div>
        </Row>

        <Row label={t('语言')} hint={t('切换后立即生效，并记住选择。')}>
          <Select value={language} onValueChange={(value: string) => setLanguage(value as Language)}>
            <SelectTrigger className="w-[220px]" aria-label={t('语言')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label={t('紧凑模式')} hint={t('收紧消息间距，一屏看更多内容。')}>
          <Switch
            checked={compactMode}
            onCheckedChange={setCompactMode}
            aria-label={t('紧凑模式')}
          />
        </Row>
      </div>

      <p className="pb-4 pt-2 text-[11px] text-muted-foreground/70">
        {t('外观和语言保存在本机。')}
      </p>
    </div>
  );
}
