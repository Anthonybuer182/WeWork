import { Minimize2, Maximize2 } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';

interface CompactToggleProps {
  compact: boolean;
  onToggle: (compact: boolean) => void;
}

export function CompactToggle({ compact, onToggle }: CompactToggleProps) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          pressed={compact}
          onPressedChange={onToggle}
          size="sm"
          aria-label={t('切换紧凑模式')}
        >
          {compact ? (
            <Maximize2 className="h-4 w-4" />
          ) : (
            <Minimize2 className="h-4 w-4" />
          )}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>
        {compact ? t('退出紧凑模式') : t('紧凑模式')}
      </TooltipContent>
    </Tooltip>
  );
}
