import { MessageSquare } from 'lucide-react';
import { useI18n } from '@/i18n';

export function EmptyChat() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <MessageSquare className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} />
      <div className="text-center">
        <h3 className="text-lg font-medium">{t('没有进行中的会话')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('从左侧选择一个会话，或新建一个开始。')}
        </p>
      </div>
    </div>
  );
}
