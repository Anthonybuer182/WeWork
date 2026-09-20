import type { QueryClient } from '@tanstack/react-query';
import type { PiSDKClient } from '@pi/sdk-wrapper';
import { useUIStore } from '@/stores/ui-store';

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
  try {
    const created = await sdk.session.create(workspaceId);
    // Read it back to get the exact shape, then seed the cache. Without this
    // the query has no data for the new id and ChatTimeline renders its
    // loading spinner. A fresh session has no messages, so this is cheap.
    const session = await sdk.session.get(created.id);

    queryClient.setQueryData(['session', created.id], session);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });

    useUIStore.getState().setActiveWorkspaceAndSession(workspaceId, created.id);
  } catch {
    useUIStore.getState().setActiveWorkspace(workspaceId);
  }
}
