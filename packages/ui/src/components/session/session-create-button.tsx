import { Plus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { activateSession } from '@/lib/window-actions';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SessionCreateButtonProps {
  className?: string;
}

export function SessionCreateButton({ className }: SessionCreateButtonProps) {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const { t } = useI18n();

  const createMutation = useMutation({
    mutationFn: () => {
      if (!activeWorkspaceId) throw new Error('No workspace selected');
      return sdk.session.create(activeWorkspaceId);
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void activateSession(session.id);
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('w-full', className)}
      onClick={() => createMutation.mutate()}
      disabled={!activeWorkspaceId || createMutation.isPending}
    >
      <Plus className="mr-2 h-4 w-4" />
      {t('新建会话')}
    </Button>
  );
}
