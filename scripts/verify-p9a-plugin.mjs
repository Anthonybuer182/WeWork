/**
 * P9a acceptance — 全插件化内核数据通道。
 *
 * Raw CDP over the app's debug port (19222),零依赖。
 *
 * Checks:
 *  1. com.pi.files 骨架插件注册(filesystem 权限 + 2 个 probe 工具)
 *  2. filesystem.write:正常写回 + 读回往返
 *  3. filesystem.write:mtime 冲突检测(外部修改后写过期 mtime → 拒绝)
 *  4. ws-file 协议:插件 iframe fetch 工作区文件(字节长度精确)
 *  5. ws-file Range:206 + Content-Range + 前 64 字节
 *  6. 权限门:无 filesystem 权限的插件 origin fetch ws-file → 403
 *  7. memory-file:注册 → 插件 iframe fetch 内容匹配
 *  8. find-preview 优先级:p9probe 哨兵扩展路由到 com.pi.files;md 仍路由到 com.pi.preview(不回归)
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CDP_HTTP = 'http://127.0.0.1:19222';
const MARKER = `P9A-${Date.now()}`;
const PROBE_DIR = join(homedir(), 'Desktop', 'Test', '.p9a');
mkdirSync(PROBE_DIR, { recursive: true });

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

// ── 1 · 骨架插件注册 ──
const reg = await evaluate(page, `(async () => {
  const plugins = await window.pluginBridge.list();
  const f = plugins.find(p => p.id === 'com.pi.files');
  return JSON.stringify({ state: f?.state, tools: (f?.tools ?? []).map(t => t.name) });
})()`);
const regInfo = JSON.parse(reg ?? '{}');
regInfo.state === 'active' && regInfo.tools.length === 3
  ? ok(`com.pi.files 注册: active + 3 个 probe 工具`)
  : fail('注册态', reg);

// ── 2 · filesystem.write 往返 ──
const WPATH = join(PROBE_DIR, `write-${MARKER}.txt`);
const WCONTENT = `P9a write probe ${MARKER}\n第二行内容`;
const wres = await runTool('com.pi.files', 'files_probe_write', { path: WPATH, content: WCONTENT });
const wtext = wres?.content?.[0]?.text ?? '';
const diskContent = readFileSync(WPATH, 'utf-8');
wres?.ok && diskContent === WCONTENT
  ? ok(`filesystem.write: 写入 ${Buffer.byteLength(WCONTENT)}B,磁盘读回一致(${wtext.split(', ')[1]})`)
  : fail('filesystem.write 往返', `disk=${diskContent.slice(0, 40)} res=${wtext.slice(0, 80)}`);

// ── 3 · mtime 冲突检测 ──
const rres = await runTool('com.pi.files', 'files_probe_read', { path: WPATH });
const mtimeMatch = /mtime (\d+)/.exec(rres?.content?.[0]?.text ?? '');
const staleMtime = mtimeMatch ? Number(mtimeMatch[1]) - 60000 : 1;
const cres = await runTool('com.pi.files', 'files_probe_write', {
  path: WPATH,
  content: 'SHOULD NOT WIN',
  expectedMtime: staleMtime,
});
const ctext = cres?.content?.[0]?.text ?? '';
const diskAfter = readFileSync(WPATH, 'utf-8');
const cerr = cres?.error ?? ctext;
cres?.ok === false && String(cerr).includes('conflict') && diskAfter === WCONTENT
  ? ok('mtime 冲突检测: 过期 mtime 写入被拒,磁盘内容未变')
  : fail('mtime 冲突', `ok=${cres?.ok} err=${String(cres?.error ?? ctext).slice(0, 80)} diskIntact=${diskAfter === WCONTENT}`);

// ── 4-7 · 协议通道(在 com.pi.files iframe 内 fetch)──
// Hidden panel — no rail button; open programmatically via the plugin's
// panel.open capability (the same path agent file-blocks will use).
await runTool('com.pi.files', 'files_probe_open', {});
await sleep(2000);
const filesTarget = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).find((t) =>
  t.url.startsWith('pi-plugin://com.pi.files'),
);
if (!filesTarget) {
  fail('ws-file 协议', 'com.pi.files iframe target not found');
} else {
  const fp = await connect(filesTarget.webSocketDebuggerUrl);
  await fp.send('Runtime.enable', {});

  // 4 · ws-file 全量
  const binPath = join(PROBE_DIR, `bin-${MARKER}.png`);
  // 4×4 红色 PNG(最小合法)
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYGJgYEBAA1cAwUAAAAASUVORK5CYII=';
  writeFileSync(binPath, Buffer.from(pngB64, 'base64'));
  const wsFull = await evaluate(fp, `(async () => {
    const r = await fetch('pi-plugin://com.pi.files/ws-file?path=' + ${JSON.stringify(binPath)});
    const buf = await r.arrayBuffer();
    return JSON.stringify({ status: r.status, len: buf.byteLength, ct: r.headers.get('content-type') });
  })()`);
  const wsf = JSON.parse(wsFull ?? '{}');
  wsf.status === 200 && wsf.len === Buffer.from(pngB64, 'base64').length && wsf.ct === 'image/png'
    ? ok(`ws-file 全量: ${wsf.len}B 精确,image/png`)
    : fail('ws-file 全量', wsFull);

  // 5 · Range
  const wsRange = await evaluate(fp, `(async () => {
    const r = await fetch('pi-plugin://com.pi.files/ws-file?path=' + ${JSON.stringify(binPath)}, { headers: { Range: 'bytes=0-63' } });
    const buf = await r.arrayBuffer();
    return JSON.stringify({ status: r.status, len: buf.byteLength, cr: r.headers.get('content-range') });
  })()`);
  const wsr = JSON.parse(wsRange ?? '{}');
  wsr.status === 206 && wsr.len === 64 && /^bytes 0-63\//.test(wsr.cr ?? '')
    ? ok(`ws-file Range: 206 + ${wsr.len}B + Content-Range \`${wsr.cr}\``)
    : fail('ws-file Range', wsRange);

  // 6 · 权限门(无 filesystem 权限的 hello origin → 403)
  const forbidden = await evaluate(fp, `(async () => {
    const r = await fetch('pi-plugin://com.pi.hello/ws-file?path=' + ${JSON.stringify(binPath)});
    return r.status;
  })()`);
  forbidden === 403
    ? ok('权限门: hello(无 filesystem 权限)origin 请求 ws-file → 403')
    : fail('权限门', `status=${forbidden}`);

  // 7 · memory-file
  const MEM = `mem-${MARKER}`;
  const MEM_CONTENT = `memory probe ${MARKER} 内容`;
  await evaluate(page, `window.electronAPI.invoke('pi:files:memory:register', ${JSON.stringify({
    name: MEM, fileName: `${MEM}.txt`, mimeType: 'text/plain', base64: Buffer.from(MEM_CONTENT).toString('base64'),
  })})`);
  const memFetch = await evaluate(fp, `(async () => {
    const r = await fetch('pi-plugin://com.pi.files/memory-file?name=' + ${JSON.stringify(MEM)});
    const text = await r.text();
    return JSON.stringify({ status: r.status, match: text === ${JSON.stringify(MEM_CONTENT)} });
  })()`);
  const mem = JSON.parse(memFetch ?? '{}');
  mem.status === 200 && mem.match
    ? ok('memory-file: 注册 → 插件 iframe fetch 内容匹配')
    : fail('memory-file', memFetch);

  fp.close();
}

// ── 8 · find-preview 路由 ──
const route = await evaluate(page, `(async () => {
  const probe = await window.electronAPI.invoke('pi:plugin:find-preview', { path: '/tmp/x.p9probe' });
  const md = await window.electronAPI.invoke('pi:plugin:find-preview', { path: '/tmp/x.md' });
  const docx = await window.electronAPI.invoke('pi:plugin:find-preview', { path: '/tmp/x.docx' });
  return JSON.stringify({ probe: probe.panelId, md: md.panelId, docx: docx.panelId });
})()`);
const rt = JSON.parse(route ?? '{}');
// P9b 后:docx/xlsx/pptx 归 com.pi.files(officecli 高保真);txt/md 归 com.pi.preview
rt.docx === 'plugin:com.pi.files:viewer' && rt.md === 'plugin:com.pi.preview:preview' && rt.probe === null
  ? ok(`find-preview: docx → com.pi.files(officecli 引擎);md → com.pi.preview;无认领 → null(系统打开出口)`)
  : fail('find-preview 路由', route);

page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
