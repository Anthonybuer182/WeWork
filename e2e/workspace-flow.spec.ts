import { test, expect } from '@playwright/test';
import {
  launchAppClean,
  TestContext,
  createTempWorkspaceDir,
  cleanupDir,
  createWorkspaceViaIPC,
  createSessionViaIPC,
  listWorkspacesViaIPC,
  listSessionsViaIPC,
  deleteWorkspaceViaIPC,
  mockDirectoryDialog,
} from './helpers';

let ctx: TestContext;
let tempDirs: string[] = [];

test.afterEach(async () => {
  if (ctx) {
    try {
      const workspaces = await listWorkspacesViaIPC(ctx.page);
      for (const ws of workspaces) {
        await deleteWorkspaceViaIPC(ctx.page, ws.id);
      }
    } catch {
      // Ignore cleanup errors
    }
    await ctx.app.close();
    ctx = undefined as any;
  }
  for (const dir of tempDirs) {
    cleanupDir(dir);
  }
  tempDirs = [];
});

async function createWorkspaceViaUI(ctx: TestContext, tempDir: string): Promise<void> {
  await mockDirectoryDialog(ctx.app, tempDir);
  await ctx.page.locator('[aria-label="Create workspace"]').click();
  await ctx.page.waitForTimeout(2000);
}

test.describe('Workspace Management', () => {
  test('should create a workspace via IPC and verify via IPC list', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('ws-ipc');
    tempDirs.push(tempDir);

    const workspace = await createWorkspaceViaIPC(page, 'IPC Test Workspace', tempDir);
    expect(workspace).toBeTruthy();
    expect(workspace.name).toBe('IPC Test Workspace');

    const workspaces = await listWorkspacesViaIPC(page);
    expect(workspaces.some((w: any) => w.name === 'IPC Test Workspace')).toBeTruthy();
  });

  test('should create a workspace via UI and see it in the dropdown', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('ws-ui-dropdown');
    tempDirs.push(tempDir);

    await createWorkspaceViaUI(ctx, tempDir);

    const wsName = tempDir.split('/').pop();
    await expect(page.locator('[aria-label="Select workspace"]')).toContainText(wsName!, { timeout: 10000 });
  });

  test('should select a workspace and show sessions area', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('ws-select');
    tempDirs.push(tempDir);

    await createWorkspaceViaUI(ctx, tempDir);

    await expect(page.getByText('Select a workspace to view sessions')).not.toBeVisible({ timeout: 10000 });

    const newSessionBtn = page.getByRole('button', { name: /New Session/i });
    await expect(newSessionBtn).toBeVisible({ timeout: 10000 });
    await expect(newSessionBtn).toBeEnabled({ timeout: 10000 });
  });
});

test.describe('Session Management', () => {
  test('should create a session via UI button', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('session-ui');
    tempDirs.push(tempDir);

    await createWorkspaceViaUI(ctx, tempDir);
    await expect(page.getByText('Select a workspace to view sessions')).not.toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /New Session/i }).click();
    await page.waitForTimeout(2000);

    await expect(page.getByText('No active session')).not.toBeVisible({ timeout: 10000 });

    const composer = page.locator('[role="textbox"][aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });
  });

  test('should create a session via IPC and verify the response', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('session-ipc');
    tempDirs.push(tempDir);

    // Create workspace via IPC
    const workspace = await createWorkspaceViaIPC(page, 'Session IPC WS', tempDir);
    expect(workspace).toBeTruthy();
    expect(workspace.id).toBeTruthy();

    // Create session via IPC
    const session = await createSessionViaIPC(page, workspace.id, 'IPC Test Session');
    expect(session).toBeTruthy();
    expect(session.title).toBe('IPC Test Session');
    expect(session.workspaceId).toBe(workspace.id);
    expect(session.id).toBeTruthy();
  });

  test('should show composer input after selecting a session', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('session-composer');
    tempDirs.push(tempDir);

    await createWorkspaceViaUI(ctx, tempDir);

    await page.getByRole('button', { name: /New Session/i }).click();
    await page.waitForTimeout(2000);

    const composer = page.locator('[role="textbox"][aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });

    // Type into the composer
    await composer.click();
    await page.keyboard.type('Hello world');
    await page.waitForTimeout(500);

    const text = await composer.textContent();
    expect(text).toContain('Hello world');
  });

  test('should delete a workspace via IPC', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const tempDir = createTempWorkspaceDir('ws-delete');
    tempDirs.push(tempDir);

    const workspace = await createWorkspaceViaIPC(page, 'Delete Test WS', tempDir);
    expect(workspace.id).toBeTruthy();

    await deleteWorkspaceViaIPC(page, workspace.id);

    const workspaces = await listWorkspacesViaIPC(page);
    expect(workspaces.some((w: any) => w.id === workspace.id)).toBeFalsy();
  });
});
