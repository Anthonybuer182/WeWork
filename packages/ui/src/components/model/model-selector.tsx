import { useQuery } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/i18n';

interface ModelSelectorProps {
  value?: string;
  onChange?: (modelId: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const { t } = useI18n();
  const sdk = useSDK();

  const { data: models, isLoading } = useQuery({
    queryKey: ['models'],
    queryFn: () => sdk.config.listModels(),
  });

  if (isLoading) return <Skeleton className="h-8 w-[180px]" />;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-7 w-auto min-w-0 max-w-[150px] shrink gap-1 border-0 bg-transparent px-2 text-xs hover:bg-accent xl:max-w-[220px] [&>span]:truncate"
        aria-label={t('选择模型')}
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue placeholder={t('选择模型')} />
      </SelectTrigger>
      <SelectContent>
        {models?.map((model) => (
          <SelectItem key={model.id} value={model.id} disabled={!model.isAvailable}>
            <div className="flex items-center gap-2">
              <span>{model.name}</span>
              {!model.isAvailable && (
                <span className="text-[10px] text-muted-foreground">{t('不可用')}</span>
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
