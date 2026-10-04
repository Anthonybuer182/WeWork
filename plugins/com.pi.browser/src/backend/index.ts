/**
 * com.pi.browser backend — agent tools over the host's embedded browser, plus
 * the panel that hosts it.
 *
 * Tools: browser_navigate / browser_get_state / browser_find / browser_click /
 * browser_fill / browser_hover / browser_select / browser_scroll /
 * browser_evaluate / browser_walk / browser_screenshot.
 *
 * The panel (address bar toolbar) is this plugin's own page; the page binds the
 * host's engine view into its layout via piSDK.liveSlot. The engine view and
 * its persisted session stay host-owned — this plugin only positions it and
 * drives it through browser.* capability calls.
 */
import { plugin } from '@pi/plugin-sdk';

/**
 * Loading a page waits on the outside world. The SDK's 30s default is right for
 * a storage read and too short for a slow site, so navigation gets its own.
 */
const NAVIGATE_TIMEOUT_MS = 60_000;

/**
 * The element snapshot is the agent's eyes on the page, but a busy SPA can
 * produce hundreds of elements. Truncate rather than flood the context —
 * browser_find is the precise instrument for anything cut off.
 */
const SNAPSHOT_MAX_CHARS = 8_000;

/** Panels currently mounted (backend → UI pushes go to all of them). */
const mountedPanels = new Set<string>();
/** Last URL the host reported — pushed to freshly mounted panels. */
let lastUrl = '';

/** The engine reports failures as `{ error }` instead of throwing; surface them. */
function actionResult(prefix: string, r: { error?: string }, extra = ''): string {
  return r.error ? `${prefix}失败: ${r.error}` : `${prefix}成功${extra}`;
}

function normalizeUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('missing url');
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

plugin({
  async onInit(ctx) {
    // Seed from the engine so a panel mounted before the first host event
    // still shows the right address.
    try {
      const state = await ctx.call<{ url?: string }>('browser.getUrl');
      if (state?.url) lastUrl = state.url;
    } catch {
      /* engine not connected yet — the host event will fill it in */
    }
  },

  async onPanelMounted(panelId, _params, ctx) {
    mountedPanels.add(panelId);
    // Ask the engine rather than trusting the cached URL — the panel may have
    // been closed while agent tools navigated elsewhere.
    try {
      const state = await ctx.call<{ url?: string }>('browser.getUrl');
      if (state?.url) lastUrl = state.url;
    } catch {
      /* engine unreachable — fall back to whatever we last heard */
    }
    if (lastUrl) ctx.send(panelId, 'ui.urlChanged', { url: lastUrl });
  },

  async onRequest(panelId, method, params, ctx) {
    void panelId;
    // Panel methods follow the `domain.verb` convention the other plugins use;
    // `state.get` is the shared boot pull.
    switch (method) {
      case 'nav.open': {
        const result = await ctx.call<{ url?: string; title?: string }>(
          'browser.navigate',
          { url: normalizeUrl(params.url) },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        if (result?.url) lastUrl = result.url;
        return { url: result?.url ?? '', title: result?.title ?? '' };
      }
      case 'nav.back':
        await ctx.call('browser.back');
        return { ok: true };
      case 'nav.forward':
        await ctx.call('browser.forward');
        return { ok: true };
      case 'nav.reload':
        await ctx.call('browser.reload');
        return { ok: true };
      case 'state.get': {
        const state = await ctx.call<{ url?: string; title?: string }>('browser.getUrl');
        if (state?.url) lastUrl = state.url;
        return { url: state?.url ?? '', title: state?.title ?? '' };
      }
      default:
        throw new Error(
          `unknown panel method: ${method} (known: nav.open, nav.back, nav.forward, nav.reload, state.get)`,
        );
    }
  },

  async onHostEvent(event, data, ctx) {
    if (event !== 'browser.urlChanged') return;
    lastUrl = String((data as { url?: string })?.url ?? '');
    for (const panelId of mountedPanels) {
      ctx.send(panelId, 'ui.urlChanged', { url: lastUrl });
    }
  },

  async onTool(name, params, ctx) {
    // The agent is driving the shared engine — surface the panel, so the user
    // watches the page the agent works on instead of a silent background
    // browser. Page-changing tools reveal the column (focus=true); in-page
    // operations only badge a hidden panel (no-focus-steal: the page is either
    // already on screen or a rail dot says enough).
    const reveal = name === 'browser_navigate' || name === 'browser_walk' || name === 'browser_screenshot';
    void ctx.openPanel('browser', { focus: reveal }).catch(() => {});
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
        const state = await ctx.call<{
          url?: string;
          title?: string;
          snapshot?: string;
        }>('browser.getState');
        const lines = [
          `当前页面: ${state?.url ?? '(about:blank)'}${state?.title ? ` — ${state.title}` : ''}`,
        ];
        if (state?.snapshot) {
          const snap =
            state.snapshot.length > SNAPSHOT_MAX_CHARS
              ? `${state.snapshot.slice(0, SNAPSHOT_MAX_CHARS)}\n…(快照已截断,要找具体元素用 browser_find)`
              : state.snapshot;
          lines.push('', '可交互元素(引用 ref 可直接传给 browser_click / browser_fill):', snap);
        }
        return lines.join('\n');
      }

      case 'browser_find': {
        const query = String(params.query ?? '').trim();
        if (!query) throw new Error('missing query');
        const matches = await ctx.call<
          Array<{ score: number; role: string; text: string; section: string }>
        >('browser.find', { query });
        if (matches.length === 0) return `页面上没有匹配 "${query}" 的元素`;
        return matches
          .map((m) => `[${m.role}] "${m.text}" (${m.section}, 匹配度 ${m.score})`)
          .join('\n');
      }

      case 'browser_click': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ clicked: boolean; error?: string }>('browser.click', {
          selector,
        });
        return actionResult(`点击 "${selector}"`, r);
      }

      case 'browser_fill': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ error?: string }>('browser.fill', {
          selector,
          value: String(params.value ?? ''),
        });
        return actionResult(`填写 "${selector}"`, r);
      }

      case 'browser_hover': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ hovered: boolean; error?: string }>('browser.hover', {
          selector,
        });
        return actionResult(`悬停 "${selector}"`, r);
      }

      case 'browser_select': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ selected: boolean; error?: string }>('browser.select', {
          selector,
          value: String(params.value ?? ''),
        });
        return actionResult(`在 "${selector}" 选中 "${params.value}"`, r);
      }

      case 'browser_scroll': {
        const r = await ctx.call<{ direction: string; amount: number }>('browser.scroll', {
          direction: params.direction,
          amount: params.amount,
        });
        return `已${r.direction === 'up' ? '向上' : '向下'}滚动 ${r.amount}px`;
      }

      case 'browser_evaluate': {
        const expression = String(params.expression ?? '');
        if (!expression.trim()) throw new Error('missing expression');
        const r = await ctx.call<{ result: unknown }>('browser.evaluate', { expression });
        return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      }

      case 'browser_walk': {
        const goal = String(params.goal ?? '').trim();
        if (!goal) throw new Error('missing goal');
        const r = await ctx.call<{
          goal: string;
          url?: string;
          title?: string;
          reached: boolean;
          steps: Array<{ text: string; ok?: boolean }>;
        }>(
          'browser.walk',
          { goal, maxSteps: params.maxSteps },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        const stepLines = r.steps.map((s, i) => `${i + 1}. 点击 "${s.text}"${s.ok === false ? ' ✗' : ''}`);
        const head = r.reached ? `已到达目标 "${goal}"` : `未能到达目标 "${goal}"`;
        return [head, `当前: ${r.url ?? '?'}`, ...stepLines].join('\n');
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
