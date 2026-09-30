/**
 * com.pi.browser backend — agent tools over the host's embedded browser.
 *
 * Tools: browser_navigate / browser_get_state / browser_screenshot.
 *
 * There are no panels here. The browser UI (address bar + the live page) is a
 * host panel, because the view it shows is the host's own — the very same
 * WebContentsView these tools drive. A plugin panel is a page the plugin
 * provides; this is the opposite, so it does not belong to a plugin.
 */
import { plugin } from '@pi/plugin-sdk';

/**
 * Loading a page waits on the outside world. The SDK's 30s default is right for
 * a storage read and too short for a slow site, so navigation gets its own.
 */
const NAVIGATE_TIMEOUT_MS = 60_000;

function normalizeUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('missing url');
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

plugin({
  async onTool(name, params, ctx) {
    switch (name) {
      case 'browser_navigate': {
        const url = normalizeUrl(params.url);
        const result = await ctx.call<{ url?: string; title?: string }>(
          'browser.navigate',
          { url },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        const finalUrl = result?.url ?? url;
        return `已打开 ${finalUrl}${result?.title ? ` — ${result.title}` : ''}`;
      }

      case 'browser_get_state': {
        const state = await ctx.call<{ url?: string; title?: string }>('browser.getState');
        return `当前页面: ${state?.url ?? '(about:blank)'}${state?.title ? ` — ${state.title}` : ''}`;
      }

      case 'browser_screenshot': {
        const shot = await ctx.call<{ base64?: string }>('browser.screenshot', {
          fullPage: params.fullPage === true,
        });
        if (!shot?.base64) throw new Error('screenshot failed: the host returned no image data');
        const kb = Math.round((shot.base64.length * 3) / 4 / 1024);
        return {
          content: [
            { type: 'text', text: `截图完成 (${kb} KB PNG)` },
            { type: 'image', data: shot.base64, mimeType: 'image/png' },
          ],
        };
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
});
