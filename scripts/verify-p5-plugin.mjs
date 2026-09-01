/**
 * P5 acceptance test — the official plugin matrix.
 *
 * Checks:
 *  1. All 8 dev plugins discovered and active
 *  2. 12 agent tools registered across the matrix
 *  3. Agent tools work end-to-end (kb / erp / mail / calendar / todo)
 *  4. Rail badge linkage (tool activity → badge on hidden panel)
 *  5. Tier 0 panel interaction (todo add via panel input)
 *  6. Storage persistence across the matrix
 *  7. All five Tier 0 panels render
 *  8. Office preview routing (docx → plugin panel with extracted text)
 *  9. Connector scaffold template present
 */
const CDP_HTTP = 'http://127.0.0.1:19222';
const MARKER = `P5-${Date.now()}`;

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

async function waitFor(session, expression, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evaluate(session, expression);
    if (v) return v;
    await sleep(350);
  }
  return null;
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:517'));
if (!pageTarget) {
  fail('find renderer page', '');
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

await evaluate(
  page,
  `(() => {
    if (!document.querySelector('[data-testid="panel-slot"]')) {
      // 右栏默认收起 — 点插件中心图标展开(人为打开语义)
      document.querySelector('[data-panel-id="host:plugins"]')?.click();
    }
    return true;
  })()`,
);
await sleep(400);

// ── 1 · All official plugins discovered ──
const plugins = await evaluate(page, `window.pluginBridge.list()`);
const expected = [
  'com.pi.hello', 'com.pi.browser', 'com.pi.preview',
  'com.pi.todo', 'com.pi.mail', 'com.pi.calendar', 'com.pi.knowledge', 'com.pi.erp-demo',
];
const found = plugins?.map((p) => p.id) ?? [];
const allActive = expected.every((id) => plugins?.find((p) => p.id === id && p.state === 'active'));
expected.every((id) => found.includes(id)) && allActive
  ? ok(`official matrix discovered — 8 plugins all active (${found.length} total)`)
  : fail('official matrix discovered', JSON.stringify(plugins?.map((p) => `${p.id}:${p.state}`)));

// ── 2 · Agent tools registered ──
const tools = await evaluate(page, `window.pluginBridge.listTools()`);
const toolNames = (tools ?? []).map((t) => t.name);
const expectedTools = [
  'todo_add', 'todo_list', 'todo_done',
  'mail_create_draft', 'mail_list_drafts',
  'calendar_add_event', 'calendar_list_upcoming',
  'kb_save', 'kb_search', 'kb_list',
  'erp_query_orders',
  'browser_navigate', 'browser_get_state', 'browser_screenshot',
];
expectedTools.every((t) => toolNames.includes(t))
  ? ok(`agent tools registered (${toolNames.length} total across the matrix)`)
  : fail('agent tools registered', toolNames.join(', '));

const runTool = (pluginId, name, params) =>
  evaluate(page, `window.pluginBridge.executeTool(${JSON.stringify(pluginId)}, ${JSON.stringify(name)}, ${JSON.stringify(params)})`);
const toolText = (r) => r?.content?.[0]?.text ?? '';

// ── 3 · Tool execution across the matrix ──
const kbSave = await runTool('com.pi.knowledge', 'kb_save', { title: `${MARKER}-知识`, content: `P5 知识库验收内容,标记 ${MARKER}` });
toolText(kbSave).includes('已保存') ? ok('kb_save tool') : fail('kb_save tool', JSON.stringify(kbSave).slice(0, 120));

const kbSearch = await runTool('com.pi.knowledge', 'kb_search', { query: MARKER });
toolText(kbSearch).includes(MARKER) ? ok('kb_search tool returns saved entry') : fail('kb_search tool', toolText(kbSearch).slice(0, 120));

const erp = await runTool('com.pi.erp-demo', 'erp_query_orders', { status: 'pending' });
toolText(erp).includes('SO-2026-0042') && !toolText(erp).includes('SO-2026-0039')
  ? ok('erp_query_orders tool with status filter (connector pattern)')
  : fail('erp_query_orders tool', toolText(erp).slice(0, 150));

const mail = await runTool('com.pi.mail', 'mail_create_draft', { to: 'p5@example.com', subject: `${MARKER} 草稿`, body: 'P5 验收正文' });
toolText(mail).includes('草稿已创建') ? ok('mail_create_draft tool') : fail('mail_create_draft tool', toolText(mail).slice(0, 120));

const cal = await runTool('com.pi.calendar', 'calendar_add_event', { title: `${MARKER} 会议`, time: '明天 14:00' });
toolText(cal).includes('日程已添加') ? ok('calendar_add_event tool') : fail('calendar_add_event tool', toolText(cal).slice(0, 120));

const todo = await runTool('com.pi.todo', 'todo_add', { title: `${MARKER} 任务` });
toolText(todo).includes('已添加待办') ? ok('todo_add tool') : fail('todo_add tool', toolText(todo).slice(0, 120));

// ── 4 · Badge linkage (tool activity → rail badge, panel hidden) ──
await evaluate(page, `document.querySelector('[data-panel-id="host:settings"]')?.click(); true`);
const badge = await waitFor(
  page,
  `(() => {
    const b = document.querySelector('[data-panel-id="plugin:com.pi.todo:tasks"] [data-panel-badge]');
    return b && b.textContent.trim().length > 0 ? b.textContent.trim() : null;
  })()`,
  15_000,
);
badge
  ? ok(`rail badge linkage: agent todo_add → badge on hidden todo panel (${badge})`)
  : fail('rail badge linkage', 'no badge on todo rail button');

// ── 5 · Tier 0 panel interaction (todo add via panel input) ──
await evaluate(page, `document.querySelector('[data-panel-id="plugin:com.pi.todo:tasks"]')?.click(); true`);
const todoPanelReady = await waitFor(
  page,
  `(() => document.querySelector('[data-panel-kind="declarative"]')?.textContent.includes('待办(') ?? false)()`,
);
todoPanelReady ? ok('todo Tier 0 panel renders') : fail('todo panel renders', 'not found');

await evaluate(
  page,
  `(() => {
    const input = document.querySelector('[data-panel-kind="declarative"] input[placeholder^="新任务"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(`${MARKER} 面板任务`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`,
);
const panelTaskAdded = await waitFor(
  page,
  `(() => document.querySelector('[data-panel-kind="declarative"]')?.textContent.includes(${JSON.stringify(`${MARKER} 面板任务`)}) ?? false)()`,
);
panelTaskAdded ? ok('todo panel interaction: input → list update (event loopback)') : fail('todo panel interaction', 'task not in list');

// ── 6 · Storage persistence ──
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const dataRoot = join(homedir(), '.pi/agent/plugins-data');
const checks = [
  ['com.pi.todo', `${MARKER} 任务`],
  ['com.pi.mail', `${MARKER} 草稿`],
  ['com.pi.calendar', `${MARKER} 会议`],
  ['com.pi.knowledge', `${MARKER}-知识`],
];
let persisted = 0;
for (const [id, marker] of checks) {
  try {
    const storage = JSON.parse(readFileSync(join(dataRoot, id, 'storage.json'), 'utf-8'));
    if (JSON.stringify(storage).includes(marker)) persisted++;
    else fail(`storage persistence ${id}`, 'marker missing');
  } catch (err) {
    fail(`storage persistence ${id}`, String(err));
  }
}
persisted === checks.length && ok(`storage persistence across the matrix (todo/mail/calendar/knowledge → plugins-data/)`);

// ── 7 · All five Tier 0 panels render ──
const panelChecks = [
  ['plugin:com.pi.mail:drafts', '写邮件'],
  ['plugin:com.pi.calendar:events', '新日程'],
  ['plugin:com.pi.knowledge:kb', '知识库'],
  ['plugin:com.pi.erp-demo:orders', '订单'],
  ['plugin:com.pi.todo:tasks', '待办'],
];
for (const [panelId, expectText] of panelChecks) {
  await evaluate(page, `document.querySelector('[data-panel-id="${panelId}"]')?.click(); true`);
  const ready = await waitFor(
    page,
    `(() => document.querySelector('[data-panel-kind="declarative"]')?.textContent.includes(${JSON.stringify(expectText)}) ?? false)()`,
    12_000,
  );
  ready ? ok(`Tier 0 panel renders: ${panelId}`) : fail('Tier 0 panel renders', panelId);
}

// ── 8 · Office preview routing (docx → plugin panel with extracted text) ──
const WORKSPACE = '/Users/simba/Desktop/Test';
const DOCX_FILE = `${WORKSPACE}/pi-p5-verify.docx`;
const DOCX_MARKER = `P5-Office验收-${Date.now()}`;
{
  // Build a minimal valid docx (zip with word/document.xml).
  const require = (await import('node:module')).createRequire(
    new URL('../apps/desktop/package.json', import.meta.url),
  );
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        `<w:p><w:r><w:t>${DOCX_MARKER}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>docx 文本提取验收</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    ),
  );
  zip.writeZip(DOCX_FILE);
}
try {
  await evaluate(page, `location.reload(); true`);
  await sleep(4000);
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
        el.children.length === 0 && el.textContent?.trim() === 'pi-p5-verify.docx'
      );
      candidates[candidates.length - 1]?.click();
      return candidates.length;
    })()`,
  );
  const officePreview = await waitFor(
    page,
    `(() => {
      const chrome = document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title');
      const el = document.querySelector('[data-panel-kind="declarative"]');
      return chrome === '文件预览' && el && el.textContent.includes(${JSON.stringify(DOCX_MARKER)}) ? true : false;
    })()`,
    20_000,
  );
  officePreview
    ? ok('office preview routing: .docx file-tree click → plugin panel with extracted text (office.read capability)')
    : fail('office preview routing', `tree candidates=${clicked}`);
} finally {
  const { rmSync } = await import('node:fs');
  rmSync(DOCX_FILE, { force: true });
}

// ── 9 · Connector scaffold ──
const scaffoldOk =
  existsSync(join('/Users/simba/AI/pi-coding-agent-desktop/examples/templates/connector-plugin/manifest.json')) &&
  existsSync(join('/Users/simba/AI/pi-coding-agent-desktop/examples/templates/connector-plugin/dist/main.mjs')) &&
  existsSync(join('/Users/simba/AI/pi-coding-agent-desktop/examples/templates/connector-plugin/README.md'));
scaffoldOk ? ok('connector scaffold template present (manifest + backend + README)') : fail('connector scaffold', 'template files missing');

page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
