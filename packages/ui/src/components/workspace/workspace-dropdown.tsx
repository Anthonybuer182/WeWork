import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { switchWorkspace } from '@/lib/switch-workspace';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Workspace } from '@pi/types';

export function WorkspaceDropdown() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useUIStore((s) => s.setActiveWorkspace);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);

  const { data: workspaces, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });

  // A persisted activeWorkspaceId can point at a workspace that no longer
  // exists (directory deleted, or the workspace was removed). The services
  // swallow fs errors and return empty arrays, so the file tree and session
  // list silently render as "empty" with no way for the user to tell. Fall
  // back to the first available workspace instead of leaving a dead id.
  useEffect(() => {
    if (!workspaces) return;
    if (activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId)) return;
    // Don't clobber a deliberate "no workspace" state on a fresh install with
    // zero workspaces — there is nothing to fall back to.
    if (!activeWorkspaceId && workspaces.length === 0) return;
    const fallback = workspaces[0]?.id;
    if (fallback) switchWorkspace(sdk, queryClient, fallback);
    else setActiveWorkspace(null);
  }, [workspaces, activeWorkspaceId, setActiveWorkspace, sdk, queryClient]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sdk.workspace.delete(id),
    onSuccess: () => {
      if (deleteTarget && deleteTarget.id === activeWorkspaceId) {
        // Switch to the next available workspace
        const remaining = queryClient
          .getQueryData<Workspace[]>(['workspaces'])
          ?.filter((w) => w.id !== deleteTarget.id);
        if (remaining && remaining.length > 0) {
          switchWorkspace(sdk, queryClient, remaining[0].id);
        } else {
          setActiveWorkspace(null);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setDeleteTarget(null);
    },
  });

  const activeWorkspaceName = workspaces?.find((w) => w.id === activeWorkspaceId)?.name;

  if (isLoading) {
    return <Skeleton className="h-8 w-full" />;
  }

  return (
    <>
      <Select
        value={activeWorkspaceId ?? undefined}
        onValueChange={(id) => switchWorkspace(sdk, queryClient, id)}
      >
        <SelectTrigger
          // w-auto, not w-full: the icon/name/chevron sit next to each other.
          // min-w-0 + [&>span]:min-w-0 let the name ellipsize when the whole
          // group is clamped by the title bar's max-width.
          className="h-8 w-auto min-w-0 max-w-full gap-1.5 border-0 bg-transparent px-2 hover:bg-accent [&>span]:min-w-0"
          aria-label="Select workspace"
          title={activeWorkspaceName}
        >
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          {/* Explicit children override Radix's default, which mirrors the
              selected item's full text (name + session count). The trigger is
              a tight title-bar slot — the count belongs in the list, where it
              helps you pick, not here where it truncates the name. */}
          <SelectValue placeholder="Select workspace...">{activeWorkspaceName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {workspaces?.map((ws) => (
            <div key={ws.id} className="flex items-center w-full">
              <SelectItem value={ws.id} className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate">{ws.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {ws.sessionCount} sessions
                  </span>
                </div>
              </SelectItem>
              <button
                className="shrink-0 p-1 mr-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                aria-label={`Delete workspace ${ws.name}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setDeleteTarget(ws);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workspace</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{' '}
              <span className="font-semibold text-foreground">{deleteTarget?.name}</span>
              {deleteTarget && deleteTarget.sessionCount > 0
                ? ` and all ${deleteTarget.sessionCount} sessions within it`
                : ''}.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
