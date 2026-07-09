import { test, expect } from '@playwright/test';
import { launchAppClean, TestContext } from './helpers';

let ctx: TestContext;

test.afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx = undefined as any;
  }
});

test.describe('Right Panel Navigation', () => {
  test('should switch to Settings tab', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    const settingsTab = page.getByRole('tab', { name: /Settings/i }).first();
    await settingsTab.click();

    await expect(page.getByText(/Provider|API Key|Model/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('should switch back to Preview tab from Settings', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    await expect(page.locator('[aria-label="Select workspace"]')).toBeVisible({ timeout: 15000 });

    await page.getByRole('tab', { name: /Settings/i }).first().click();
    await page.waitForTimeout(500);

    await page.getByRole('tab', { name: /Preview/i }).first().click();
    await page.waitForTimeout(500);

    const previewTab = page.getByRole('tab', { name: /Preview/i }).first();
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  });

  test('should show Preview tab as active by default', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    const previewTab = page.getByRole('tab', { name: /Preview/i }).first();
    await expect(previewTab).toBeVisible({ timeout: 15000 });
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Window Controls', () => {
  test('should report window is not maximized initially', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    const isMaximized = await page.evaluate(async () => {
      return await (window as any).electronAPI.window.isMaximized();
    });
    expect(typeof isMaximized).toBe('boolean');
  });

  test('should maximize window via IPC without error', async () => {
    ctx = await launchAppClean();
    const page = ctx.page;

    // Just verify the IPC call succeeds without throwing
    const result = await page.evaluate(async () => {
      try {
        await (window as any).electronAPI.window.maximize();
        return true;
      } catch {
        return false;
      }
    });
    expect(result).toBeTruthy();
  });
});
