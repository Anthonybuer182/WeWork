import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const MAIN_ENTRY = path.resolve(__dirname, '../apps/desktop/out/main/index.mjs');

export interface TestContext {
  app: ElectronApplication;
  page: Page;
}

/**
 * Launch the built Electron app for E2E testing.
 * The app must be built first with `pnpm --filter @pi/desktop build`.
 */
export async function launchApp(): Promise<TestContext> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PI_E2E: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  return { app, page };
}

/**
 * Launch the app and clean all persisted state so each test starts fresh.
 * This deletes all workspaces via IPC, clears localStorage (Zustand persist),
 * and reloads the page.
 */
export async function launchAppClean(): Promise<TestContext> {
  const ctx = await launchApp();
  await cleanAppState(ctx);
  return ctx;
}

/**
 * Clean all persisted state: delete all workspaces, clear localStorage, reload.
 * Use this when a test needs a fresh state.
 */
export async function cleanAppState(ctx: TestContext): Promise<void> {
  const { app, page } = ctx;

  // Delete all existing workspaces via IPC
  try {
    const workspaces = await listWorkspacesViaIPC(page);
    for (const ws of workspaces) {
      await deleteWorkspaceViaIPC(page, ws.id);
    }
  } catch {
    // Ignore if no workspaces or IPC not ready
  }

  // Clear localStorage (Zustand persist stores UI state here)
  await page.evaluate(() => {
    localStorage.clear();
  });

  // Reload to apply the clean state
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
}

/**
 * Create a temporary directory to use as a workspace path.
 */
export function createTempWorkspaceDir(name: string = 'test-workspace'): string {
  const dir = path.join('/tmp', `pi-e2e-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up a temporary directory.
 */
export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a workspace via IPC directly (bypasses the native directory dialog).
 * Returns the created workspace object.
 */
export async function createWorkspaceViaIPC(
  page: Page,
  name: string,
  workspacePath: string,
): Promise<{ id: string; name: string; path: string }> {
  const result = await page.evaluate(
    async ({ name, workspacePath }) => {
      const res = await (window as any).electronAPI.invoke('pi:sdk:request', {
        id: `create-ws-${Date.now()}`,
        method: 'workspace.create',
        params: { name, path: workspacePath },
      });
      return res;
    },
    { name, workspacePath },
  );
  return result.result;
}

/**
 * Create a session via IPC directly.
 */
export async function createSessionViaIPC(
  page: Page,
  workspaceId: string,
  title?: string,
): Promise<{ id: string; workspaceId: string; title: string }> {
  const result = await page.evaluate(
    async ({ workspaceId, title }) => {
      const res = await (window as any).electronAPI.invoke('pi:sdk:request', {
        id: `create-session-${Date.now()}`,
        method: 'session.create',
        params: { workspaceId, title },
      });
      return res;
    },
    { workspaceId, title },
  );
  return result.result;
}

/**
 * List sessions via IPC.
 */
export async function listSessionsViaIPC(
  page: Page,
  workspaceId: string,
): Promise<any[]> {
  const result = await page.evaluate(
    async (wsId) => {
      const res = await (window as any).electronAPI.invoke('pi:sdk:request', {
        id: `list-sessions-${Date.now()}`,
        method: 'session.list',
        params: { workspaceId: wsId },
      });
      return res;
    },
    workspaceId,
  );
  return result.result;
}

/**
 * List workspaces via IPC.
 */
export async function listWorkspacesViaIPC(page: Page): Promise<any[]> {
  const result = await page.evaluate(async () => {
    const res = await (window as any).electronAPI.invoke('pi:sdk:request', {
      id: `list-ws-${Date.now()}`,
      method: 'workspace.list',
      params: {},
    });
    return res;
  });
  return result.result;
}

/**
 * Delete a workspace via IPC.
 */
export async function deleteWorkspaceViaIPC(page: Page, id: string): Promise<void> {
  await page.evaluate(async (workspaceId) => {
    await (window as any).electronAPI.invoke('pi:sdk:request', {
      id: `delete-ws-${Date.now()}`,
      method: 'workspace.delete',
      params: { id: workspaceId },
    });
  }, id);
}

/**
 * Mock the native directory dialog to return a specific path.
 * Must be called after the app is launched.
 */
export async function mockDirectoryDialog(
  app: ElectronApplication,
  dirPath: string,
): Promise<void> {
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    }) as any;
  }, dirPath);
}
