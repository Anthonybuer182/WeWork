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
      <SelectTrigger
        className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent px-2 text-xs hover:bg-accent"
        aria-label={t('思考等级')}
        title={t('思考等级')}
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
