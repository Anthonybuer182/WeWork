import type { QueryClient } from '@tanstack/react-query';
import type { PiSDKClient } from '@pi/sdk-wrapper';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/stores/toast-store';
import { t } from '@/i18n';
import { activateSession, focusWorkspaceElsewhere } from './window-actions';

/**
 * Switch to a workspace with its conversation already in place.
 *
 * Clearing the session and creating a new one asynchronously makes the centre
 * panel flash through "No active session" and a "Loading messages..." spinner
 * before settling on the new (empty) conversation. Preparing the session BEFORE
 * touching the store means the panel goes straight from the old conversation to
 * the new one — the old one simply stays on screen during the round trip.
 *
 * Falls back to a plain switch if session creation fails, so a workspace is
 * still selectable even when the SDK call doesn't work out; the composer's
 * auto-session effect will retry.
 */
export async function switchWorkspace(
  sdk: PiSDKClient,
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  // VS Code behaviour: a folder already open in another window is brought to
  // the front instead of being opened a second time. The explicit
  // "open in new window" action is the only way to duplicate it.
  if (await focusWorkspaceElsewhere(workspaceId)) {
    toast(t('该工作区已在另一个窗口打开，已切换到那个窗口'));
    return;
  }
  try {
    const created = await sdk.session.create(workspaceId);
    // Read it back to get the exact shape, then seed the cache. Without this
    // the query has no data for the new id and ChatTimeline renders its
    // loading spinner. A fresh session has no messages, so this is cheap.
    const session = await sdk.session.get(created.id);

    queryClient.setQueryData(['session', created.id], session);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });

    // Claim the fresh conversation for this window (a new id cannot already
    // be owned elsewhere, but the claim also records the window's view state
    // in main so a reload or a second window starts from the truth).
    await activateSession(created.id);
    useUIStore.getState().setActiveWorkspaceAndSession(workspaceId, created.id);
  } catch {
    useUIStore.getState().setActiveWorkspace(workspaceId);
  }
}
