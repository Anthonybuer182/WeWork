/**
 * P6 acceptance test — message cards + 滑词引用 + network capability.
 *
 * Raw CDP over the app's debug port (19222), zero deps.
 *
 * Checks:
 *  1. network.fetch: permission-gated egress (local live server + denied host)
 *  2. Tool cards: backend returns declarative card tree (mail/todo)
 *  3. 滑词引用: selection menu (default quote + plugin actions) in chat
 *  4. Quote lands in the composer
 *  5. Plugin selection action (kb.save-selection → knowledge entry)
 *  6. Plugin iframe selection path (SDK → relay → menu)
 *  7. Real agent e2e: LLM invokes mail_create_draft → card renders in chat
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CDP_HTTP = 'http://127.0.0.1:19222';
const LIVE_PORT = 18765;
const LIVE_MARKER = `P6-LIVE-ORDER-${Date.now()}`;

const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

// ── local mock ERP API (network.fetch egress target) ──
const liveServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ orders: [{ no: 'LIVE-001', customer: 'P6实时数据公司', amount: 9900, status: 'pending' }] }));
});
await new Promise((r) => liveServer.listen(LIVE_PORT, '127.0.0.1', r));

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
    await sleep(400);
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
      document.querySelector('button[title="Expand right panel"]')?.click();
    }
    return true;
  })()`,
);
await sleep(400);

const runTool = (pluginId, name, params) =>
  evaluate(page, `window.pluginBridge.executeTool(${JSON.stringify(pluginId)}, ${JSON.stringify(name)}, ${JSON.stringify(params)})`);

// ── 1 · network.fetch: permission-gated egress ──
const live = await runTool('com.pi.erp-demo', 'erp_fetch_live', {});
const liveText = live?.content?.[0]?.text ?? '';
live?.ok && liveText.includes('P6实时数据公司')
  ? ok('network.fetch: live data from local API (host granted via network:localhost)')
  : fail('network.fetch live', liveText.slice(0, 150));

const denied = await runTool('com.pi.erp-demo', 'erp_fetch_live', { url: 'http://example.com/orders' });
const deniedText = denied?.content?.[0]?.text ?? '';
deniedText.includes('not granted') && deniedText.includes('example.com')
  ? ok('network.fetch: un-granted host rejected with permission reason (connector egress control)')
  : fail('network.fetch permission denial', deniedText.slice(0, 150));

// ── 2 · Tool cards (declarative card trees returned by backends) ──
const MAIL_MARKER = `P6卡片-${Date.now()}`;
const mailTool = await runTool('com.pi.mail', 'mail_create_draft', {
  to: 'p6@example.com',
  subject: MAIL_MARKER,
  body: '这是 P6 消息卡片链路验证正文。',
});
mailTool?.ok && mailTool?.card?.component === 'Card' && JSON.stringify(mailTool.card).includes('收件人')
  ? ok('tool card: mail_create_draft returns a declarative Card tree (KeyValue + Text)')
  : fail('tool card mail', JSON.stringify(mailTool?.card).slice(0, 150));

const todoTool = await runTool('com.pi.todo', 'todo_add', { title: `${MAIL_MARKER} 任务` });
todoTool?.ok && todoTool?.card?.component === 'Card'
  ? ok('tool card: todo_add returns a declarative Card tree')
  : fail('tool card todo', JSON.stringify(todoTool?.card).slice(0, 100));

// ── 3 · 滑词引用: selection menu in chat ──
const selected = 'P6滑词菜单验收选区文本';
await evaluate(
  page,
  `(() => {
    const span = document.createElement('span');
    span.textContent = ${JSON.stringify(selected)};
    span.style.cssText = 'position:fixed;left:80px;top:80px;z-index:999;';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
    return true;
  })()`,
);
const menuShown = selected
  ? await waitFor(
      page,
      `(() => {
        const menu = document.querySelector('[data-selection-menu]');
        if (!menu) return false;
        const actions = [...menu.querySelectorAll('[data-selection-action]')].map((b) => b.getAttribute('data-selection-action'));
        return actions.includes('quote')
          && actions.includes('com.pi.mail:mail.quote-draft')
          && actions.includes('com.pi.knowledge:kb.save-selection') ? actions : false;
      })()`,
    )
  : null;
menuShown
  ? ok(`滑词菜单: chat selection → menu with default quote + 2 plugin actions (${menuShown.length} items)`)
  : fail('滑词菜单', `selected="${String(selected).slice(0, 20)}" menu=${!!menuShown}`);

// ── 4 · Quote lands in the composer ──
if (selected) {
  await evaluate(page, `document.querySelector('[data-selection-action="quote"]')?.click(); true`);
  const quoted = await waitFor(
    page,
    `(() => {
      const bars = [...document.querySelectorAll('.group.relative')];
      return bars.some((b) => b.textContent.includes(${JSON.stringify(selected.slice(0, 15))})) ? true : false;
    })()`,
  );
  quoted ? ok('引用到对话: selection quoted into the composer quote bar') : fail('quote to composer', 'quote bar not updated');
}

// ── 5 · Plugin selection action (kb.save-selection) ──
const KB_SELECTION = `P6选区知识-${Date.now()}`;
await evaluate(
  page,
  `(() => {
    // Select a synthetic text node inside the chat area, then trigger the menu.
    const container = document.querySelector('[class*="chat"], [data-testid="panel-slot"]') ?? document.body;
    const span = document.createElement('span');
    span.textContent = ${JSON.stringify(KB_SELECTION)};
    span.style.position = 'fixed';
    span.style.left = '10px';
    span.style.top = '10px';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
    return true;
  })()`,
);
const kbMenuReady = await waitFor(
  page,
  `!!document.querySelector('[data-selection-action="com.pi.knowledge:kb.save-selection"]')`,
  8000,
);
let kbActionClicked = false;
if (kbMenuReady) {
  kbActionClicked = await evaluate(
    page,
    `(() => {
      const btn = document.querySelector('[data-selection-action="com.pi.knowledge:kb.save-selection"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
}
await sleep(1000);
let kbSaved = false;
try {
  const storage = JSON.parse(readFileSync(join(homedir(), '.pi/agent/plugins-data/com.pi.knowledge/storage.json'), 'utf-8'));
  kbSaved = (storage.entries ?? []).some((e) => e.content === KB_SELECTION);
} catch { /* not yet */ }
if (!kbSaved) {
  // the menu may have hidden — retry once via direct store action path
  kbSaved = false;
}
kbActionClicked && kbSaved
  ? ok('插件选区动作: 存入知识库 → backend 保存 → plugins-data 持久化')
  : fail('插件选区动作', `clicked=${kbActionClicked} saved=${kbSaved}`);

// ── 6 · Plugin iframe selection path (SDK → relay → menu) ──
const iframeMenu = await evaluate(
  page,
  `(() => {
    window.dispatchEvent(new CustomEvent('pi-plugin-selection', {
      detail: { pluginId: 'com.pi.hello', text: 'P6 iframe 选区内容', x: 250, y: 250 },
    }));
    return true;
  })()`,
);
await sleep(400);
const iframeMenuShown = await waitFor(
  page,
  `(() => {
    const menu = document.querySelector('[data-selection-menu]');
    return menu && menu.textContent.includes('引用到对话') ? true : false;
  })()`,
  5000,
);
iframeMenu && iframeMenuShown
  ? ok('iframe 选区路径: SDK 上报 → 中继 CustomEvent → 选区菜单(来源=插件面板)')
  : fail('iframe 选区路径', 'menu not shown');
await evaluate(page, `document.body.click(); true`);

// ── 7 · Real agent e2e: LLM → mail_create_draft → card in chat timeline ──
const activeSession = await evaluate(
  page,
  `JSON.parse(localStorage.getItem('pi-ui-storage') || '{}').state?.activeSessionId ?? null`,
);
if (!activeSession) {
  fail('agent e2e', 'no active session');
} else {
  // Point at a working model (config-persisted), then reload for a clean state.
  await evaluate(
    page,
    `window.electronAPI.invoke('pi:sdk:request', { id: 'req-p6-model', method: 'config.update', params: { data: { defaultModelId: 'deepseek-chat' } } })`,
  );
  await evaluate(page, `location.reload(); true`);
  await sleep(5000);
  await evaluate(
    page,
    `(() => {
      if (!document.querySelector('[data-testid="panel-slot"]')) {
        document.querySelector('button[title="Expand right panel"]')?.click();
      }
      return true;
    })()`,
  );
  await sleep(1000);
  const message = `请立即使用 mail_create_draft 工具创建一封邮件草稿:收件人 p6@example.com,主题 ${MAIL_MARKER},正文"P6 消息卡片端到端验证"。只调用这一个工具,不要做其他事。`;
  await evaluate(
    page,
    `(() => {
      const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
      if (!el) return 'no-input';
      el.focus();
      el.textContent = ${JSON.stringify(message)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(600);
  // menu not open (plain text) → single Enter submits
  await evaluate(
    page,
    `(() => {
      const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
  const cardInChat = await waitFor(
    page,
    `document.querySelector('[data-plugin-card="mail_create_draft"]')?.textContent.includes(${JSON.stringify('p6@example.com')}) ?? false`,
    180_000,
  );
  cardInChat
    ? ok('agent e2e: LLM 调用 mail_create_draft → 声明式卡片渲染进对话时间线')
    : fail('agent e2e card in chat', 'card element not found within 180s');
}

page.close();
liveServer.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
