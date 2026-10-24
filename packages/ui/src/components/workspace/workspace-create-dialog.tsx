import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { switchWorkspace } from '@/lib/switch-workspace';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { Workspace } from '@pi/types';

function folderBasename(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
}

export function WorkspaceCreateButton() {
  const { t } = useI18n();
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const setActiveWorkspace = useUIStore((s) => s.setActiveWorkspace);

  const createMutation = useMutation({
    mutationFn: async () => {
      const path = await sdk.transport.request('system.selectDirectory');
      if (!path || typeof path !== 'string') return null;
      const name = folderBasename(path);
      return sdk.workspace.create(name, path);
    },
    onSuccess: (result) => {
      if (result) {
        // Immediately insert into cache so dropdown shows it
        queryClient.setQueryData<Workspace[]>(['workspaces'], (old) =>
          old ? [result, ...old] : [result],
        );
        // Auto-select the new workspace (with its conversation prepared, so the
        // centre panel doesn't flash through a session-less frame).
        switchWorkspace(sdk, queryClient, result.id);
        // Background refresh for eventual consistency
        queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      }
    },
  });

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('创建工作区')}
      disabled={createMutation.isPending}
      onClick={() => createMutation.mutate()}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}
