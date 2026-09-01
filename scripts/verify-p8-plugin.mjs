/**
 * P8 acceptance test — production hardening: CSP + iframe autoHeight + context menu.
 *
 * Raw CDP over the app's debug port (19222), zero deps.
 * Works in both dev (http://localhost:517x) and prod (file://) renderers —
 * the page finder accepts either, and CSP expectations branch on protocol.
 *
 * Checks:
 *  1. CSP meta injected: frame-src pi-plugin: present; prod has no unsafe-inline
 *     in script-src; dev keeps localhost connect-src
 *  2. Plugin kernel alive in this mode (hello plugin listed)
 *  3. autoHeight: hello iframe mounts with data-auto-height, style.height syncs
 *     to the SDK-reported content height
 *  4. autoHeight dynamic: growing the panel content re-reports (ResizeObserver)
 *  5. Context menu bridge: pluginBridge.showContextMenu → { ok: true }
 *  6. pi-plugin:// iframe reachable via CDP with window.piSDK
 */
const CDP_HTTP = 'http://127.0.0.1:19222';

const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    ws.onerror = () => reject(new Error('ws error: ' + wsUrl));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(session, expression, timeoutMs = 15_000, interval = 350) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evaluate(session, expression);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pageTarget = targets.find(
  (t) => t.type === 'page' && (t.url.includes('localhost:517') || t.url.startsWith('file:')),
);
if (!pageTarget) {
  fail('find renderer page', JSON.stringify(targets.map((t) => t.url)));
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

const isProd = pageTarget.url.startsWith('file:');
console.log(`mode: ${isProd ? 'PRODUCTION (file://)' : 'DEV (vite)'}`);

// ── 1 · CSP meta ──
const csp = await evaluate(
  page,
  `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null`,
);
if (!csp) {
  fail('CSP meta injected', 'no meta[http-equiv="Content-Security-Policy"] in <head>');
} else {
  const hasFrame = csp.includes('frame-src pi-plugin:');
  hasFrame
    ? ok(`CSP meta 已注入且允许 frame-src pi-plugin:(${isProd ? 'prod' : 'dev'} 策略)`)
    : fail('CSP frame-src', csp);
  if (isProd) {
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
    !scriptSrc.includes('unsafe-inline')
      ? ok('CSP 生产策略: script-src 不含 unsafe-inline')
      : fail('CSP prod script-src', scriptSrc);
  } else {
    csp.includes('connect-src') && csp.includes('localhost')
      ? ok('CSP 开发策略: connect-src 保留 localhost(HMR)')
      : fail('CSP dev connect-src', csp);
  }
}

// ── 2 · Plugin kernel alive ──
const plugins = await evaluate(page, `window.pluginBridge.list()`);
const hello = (plugins ?? []).find((p) => p.id === 'com.pi.hello');
hello
  ? ok(`插件内核可用: hello v${hello.version} 已注册(${plugins.length} 个插件)`)
  : fail('plugin kernel', JSON.stringify((plugins ?? []).map((p) => p.id)));

// ── 3 · autoHeight: mount + initial sync ──
// ensure right panel is open, then open the hello panel
await evaluate(
  page,
  `(() => {
    if (!document.querySelector('[data-testid="panel-slot"]')) {
      document.querySelector('button[title="Expand right panel"]')?.click();
    }
    return true;
  })()`,
);
await sleep(600);
await evaluate(page, `document.querySelector('[data-panel-id="plugin:com.pi.hello:hello"]')?.click(); true`);
await sleep(1500);

const heightState = await waitFor(
  page,
  `(() => {
    const el = document.querySelector('iframe[data-auto-height="true"]');
    if (!el) return null;
    const h = parseFloat(el.style.height || '');
    if (!Number.isFinite(h) || h <= 0) return null;
    return { applied: h, initial: el.style.height };
  })()`,
);
if (!heightState) {
  fail('autoHeight mount', 'iframe[data-auto-height] has no style.height');
} else {
  // Cross-check against the live content height inside the plugin iframe.
  const pluginTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) =>
    t.url.startsWith('pi-plugin://com.pi.hello'),
  );
  if (pluginTarget) {
    const plugin = await connect(pluginTarget.webSocketDebuggerUrl);
    await plugin.send('Runtime.enable', {});
    const content = await evaluate(
      plugin,
      `(() => {
        if (!window.piSDK) return null;
        // Same viewport-independent formula the SDK reports with.
        var rootBox = document.documentElement.getBoundingClientRect().height || 0;
        return Math.ceil(Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight || 0,
          rootBox,
        ));
      })()`,
    );
    content !== null && Math.abs(content - heightState.applied) <= 4
      ? ok(`autoHeight 同步: iframe 高度 ${heightState.applied}px = 内容实际高度 ${content}px`)
      : fail('autoHeight sync', `applied=${heightState.applied} content=${content}`);
    plugin.close();
  } else {
    fail('autoHeight sync', 'pi-plugin://com.pi.hello CDP target not found');
  }
}

// ── 4 · autoHeight dynamic re-report ──
{
  const pluginTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) =>
    t.url.startsWith('pi-plugin://com.pi.hello'),
  );
  if (pluginTarget) {
    const plugin = await connect(pluginTarget.webSocketDebuggerUrl);
    await plugin.send('Runtime.enable', {});
    // Idempotent: clear any probe from a previous run, settle, then grow.
    await evaluate(plugin, `document.getElementById('p8-grow')?.remove(); true`);
    await sleep(600);
    const baseline = await evaluate(
      page,
      `parseFloat(document.querySelector('iframe[data-auto-height="true"]')?.style.height || '0') || 0`,
    );
    // Grow the content by ~400px; ResizeObserver should re-report and the
    // host should resize the iframe accordingly.
    await evaluate(
      plugin,
      `(() => {
        const d = document.createElement('div');
        d.id = 'p8-grow';
        d.style.height = '400px';
        d.textContent = 'P8 height growth probe';
        document.body.appendChild(d);
        return true;
      })()`,
    );
    const grown = await waitFor(
      page,
      `(() => {
        const el = document.querySelector('iframe[data-auto-height="true"]');
        if (!el) return null;
        const h = parseFloat(el.style.height || '');
        return Number.isFinite(h) && h > ${baseline} + 350 ? h : null;
      })()`,
      10_000,
    );
    grown
      ? ok(`autoHeight 动态重报: 基线 ${baseline}px → 增高后 ${grown}px(ResizeObserver 生效)`)
      : fail('autoHeight dynamic', `baseline=${baseline} height did not grow`);
    // Shrink back: removing the probe must lower the height again.
    await evaluate(plugin, `document.getElementById('p8-grow')?.remove(); true`);
    const shrunk = await waitFor(
      page,
      `parseFloat(document.querySelector('iframe[data-auto-height="true"]')?.style.height || '0') <= ${baseline} + 50`,
      10_000,
    );
    shrunk
      ? ok(`autoHeight 回缩: 删除内容后高度回落到 ≤ 基线+50px(非单向钉死)`)
      : fail('autoHeight shrink', 'height did not shrink after content removal');
    plugin.close();
  } else {
    fail('autoHeight dynamic', 'pi-plugin://com.pi.hello CDP target not found');
  }
}

// ── 5 · Context menu bridge ──
const menuRes = await evaluate(
  page,
  `window.pluginBridge.showContextMenu({ x: 300, y: 300 })`,
);
menuRes?.ok === true
  ? ok('右键菜单桥: pluginBridge.showContextMenu → 主进程原生菜单(ok)')
  : fail('context menu bridge', JSON.stringify(menuRes));

// ── 6 · pi-plugin iframe sanity (SDK live in unique origin) ──
{
  const pluginTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) =>
    t.url.startsWith('pi-plugin://com.pi.hello'),
  );
  if (pluginTarget) {
    const plugin = await connect(pluginTarget.webSocketDebuggerUrl);
    await plugin.send('Runtime.enable', {});
    const sdk = await evaluate(
      plugin,
      `(() => ({
        hasSdk: !!window.piSDK,
        pluginId: window.piSDK?.pluginId ?? null,
        origin: location.origin,
        ping: typeof window.piSDK?.request === 'function',
      }))()`,
    );
    sdk?.hasSdk && sdk.pluginId === 'com.pi.hello' && sdk.origin === 'pi-plugin://com.pi.hello'
      ? ok(`pi-plugin:// 独立源可用: origin=${sdk.origin}, piSDK 就绪`)
      : fail('pi-plugin origin', JSON.stringify(sdk));
    const pong = await evaluate(plugin, `window.piSDK.request('ping', { t: Date.now() })`);
    pong && typeof pong === 'object'
      ? ok(`数据面往返: piSDK.request('ping') → ${JSON.stringify(pong).slice(0, 60)}`)
      : fail('sdk round-trip', JSON.stringify(pong));
    plugin.close();
  } else {
    fail('pi-plugin origin', 'hello iframe target not found');
  }
}

// ── prod-mode summary expectations ──
if (isProd) {
  console.log('(prod 模式运行:file:// renderer + pi-plugin:// 协议均已验证)');
}

page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
