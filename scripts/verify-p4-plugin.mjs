/**
 * P4 acceptance test — the benchmark plugin (browser automation) + preview routing.
 *
 * Raw CDP over the app's debug port (19222), zero deps.
 *
 * Checks:
 *  1. Kernel discovers the browser + preview plugins (dev roots)
 *  2. Agent tools registered: browser_navigate / browser_get_state / browser_screenshot
 *  3. Tool execution end-to-end: executeTool → backend → host.browser capability → result
 *  4. Liveview panel: BrowserView target navigates + slot mounts
 *  5. Tier 0 control panel reflects live browser state (host-event push)
 *  6. Skill contribution synced into ~/.pi/agent/skills/
 *  7. filePreview routing: .md → preview plugin, .docx → host fallback
 *  8. Preview plugin renders file content via filesystem capability (real file-tree click)
 */
const CDP_HTTP = 'http://127.0.0.1:19222';
const TEST_URL = 'data:text/html,<h1>P4%20Acceptance%20Page</h1><p>browser%20plugin%20works</p>';

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

async function waitFor(session, expression, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evaluate(session, expression);
    if (v) return v;
    await sleep(350);
  }
  return null;
}

async function listTargets() {
  return (await fetch(`${CDP_HTTP}/json/list`)).json();
}

const targets = await listTargets();
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:517'));
if (!pageTarget) {
  fail('find renderer page', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

const bridge = () => evaluate(
  page,
  `window.pluginBridge ? true : false`,
);
if (!(await bridge())) {
  fail('plugin bridge available', 'window.pluginBridge missing');
  process.exit(1);
}

// ensure right panel open
await evaluate(
  page,
  `(() => {
    if (!document.querySelector('[data-testid="panel-slot"]')) {
      document.querySelector('button[title="Expand right panel"]')?.click();
    }
    return true;
  })()`,
);
await sleep(400);

// ── 1 · Plugins discovered ──
const plugins = await evaluate(page, `window.pluginBridge.list()`);
const browserPlugin = plugins?.find((p) => p.id === 'com.pi.browser');
const previewPlugin = plugins?.find((p) => p.id === 'com.pi.preview');
browserPlugin && previewPlugin
  ? ok(`browser + preview plugins discovered (${plugins.length} enabled plugins total)`)
  : fail('plugin discovery', JSON.stringify(plugins?.map((p) => p.id)));

// ── 2 · Agent tools registered ──
const tools = await evaluate(page, `window.pluginBridge.listTools()`);
const toolNames = (tools ?? []).map((t) => t.name);
const expectedTools = ['browser_navigate', 'browser_get_state', 'browser_screenshot'];
expectedTools.every((t) => toolNames.includes(t))
  ? ok(`agent tools registered via customTools (${toolNames.join(', ')})`)
  : fail('agent tools registered', toolNames.join(', '));

// ── 3 · Tool execution end-to-end ──
const navResult = await evaluate(
  page,
  `window.pluginBridge.executeTool('com.pi.browser', 'browser_navigate', { url: ${JSON.stringify(TEST_URL)} })`,
);
const navText = navResult?.content?.[0]?.text ?? '';
navResult?.ok && navText.includes('P4')
  ? ok(`tool execution: browser_navigate → backend → host.browser.navigate → ${navText.replace(/\n/g, ' ').slice(0, 60)}`)
  : fail('tool execution browser_navigate', JSON.stringify(navResult).slice(0, 200));

const stateResult = await evaluate(
  page,
  `window.pluginBridge.executeTool('com.pi.browser', 'browser_get_state', {})`,
);
stateResult?.ok && (stateResult?.content?.[0]?.text ?? '').includes('data:text/html')
  ? ok('tool execution: browser_get_state reflects the navigated page')
  : fail('tool execution browser_get_state', JSON.stringify(stateResult).slice(0, 200));

const shot = await evaluate(
  page,
  `window.pluginBridge.executeTool('com.pi.browser', 'browser_screenshot', {})`,
);
shot?.ok && typeof shot?.content?.[0]?.data === 'string' && shot.content[0].data.length > 1000
  ? ok(`tool execution: browser_screenshot returns image (${Math.round(shot.content[0].data.length / 1024)}KB base64)`)
  : fail('tool execution browser_screenshot', JSON.stringify(shot).slice(0, 150));

// ── 4 · Liveview panel: BrowserView navigated + slot mounted ──
const previewRail = `[data-panel-id="plugin:com.pi.browser:preview"]`;
const railHasPreview = await waitFor(page, `!!document.querySelector('${previewRail}')`);
railHasPreview ? ok('liveview preview panel contributed to rail') : fail('liveview rail entry', 'not found');

await evaluate(page, `document.querySelector('${previewRail}')?.click(); true`);
const slotMounted = await waitFor(page, `!!document.querySelector('[data-liveview-slot="com.pi.browser:preview"]')`);
slotMounted ? ok('liveview slot mounts on panel open') : fail('liveview slot', 'slot element missing');

// The BrowserView target should now exist and hold the navigated URL
let browserTarget = null;
for (let i = 0; i < 20 && !browserTarget; i++) {
  const t = (await listTargets()).find((x) => x.url.startsWith('data:text/html'));
  if (t) browserTarget = t;
  else await sleep(400);
}
browserTarget
  ? ok('BrowserView target alive and serving the navigated data: URL (hosted by the liveview slot)')
  : fail('BrowserView target', 'no data: URL target found');

// ── 5 · Tier 0 control panel reflects live state ──
const controlRail = `[data-panel-id="plugin:com.pi.browser:control"]`;
await evaluate(page, `document.querySelector('${controlRail}')?.click(); true`);
const controlReady = await waitFor(
  page,
  `(() => {
    const el = document.querySelector('[data-panel-kind="declarative"]');
    return el && el.textContent.includes('data:text/html') ? true : false;
  })()`,
);
controlReady
  ? ok('control panel (Tier 0) shows the live browser state — host-event + capability chain')
  : fail('control panel state', 'current URL not shown');

// ── 6 · Skill contribution synced ──
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const skillPath = join(homedir(), '.pi/agent/skills/com.pi.browser/browser-native/SKILL.md');
existsSync(skillPath)
  ? ok('skill contribution synced to ~/.pi/agent/skills/com.pi.browser/')
  : fail('skill sync', skillPath + ' missing');

// ── 7 · filePreview routing ──
const mdRoute = await evaluate(page, `window.pluginBridge.findPreview('/tmp/p4-test.md')`);
const docxRoute = await evaluate(page, `window.pluginBridge.findPreview('/tmp/p4-test.docx')`);
const pdfRoute = await evaluate(page, `window.pluginBridge.findPreview('/tmp/p4-test.pdf')`);
mdRoute?.panelId === 'plugin:com.pi.preview:preview' && docxRoute?.panelId === 'plugin:com.pi.preview:preview' && pdfRoute?.panelId === null
  ? ok('filePreview routing: .md/.docx → preview plugin (P5 office), unclaimed .pdf → host fallback')
  : fail('filePreview routing', JSON.stringify({ mdRoute, docxRoute, pdfRoute }));

// ── 8 · Preview plugin end-to-end (real file-tree click) ──
const WORKSPACE = '/Users/simba/Desktop/Test';
const TEST_FILE = `${WORKSPACE}/pi-p4-verify.md`;
const FILE_MARKER = `P4-预览验收-${Date.now()}`;
import { writeFileSync, rmSync } from 'node:fs';
writeFileSync(TEST_FILE, `# P4 验收\n\n${FILE_MARKER}\n\n这是文本预览插件渲染的内容。\n`);

try {
  // Reload the page so the file tree (react-query cache) picks up the new file.
  await evaluate(page, `location.reload(); true`);
  await sleep(4000);
  // Re-ensure the right panel after reload.
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

  const clicked = await evaluate(
    page,
    `(() => {
      const candidates = [...document.querySelectorAll('*')].filter(el =>
        el.children.length === 0 && el.textContent?.trim() === 'pi-p4-verify.md'
      );
      candidates[candidates.length - 1]?.click();
      return candidates.length;
    })()`,
  );
  const previewOpened = await waitFor(
    page,
    `(() => {
      const chrome = document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title');
      const el = document.querySelector('[data-panel-kind="declarative"]');
      return chrome === '文件预览' && el && el.textContent.includes(${JSON.stringify(FILE_MARKER)}) ? true : false;
    })()`,
    20_000,
  );
  previewOpened
    ? ok('preview plugin: file-tree click → routing → declarative render with file content (filesystem capability)')
    : fail('preview plugin e2e', `tree candidates=${clicked}`);
} finally {
  rmSync(TEST_FILE, { force: true });
}

page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
