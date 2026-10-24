import { Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface SendButtonProps {
  disabled?: boolean;
  isLoading?: boolean;
  onClick: () => void;
}

export function SendButton({ disabled, isLoading, onClick }: SendButtonProps) {
  const { t } = useI18n();
  return (
    <Button
      size="icon"
      onClick={onClick}
      disabled={disabled || isLoading}
      className="h-9 w-9 shrink-0"
      aria-label={t('发送消息')}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Send className="h-4 w-4" />
      )}
    </Button>
  );
}
