import { Brain } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ThinkLevel } from '@pi/types';
import { useI18n, type MessageKey } from '@/i18n';

interface ThinkLevelSelectorProps {
  value?: ThinkLevel;
  onChange?: (level: ThinkLevel) => void;
  supportedLevels?: ThinkLevel[];
}

const levelLabels: Record<ThinkLevel, MessageKey> = {
  off: '不思考',
  low: '低',
  medium: '中',
  high: '高',
};

export function ThinkLevelSelector({ value, onChange, supportedLevels }: ThinkLevelSelectorProps) {
  const { t } = useI18n();
  const levels = supportedLevels ?? ['off', 'low', 'medium', 'high'];

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 min-w-[72px] w-[84px] sm:w-[100px] shrink min-w-0 border-0 bg-transparent hover:bg-accent text-xs" aria-label={t('思考等级')}>
        <Brain className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue placeholder={t('思考')} />
      </SelectTrigger>
      <SelectContent>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {t(levelLabels[level])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
