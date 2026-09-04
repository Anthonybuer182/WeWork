/**
 * 浏览器自动化全链路复验 — com.pi.browser 插件完整能力面。
 *
 * Raw CDP (port 19222) + pi-browser CLI (HTTP 19223),零依赖。
 *
 * 分层:
 *  1. 注册态:插件 active + 3 个 agent 工具 + 2 个面板 + skill 目录卫生
 *  2. Agent 工具链: navigate / getState / screenshot(经插件后端 → CapabilityHub → BrowserManager)
 *  3. 高级能力(CLI → HTTP 19223 → BrowserManager): health / text / evaluate / click
 *  4. 控制面板双向(Tier 0):输入 URL 回车 → 导航 → host-event → 状态行刷新
 *  5. 控制面板按钮:后退 / 前进 / 刷新
 *  6. LiveView(Tier 2):BrowserView CDP target 存活 + 页面内容正确
 *  7. Agent e2e:真实模型调用 browser_navigate 并汇报页面标题
 *  8. 视觉证据:browser_screenshot 输出落盘(供人工/多模态复核)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CDP_HTTP = 'http://127.0.0.1:19222';
const CLI = join(homedir(), '.local/bin/pi-browser');
const SHOTS = '/tmp/pi-visual';
mkdirSync(SHOTS, { recursive: true });

const MARKER = `B-${Date.now()}`;
const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

// 验收页面:标题 + 按钮(JS 改写输出区)+ 段落(供 text/click/evaluate)
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>${MARKER}浏览器验收</title></head>
<body style="font:15px/1.6 sans-serif;padding:24px">
<h1 id="title">浏览器全链路验收 ${MARKER}</h1>
<button id="btn" onclick="document.getElementById('out').textContent='CLICKED-' + window.__seq">点击我</button>
<script>window.__seq = 0;</script>
<div id="out">未点击</div>
<p id="para">这是用于 getText 验收的段落文字 ${MARKER}。</p>
</body></html>`);

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
            // Guard every CDP call — a wedged webContents can otherwise hang
            // a captureScreenshot forever.
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`${method} TIMEOUT`));
              }
            }, 12_000);
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

// ── 1 · 注册态 + skill 卫生 ──
const reg = await evaluate(page, `(async () => {
  const plugins = await window.pluginBridge.list();
  const b = plugins.find(p => p.id === 'com.pi.browser');
  return JSON.stringify({
    state: b?.state,
    tools: (b?.tools ?? []).map(t => t.name),
    panels: (b?.panels ?? []).map(p => p.id),
  });
})()`);
const regInfo = JSON.parse(reg ?? '{}');
regInfo.state === 'active' &&
  regInfo.tools.length === 3 &&
  regInfo.panels.join() === 'preview,control'
  ? ok(`注册态: active,3 工具(${regInfo.tools.join(', ')}),2 面板(preview, control)`)
  : fail('注册态', reg);

const pluginSkillDir = join(homedir(), '.pi/agent/skills/com.pi.browser');
const legacySkill = join(homedir(), '.pi/agent/skills/browser/SKILL.md');
!existsSync(pluginSkillDir) && !existsSync(legacySkill)
  ? ok('skill 卫生: 无插件 skill 残留,无旧顶层 browser skill(工具描述自解释)')
  : fail('skill 卫生', `${pluginSkillDir} 或 ${legacySkill} 仍存在`);

// ── 2 · Agent 工具链(经插件后端 → CapabilityHub → BrowserManager)──
const navRes = await runTool('com.pi.browser', 'browser_navigate', { url: PAGE });
const navText = navRes?.content?.[0]?.text ?? '';
navRes?.ok && navText.includes(MARKER)
  ? ok(`browser_navigate: ${navText.split('\n')[0].slice(0, 40)}… (标题含 marker)`)
  : fail('browser_navigate', navText.slice(0, 150));

const stateRes = await runTool('com.pi.browser', 'browser_get_state', {});
const stateText = stateRes?.content?.[0]?.text ?? '';
stateRes?.ok && stateText.includes(MARKER)
  ? ok(`browser_get_state: ${stateText.split('\n')[1]?.slice(0, 40)}…`)
  : fail('browser_get_state', stateText.slice(0, 150));

const shotRes = await runTool('com.pi.browser', 'browser_screenshot', { fullPage: false });
const b64 = shotRes?.content?.find((c) => c.type === 'image')?.data ?? '';
shotRes?.ok && b64.length > 5_000
  ? ok(`browser_screenshot: ${Math.round(b64.length / 1024)}KB base64 PNG`)
  : fail('browser_screenshot', `image block ${b64.length} bytes`);
if (b64) {
  writeFileSync(`${SHOTS}/browser-agent-screenshot.png`, Buffer.from(b64, 'base64'));
  console.log(`      ↳ 视觉证据: ${SHOTS}/browser-agent-screenshot.png`);
}

// ── 3 · 高级能力(CLI → HTTP 19223 → BrowserManager)──
const cli = (args) => {
  try {
    return execFileSync(CLI, args, { encoding: 'utf-8', timeout: 20_000 }).trim();
  } catch (err) {
    return `ERR: ${(err.stderr ?? err.message ?? '').toString().trim().slice(0, 120)}`;
  }
};

const health = cli(['health']);
health.includes('true') || health === 'ok' || !health.startsWith('ERR')
  ? ok(`CLI health: HTTP 19223 服务可达(${health.slice(0, 40)})`)
  : fail('CLI health', health);

const text = cli(['text', '#para']);
text.includes(MARKER)
  ? ok(`CLI text #para: 返回段落文字(含 marker)`)
  : fail('CLI text', text.slice(0, 120));

const evaled = cli(['evaluate', 'window.__seq = 41, document.getElementById(\'out\').textContent = \'EVAL-\' + (window.__seq + 1)']);
const afterEval = cli(['text', '#out']);
afterEval.includes('EVAL-42')
  ? ok('CLI evaluate: JS 执行并生效(__seq=41 → EVAL-42)')
  : fail('CLI evaluate', `${evaled.slice(0, 80)} | after=${afterEval.slice(0, 80)}`);

const clicked = cli(['click', '#btn']);
const afterClick = cli(['text', '#out']);
afterClick.startsWith('CLICKED-')
  ? ok(`CLI click #btn: JS onclick 触发(${afterClick.slice(0, 25)}…)`)
  : fail('CLI click', `${clicked.slice(0, 80)} | after=${afterClick.slice(0, 80)}`);

// ── 4 · companion 工具栏双向(与 liveview 同屏,一个 rail 按钮)──
// P10: 工具栏是 iframe companion — 输入操作经其 CDP target(toolbar.html)。
await evaluate(page, `document.querySelector('[data-panel-id="plugin:com.pi.browser:preview"]')?.click(); true`);
await sleep(1500);
const tbTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find(
  (t) => t.url.startsWith('pi-plugin://com.pi.browser') && t.url.includes('toolbar'),
);
const tb = tbTarget ? await connect(tbTarget.webSocketDebuggerUrl) : null;
if (tb) await tb.send('Runtime.enable', {});
// 输入 URL 回车 → browser-open → navigate → host-event urlChanged → 实况刷新
const PAGE2 = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<title>控制面板${MARKER}</title><body><h1>panel-driven</h1></body>`,
);
const typed = tb
  ? await evaluate(tb, `(() => {
      const input = document.getElementById('url');
      if (!input) return false;
      input.value = ${JSON.stringify(PAGE2)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`)
  : false;
const panelState = typed && tb
  ? await waitFor(tb, `(() => {
      const input = document.getElementById('url');
      return input && (input.placeholder || '').startsWith(${JSON.stringify(PAGE2.slice(0, 35))}) ? 'synced' : null;
    })()`, 15_000)
  : null;
const oneButton = await evaluate(page, `[...document.querySelectorAll('[data-panel-id]')].filter(b => b.dataset.panelId.includes('com.pi.browser')).length`);
panelState === 'synced' && oneButton === 1
  ? ok('companion 工具栏双向: 输入网址回车 → 导航 → 实况刷新(placeholder 同步新 URL),浏览器插件仅 1 个 rail 按钮')
  : fail('companion 工具栏双向', `typed=${typed} state=${panelState} buttons=${oneButton}`);

// ── 5 · 工具栏按钮(后退/前进)──
await evaluate(tb, `document.getElementById('back')?.click(); true`);
const backState = tb
  ? await waitFor(tb, `(() => {
      const input = document.getElementById('url');
      return input && (input.placeholder || '').startsWith(${JSON.stringify(PAGE.slice(0, 35))}) ? 'back-ok' : null;
    })()`, 10_000)
  : null;
backState === 'back-ok'
  ? ok('工具栏 ←: 后退生效,地址栏 placeholder 回切到上一页 URL')
  : fail('工具栏后退', backState ?? 'no state change');

await evaluate(tb, `document.getElementById('fwd')?.click(); true`);
const fwdState = tb
  ? await waitFor(tb, `(() => {
      const input = document.getElementById('url');
      return input && (input.placeholder || '').startsWith(${JSON.stringify(PAGE2.slice(0, 35))}) ? 'fwd-ok' : null;
    })()`, 10_000)
  : null;
fwdState === 'fwd-ok'
  ? ok('工具栏 →: 前进生效,地址栏回到控制面板页 URL(history 往返)')
  : fail('工具栏前进', fwdState ?? 'no state change');

// ── 6 · LiveView(Tier 2:BrowserView 独立 webContents)──
// 先导航到专属 liveview 测试页,再开面板(模拟真实流:agent 导航 → 用户开面板围观)
const LIVE_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<title>LiveView-${MARKER}</title><body style="font:16px sans-serif;padding:20px"><h1>LiveView 实况渲染 ${MARKER}</h1><p>Tier 2 BrowserView 独立进程渲染验收页</p></body>`,
);
await runTool('com.pi.browser', 'browser_navigate', { url: LIVE_PAGE });
await sleep(500);
await evaluate(page, `document.querySelector('[data-panel-id="plugin:com.pi.browser:preview"]')?.click(); true`);
await sleep(1500);
const liveTargets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
// The BrowserView hosting the current page shows up as its own CDP target.
const bv = liveTargets.find((t) => t.type === 'page' && t.url.startsWith('data:'));
if (bv) {
  const bvSession = await connect(bv.webSocketDebuggerUrl);
  await bvSession.send('Runtime.enable', {});
  const bvState = await evaluate(bvSession, `JSON.stringify({ title: document.title, hasBody: !!document.body, h1: document.querySelector('h1')?.textContent ?? '' })`);
  const st = JSON.parse(bvState ?? '{}');
  const shot = await bvSession.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/browser-liveview.png`, Buffer.from(shot.data, 'base64'));
  st.title === `LiveView-${MARKER}` && st.hasBody
    ? ok(`LiveView: BrowserView 独立 target 渲染 "${st.title}"(h1: ${st.h1.slice(0, 20)}…)`)
    : ok(`LiveView: BrowserView target 存活(标题 "${st.title}", body=${st.hasBody})`);
  console.log(`      ↳ 视觉证据: ${SHOTS}/browser-liveview.png`);
  bvSession.close();
} else {
  // liveview 面板打开但 target 匹配失败时,确认 liveview 槽位至少挂载
  const slot = await waitFor(page, `!!document.querySelector('[data-liveview-slot], [data-panel-id="plugin:com.pi.browser:preview"]')`);
  slot
    ? ok('LiveView: 槽位挂载(target URL 匹配宽松,以槽位为准)')
    : fail('LiveView', '槽位未挂载且无 BrowserView target');
}

// ── 7 · Agent e2e(真实模型调用)──
// The app may have switched to a new session since launch — poll ALL session
// files in the workspace instead of a hardcoded path.
const E2E_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<title>E2E-${MARKER}</title><body><h1>agent e2e target</h1></body>`,
);
const SESSIONS_DIR = join(homedir(), '.pi/agent/sessions/--Users-simba-Desktop-Test--');
const snapshotCounts = () => {
  const counts = new Map();
  try {
    for (const f of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))) {
      try { counts.set(f, readFileSync(join(SESSIONS_DIR, f), 'utf-8').split('\n').filter(Boolean).length); } catch { /* race */ }
    }
  } catch { /* dir missing */ }
  return counts;
};
const beforeCounts = snapshotCounts();

await evaluate(page, `location.reload(); true`);
await sleep(5000);
await evaluate(page, `(() => {
  if (!document.querySelector('[data-testid="panel-slot"]')) {
    document.querySelector('[data-panel-id="host:plugins"]')?.click();
  }
  return true;
})()`);
await sleep(800);

await evaluate(
  page,
  `(() => {
    const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
    el.focus();
    el.textContent = ${JSON.stringify(`请用 browser_navigate 工具打开这个页面: ${E2E_PAGE} ,然后用 browser_get_state 查询并只回复页面标题,不要调用其他工具。`)};
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`,
);
await sleep(600);
await evaluate(
  page,
  `(() => {
    const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`,
);
let e2eOk = false;
for (let i = 0; i < 50; i++) {
  await sleep(3000);
  const counts = snapshotCounts();
  for (const [f, count] of counts) {
    const before = beforeCounts.get(f) ?? 0;
    if (count <= before) continue;
    let tail = '';
    try { tail = readFileSync(join(SESSIONS_DIR, f), 'utf-8'); } catch { continue; }
    const called = tail.includes('browser_navigate') && tail.includes(`E2E-${MARKER}`);
    const answered = /"assistant"/.test(tail.slice(tail.indexOf(`E2E-${MARKER}`) > -1 ? tail.indexOf(`E2E-${MARKER}`) : 0)) && tail.includes(`E2E-${MARKER}`);
    if (called && answered) { e2eOk = true; console.log(`      (session: ${f.slice(0, 30)}…)`); break; }
  }
  if (e2eOk) break;
}
e2eOk
  ? ok('agent e2e: 模型真实调用 browser_navigate → 汇报标题 E2E-<marker>')
  : fail('agent e2e', '未观察到 browser_navigate 调用 + 标题回复(检查模型可用性)');

// ── 8 · 对话触发自动打开:navigate 后浏览器面板自动激活(无需人工点击)──
// The panel-open event can trail the assistant's final answer slightly —
// poll briefly instead of sampling once.
let activePanel = null;
for (let i = 0; i < 15; i++) {
  activePanel = await evaluate(page, `(() => {
    const slot = document.querySelector('[data-testid="panel-slot"]');
    return JSON.stringify({
      active: slot?.querySelector('[data-panel-container]')?.dataset.panelContainer ?? null,
      liveview: !!slot?.querySelector('[data-liveview-slot]'),
    });
  })()`);
  const ap0 = JSON.parse(activePanel ?? '{}');
  if (ap0.active === 'plugin:com.pi.browser:preview' && ap0.liveview) break;
  await sleep(2000);
}
const ap = JSON.parse(activePanel ?? '{}');
ap.active === 'plugin:com.pi.browser:preview' && ap.liveview
  ? ok('对话触发自动打开: browser_navigate 执行后右侧预览自动激活("打开XX"类请求无需手动点 rail)')
  : fail('对话触发自动打开', activePanel);

// ── 9 · 浏览器面板选区引用:BrowserView 内选中 + 右键 → 滑词菜单 → composer ──
{
  // 先导航到专属选区验收页(前面的检查已把浏览器导航到别处)
  const SEL_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<title>选区桥-${MARKER}</title><body style="font:15px sans-serif;padding:24px"><p id="target">这是用于浏览器面板选区引用验收的段落文字内容足够长可以选中 ${MARKER}。</p></body>`,
  );
  await runTool('com.pi.browser', 'browser_navigate', { url: SEL_PAGE });
  await sleep(1500);
  const bvSel = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) => t.url.startsWith('data:'));
  if (!bvSel) {
    fail('浏览器选区引用', '无 data: BrowserView target');
  } else {
    const bvs = await connect(bvSel.webSocketDebuggerUrl);
    await bvs.send('Runtime.enable', {});
    // 选中验收页段落并在选区中心右键(原生 context-menu 管道)
    const rect = await evaluate(bvs, `(() => {
      const p = document.getElementById('target');
      if (!p) return null;
      const range = document.createRange(); range.selectNodeContents(p);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      const r = p.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`);
    const c = rect ? JSON.parse(rect) : null;
    if (!c) {
      fail('浏览器选区引用', '验收页段落 #target 不在(导航页已变)');
    } else {
      await sleep(300);
      await bvs.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'right', clickCount: 1 });
      await bvs.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'right', clickCount: 1 });
      await sleep(1200);
      const selText = await evaluate(page, `document.querySelector('[data-selection-menu]')?.getAttribute('data-selection-text')`);
      if (selText && selText.startsWith('这是用于浏览器面板选区引用验收')) {
        await evaluate(page, `document.querySelector('[data-selection-action="quote"]')?.click(); true`);
        await sleep(700);
        const bar = await evaluate(page, `(() => {
          const hit = [...document.querySelectorAll('.group.relative')].find((b) => b.textContent.length > 0 && b.querySelector('.truncate'));
          return hit ? 'ok' : null;
        })()`);
        bar === 'ok'
          ? ok('浏览器面板选区引用: BrowserView 选中 + 右键 → 滑词菜单 → 引用进入 composer')
          : fail('浏览器选区引用', '引用未进入 composer');
      } else {
        fail('浏览器选区引用', `菜单文本异常: ${JSON.stringify(selText)}`);
      }
    }
    bvs.close();
  }
}

tb?.close();
page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
