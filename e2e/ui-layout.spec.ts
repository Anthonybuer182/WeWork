import { test, expect } from '@playwright/test';
import { launchApp, launchAppClean, TestContext } from './helpers';

let ctx: TestContext;

test.afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx = undefined as any;
  }
});

test.describe('UI Layout Structure', () => {
  test('should display the three-column layout', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    const workspaceTrigger = page.locator('[aria-label="Select workspace"]');
    await expect(workspaceTrigger).toBeVisible({ timeout: 15000 });

    const createWsBtn = page.locator('[aria-label="Create workspace"]');
    await expect(createWsBtn).toBeVisible();

    await expect(page.getByRole('tab', { name: /Preview/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Settings/i })).toBeVisible();
  });

  test('should show "Select workspace..." placeholder in dropdown', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    const workspaceTrigger = page.locator('[aria-label="Select workspace"]');
    await expect(workspaceTrigger).toBeVisible({ timeout: 15000 });

    const triggerText = await workspaceTrigger.textContent();
    expect(triggerText).toMatch(/Select workspace/i);
  });

  test('should show "Select a workspace to view sessions" in session list', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.getByText('Select a workspace to view sessions')).toBeVisible({ timeout: 15000 });
  });

  test('should show "No active session" in chat area', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.getByText('No active session')).toBeVisible({ timeout: 15000 });
  });

  test('should not show "New Session" button when no workspace is selected', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.getByText('Select a workspace to view sessions')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /New Session/i })).not.toBeVisible();
  });

  test('should not render composer input when no session is active', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[role="textbox"][aria-label="Message input"]')).not.toBeVisible({ timeout: 10000 });
  });

  test('should have the right panel visible by default', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    const previewTab = page.getByRole('tab', { name: /Preview/i }).first();
    await expect(previewTab).toBeVisible({ timeout: 15000 });
  });
});
