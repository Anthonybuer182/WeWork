import { test, expect } from '@playwright/test';
import { launchApp, TestContext } from './helpers';

let ctx: TestContext;

test.afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx = undefined as any;
  }
});

test.describe('App Launch', () => {
  test('should launch and show a window', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    // Window should be visible
    expect(await page.isVisible('body')).toBeTruthy();
  });

  test('should have correct window title', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    await expect(page).toHaveTitle(/Pi Coding Agent/i);
  });

  test('should have the electronAPI exposed in the renderer', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    const hasAPI = await page.evaluate(() => {
      return !!(window as any).electronAPI;
    });
    expect(hasAPI).toBeTruthy();
  });

  test('should return app version via IPC', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    const version = await page.evaluate(async () => {
      return await (window as any).electronAPI.app.getVersion();
    });
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');
  });

  test('should return home path via IPC', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    const homePath = await page.evaluate(async () => {
      return await (window as any).electronAPI.app.getPath('home');
    });
    expect(homePath).toBeTruthy();
    expect(typeof homePath).toBe('string');
    expect(homePath.length).toBeGreaterThan(0);
  });

  test('should have clipboard read/write working via IPC', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    await page.evaluate(async () => {
      await (window as any).electronAPI.clipboard.write('test-clipboard-value');
    });

    const text = await page.evaluate(async () => {
      return await (window as any).electronAPI.clipboard.read();
    });
    expect(text).toBe('test-clipboard-value');
  });

  test('should have fs.mkdir/exists/listDir working via IPC', async () => {
    ctx = await launchApp();
    const page = ctx.page;

    const testDir = `/tmp/pi-e2e-fs-test-${Date.now()}`;

    // mkdir
    await page.evaluate(async (dir) => {
      await (window as any).electronAPI.fs.mkdir(dir);
    }, testDir);

    // exists
    const exists = await page.evaluate(async (dir) => {
      return await (window as any).electronAPI.fs.exists(dir);
    }, testDir);
    expect(exists).toBeTruthy();

    // writeFile
    await page.evaluate(async (dir) => {
      await (window as any).electronAPI.fs.writeFile(`${dir}/test.txt`, 'hello world');
    }, testDir);

    // readFile
    const fileContent = await page.evaluate(async (dir) => {
      const result = await (window as any).electronAPI.fs.readFile(`${dir}/test.txt`);
      return result.content;
    }, testDir);
    expect(fileContent).toBe('hello world');

    // listDir
    const entries = await page.evaluate(async (dir) => {
      return await (window as any).electronAPI.fs.listDir(dir);
    }, testDir);
    expect(Array.isArray(entries)).toBeTruthy();
    expect(entries.some((e: any) => e.name === 'test.txt')).toBeTruthy();

    // cleanup
    await page.evaluate(async (dir) => {
      await (window as any).electronAPI.fs.delete(dir);
    }, testDir);
  });
});
