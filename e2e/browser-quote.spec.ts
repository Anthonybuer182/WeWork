import { test, expect } from '@playwright/test';
import {
  launchAppClean,
  TestContext,
  createTempWorkspaceDir,
  cleanupDir,
  createWorkspaceViaIPC,
  createSessionViaIPC,
  listWorkspacesViaIPC,
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

/**
 * Create a workspace + session so the composer (and its QuotePreviewBar) is visible.
 */
async function setupWorkspaceAndSession(ctx: TestContext, tempDir: string): Promise<void> {
  await mockDirectoryDialog(ctx.app, tempDir);
  await ctx.page.locator('[aria-label="Create workspace"]').click();
  await ctx.page.waitForTimeout(2000);

  await expect(
    ctx.page.getByText('Select a workspace to view sessions'),
  ).not.toBeVisible({ timeout: 10000 });

  await ctx.page.getByRole('button', { name: /New Session/i }).click();
  await ctx.page.waitForTimeout(2000);

  const composer = ctx.page.locator('[role="textbox"][aria-label="Message input"]');
  await expect(composer).toBeVisible({ timeout: 10000 });
}

/**
 * Switch to the Browser tab and wait for the BrowserPreview to render.
 * Returns void — callers should use `getWebview` after this.
 */
async function switchToBrowserTab(page: import('@playwright/test').Page): Promise<void> {
  const browserTab = page.getByRole('tab', { name: /Browser/i }).first();
  await expect(browserTab).toBeVisible({ timeout: 10000 });
  await browserTab.click();

  // Verify the BrowserPreview toolbar is visible (URL input)
  await expect(page.locator('input[placeholder="Enter URL..."]')).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Get the <webview> element via evaluate (Playwright can't always locate
 * custom elements like <webview> with CSS selectors).
 */
async function getWebviewElement(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    return !!document.querySelector('webview');
  });
}

test.describe('Browser Tab', () => {
  test('should display Browser tab and webview element', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({
      timeout: 15000,
    });

    await switchToBrowserTab(page);

    // Give the webview time to mount
    await page.waitForTimeout(2000);

    const hasWebview = await getWebviewElement(page);
    expect(hasWebview).toBe(true);
  });
});

test.describe('Browser Quote Feature', () => {
  test('should show Quote button when text is selected in webview', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({
      timeout: 15000,
    });

    const tempDir = createTempWorkspaceDir('browser-quote');
    tempDirs.push(tempDir);
    await setupWorkspaceAndSession(ctx, tempDir);

    await switchToBrowserTab(page);
    await page.waitForTimeout(2000);

    // Load a simple HTML page directly via webview.loadURL
    const html = encodeURIComponent(
      '<html><body><p id="target">Hello World this is selectable text for testing</p></body></html>',
    );
    await page.evaluate(async (dataUrl) => {
      const wv = document.querySelector('webview') as any;
      if (!wv) throw new Error('webview not found');
      await wv.loadURL(dataUrl);
    }, `data:text/html,${html}`);

    await page.waitForTimeout(3000);

    // Simulate text selection
    await page.evaluate(async () => {
      const wv = document.querySelector('webview') as any;
      if (!wv) throw new Error('webview not found');
      await wv.executeJavaScript(`
        const el = document.getElementById('target');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      `);
    });

    // Wait for the Quote button (polling interval is 300ms)
    await expect(page.locator('button[title="Quote to chat"]')).toBeVisible({
      timeout: 10000,
    });

    // Click Quote (force: true to bypass toolbar overlay on small viewports)
    await page.locator('button[title="Quote to chat"]').click({ force: true });

    // Verify quote in composer
    await expect(
      page.getByText(/Hello World this is selectable text/).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('should not show Quote button when no text is selected', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({
      timeout: 15000,
    });

    const tempDir = createTempWorkspaceDir('browser-no-quote');
    tempDirs.push(tempDir);
    await setupWorkspaceAndSession(ctx, tempDir);

    await switchToBrowserTab(page);
    await page.waitForTimeout(2000);

    const html = encodeURIComponent(
      '<html><body><p id="target">Some text that will not be selected</p></body></html>',
    );
    await page.evaluate(async (dataUrl) => {
      const wv = document.querySelector('webview') as any;
      if (!wv) throw new Error('webview not found');
      await wv.loadURL(dataUrl);
    }, `data:text/html,${html}`);

    await page.waitForTimeout(3000);

    await expect(page.locator('button[title="Quote to chat"]')).not.toBeVisible({
      timeout: 5000,
    });
  });
});
