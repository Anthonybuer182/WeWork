import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { SessionItem } from './session-item';
import { SessionCreateButton } from './session-create-button';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { ErrorState } from '@/components/common/error-state';
import type { Session } from '@pi/types';
import { Virtuoso } from 'react-virtuoso';

export function SessionList() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const setActiveSession = useUIStore((s) => s.setActiveSession);
  // Title filter — client-side over the already-loaded list, instant.
  const [filter, setFilter] = useState('');

  const deleteSession = useMutation({
    mutationFn: (id: string) => sdk.session.delete(id),
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', activeWorkspaceId] });
      if (deletedId === activeSessionId) {
        setActiveSession(null);
      }
    },
  });

  const { data: sessions, isLoading, error, refetch } = useQuery({
    queryKey: ['sessions', activeWorkspaceId],
    queryFn: async () => {
      if (!activeWorkspaceId) return [];
      return sdk.session.list(activeWorkspaceId);
    },
    enabled: !!activeWorkspaceId,
    refetchInterval: 5000,
  });

  if (!activeWorkspaceId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        Select a workspace to view sessions
      </div>
    );
  }

  if (isLoading) return <LoadingSpinner message="Loading sessions..." />;
  if (error) return <ErrorState description="Failed to load sessions" onRetry={() => refetch()} />;

  const items = sessions ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter((s) => (s.title ?? '').toLowerCase().includes(needle))
    : items;

  return (
    <div className="flex flex-col gap-1 min-h-0 flex-1">
      <SessionCreateButton />
      <div className="flex items-center gap-2 px-3 py-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      {needle && visible.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">未找到匹配会话</p>
      )}
      <Virtuoso
        className="flex-1"
        data={visible}
        itemContent={(_index, session: Session) => (
          <SessionItem
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => setActiveSession(session.id)}
            onDelete={() => deleteSession.mutate(session.id)}
          />
        )}
      />
    </div>
  );
}
