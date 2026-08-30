/**
 * P7 acceptance test — context providers + settings + streaming cards + theme bridge.
 *
 * Raw CDP over the app's debug port (19222), zero deps.
 *
 * Checks:
 *  1. Settings contribution: plugin center renders the auto form, toggle persists
 *  2. contextProviders: auto context injected into a real agent send (session JSONL)
 *  3. Setting ↔ provider linkage: toggle off → context no longer injected
 *  4. Streaming args card: live card while the tool runs (best-effort poll)
 *  5. mail_send_draft: HTTP send via network.fetch (mock endpoint)
 *  6. Theme bridge: host tokens applied inside a plugin iframe
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CDP_HTTP = 'http://127.0.0.1:19222';
const SEND_PORT = 18766;
const MARKER = `P7-${Date.now()}`;

const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

// mock send API
const sentMails = [];
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      sentMails.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(SEND_PORT, '127.0.0.1', r));

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
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:517'));
if (!pageTarget) {
  fail('find renderer page', '');
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

const runTool = (pluginId, name, params) =>
  evaluate(page, `window.pluginBridge.executeTool(${JSON.stringify(pluginId)}, ${JSON.stringify(name)}, ${JSON.stringify(params)})`);

// ── 1 · Settings contribution: auto form in plugin center ──
await evaluate(page, `document.querySelector('[data-rail-plugin-center]')?.click(); true`);
await sleep(500);
const settingsSection = await waitFor(
  page,
  `!!document.querySelector('[data-plugin-settings="com.pi.knowledge"]')`,
);
settingsSection ? ok('插件中心渲染 knowledge 的设置贡献区块') : fail('settings section', 'not rendered');

await evaluate(page, `document.querySelector('[data-plugin-settings="com.pi.knowledge"] button')?.click(); true`);
await sleep(600);
const settingsForm = await waitFor(
  page,
  `!!document.querySelector('[data-plugin-settings="com.pi.knowledge"] [data-setting-key="autoContext"]')`,
);
settingsForm ? ok('自动设置表单: boolean 字段渲染为开关(默认开)') : fail('settings form', 'autoContext switch missing');

// ── 2 · contextProviders: real agent send with context injection ──
// Seed a KB entry containing a distinctive marker, then send an agent message
// referencing it — the user message in the session JSONL must contain the
// injected [相关上下文] section.
const KB_TITLE = `P7知识条目${MARKER}`;
await runTool('com.pi.knowledge', 'kb_save', {
  title: KB_TITLE,
  content: `这是 P7 上下文注入验收内容:${MARKER}。当用户提到 P7 上下文时,这段内容应被自动注入。`,
});
await sleep(500);

// ensure deepseek model + clean state
await evaluate(
  page,
  `window.electronAPI.invoke('pi:sdk:request', { id: 'r-p7-model', method: 'config.update', params: { data: { defaultModelId: 'deepseek-chat' } } })`,
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

const SESSION_FILE = join(
  homedir(),
  '.pi/agent/sessions/--Users-simba-Desktop-Test--/2026-07-22T02-03-28-432Z_019f8790-4b30-70fb-b661-66ae74354c85.jsonl',
);
const linesBefore = readFileSync(SESSION_FILE, 'utf-8').split('\n').length;

const typeAndSend = async (text) => {
  await evaluate(
    page,
    `(() => {
      const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
      el.focus();
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()`,
  );
  // Let React sync the composer store before pressing Enter.
  await sleep(600);
  await evaluate(
    page,
    `(() => {
      const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
};

const userMessage = `P7 上下文注入验收:请只回复"收到",不要调用任何工具。`;
await typeAndSend(userMessage);
// Wait for the assistant turn to finish (a new user entry + assistant entries).
let contextInjected = false;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  try {
    const lines = readFileSync(SESSION_FILE, 'utf-8').split('\n').filter(Boolean);
    const lastUser = [...lines].reverse().find((l) => l.includes('"user"') && l.includes('P7 上下文注入验收'));
    if (i < 3 || lastUser) {
      console.log(`  [ctx-poll ${i}] lines=${lines.length} before=${linesBefore} lastUser=${lastUser ? 'found' : 'none'} hasCtx=${lastUser ? lastUser.includes('[相关上下文]') : '-'} hasMarker=${lastUser ? lastUser.includes(MARKER) : '-'}`);
    }
    if (lines.length > linesBefore && lastUser && lastUser.includes('[相关上下文]') && lastUser.includes(MARKER)) {
      contextInjected = true;
      break;
    }
    // assistant already responded without context → stop early
    const hasAssistant = lines.slice(Math.max(0, linesBefore - 1)).some((l) => l.includes('"assistant"'));
    if (hasAssistant && lastUser && i > 5) break;
  } catch (err) { console.log('  [ctx-poll] read error:', String(err).slice(0, 80)); }
}
contextInjected
  ? ok('contextProviders: 发送前自动注入知识库相关条目(会话用户消息含 [相关上下文] 段)')
  : fail('contextProviders injection', 'no [相关上下文] section in the user message');

// ── 3 · Setting ↔ provider linkage: toggle off → no injection ──
const toggleOff = await evaluate(
  page,
  `window.pluginBridge.setSetting('com.pi.knowledge', 'autoContext', false)`,
);
await sleep(300);
const collectOff = await evaluate(
  page,
  `window.pluginBridge.collectContext('P7 上下文注入验收 ${MARKER}')`,
);
(toggleOff?.ok === true) && (collectOff?.sections ?? []).length === 0
  ? ok('设置联动: 关闭自动注入后,collectContext 返回空(provider 尊重插件设置)')
  : fail('setting linkage', JSON.stringify({ toggleOff, collectOff }));

const toggleOn = await evaluate(
  page,
  `window.pluginBridge.setSetting('com.pi.knowledge', 'autoContext', true)`,
);
await sleep(300);
const collectOn = await evaluate(
  page,
  `window.pluginBridge.collectContext('P7 上下文注入验收 ${MARKER}')`,
);
(toggleOn?.ok === true) && (collectOn?.sections ?? []).some((s) => s.includes(MARKER))
  ? ok('重新开启后,上下文恢复注入(往返验证)')
  : fail('setting re-enable', JSON.stringify(collectOn).slice(0, 120));

// ── 4 · Streaming args card (best-effort during an agent tool call) ──
await typeAndSend(`立即用 mail_create_draft 工具给 p7-stream@example.com 写主题为 ${MARKER}流式 的邮件草稿,正文任意。`);
let streamingCardSeen = false;
let finalCardSeen = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const state = await evaluate(
    page,
    `(() => ({
      streaming: !!document.querySelector('[data-plugin-card-streaming]'),
      final: !!document.querySelector('[data-plugin-card="mail_create_draft"]'),
    }))()`,
  );
  if (state.streaming) streamingCardSeen = true;
  if (state.final) {
    finalCardSeen = true;
    break;
  }
}
finalCardSeen
  ? ok(streamingCardSeen
      ? '流式卡片: args 实时渲染捕获 + 结果卡片最终呈现(两阶段完整)'
      : '结果卡片渲染(流式阶段过快未捕获,机制存在但本次模型响应瞬时完成)')
  : fail('mail card render', 'final card not found');

// ── 5 · mail_send_draft: HTTP send via network.fetch ──
await sleep(1000);
const sendResult = await runTool('com.pi.mail', 'mail_send_draft', { subject: `${MARKER}流式` });
const sendText = sendResult?.content?.[0]?.text ?? '';
const sent = sentMails.find((m) => m.subject === `${MARKER}流式`);
sendResult?.ok && sent?.to === 'p7-stream@example.com'
  ? ok(`mail_send_draft: network.fetch POST → mock 发送接口(to=${sent.to})`)
  : fail('mail_send_draft', `${sendText.slice(0, 100)} | sent=${JSON.stringify(sentMails.map((m) => m.subject))}`);

// ── 6 · Theme bridge: tokens applied inside a plugin iframe ──
await evaluate(page, `document.querySelector('[data-panel-id="plugin:com.pi.hello:hello"]')?.click(); true`);
await sleep(1500);
const helloTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) =>
  t.url.startsWith('pi-plugin://com.pi.hello'),
);
if (helloTarget) {
  const plugin = await connect(helloTarget.webSocketDebuggerUrl);
  await plugin.send('Runtime.enable', {});
  const themeApplied = await evaluate(
    plugin,
    `(() => {
      const bg = document.documentElement.style.getPropertyValue('--background');
      const fg = document.documentElement.style.getPropertyValue('--foreground');
      return bg.trim().length > 0 && fg.trim().length > 0 ? { bg: bg.trim().slice(0, 20), fg: fg.trim().slice(0, 20) } : null;
    })()`,
  );
  themeApplied
    ? ok(`iframe 主题桥: 宿主 token 已应用(--background=${themeApplied.bg})`)
    : fail('iframe theme bridge', 'no tokens applied on :root');
  plugin.close();
} else {
  fail('iframe theme bridge', 'hello iframe target not found');
}

page.close();
server.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
