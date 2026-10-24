import { Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The settings entry, pinned to the bottom of the left rail.
 *
 * Not a panel entry: settings opens a centred dialog, so it must not take part
 * in panel selection, persistence or pane layout. It lives in the rail because
 * that is where a configuration entry belongs — the same place it had when it
 * was a column view.
 */
export function SettingsRailButton() {
  const openSettings = useUIStore((s) => s.openSettings);
  const { t } = useI18n();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t('设置')}
          data-testid="settings-rail-button"
          onClick={openSettings}
          className={cn(
            'relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <Settings className="h-5 w-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{t('设置')}</TooltipContent>
    </Tooltip>
  );
}
