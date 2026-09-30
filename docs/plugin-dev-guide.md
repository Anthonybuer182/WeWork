# Pi 插件开发指南

> 本文档面向第三方插件开发者,覆盖从零到上架的完整流程。

## 概念

Pi 的插件系统把「work agent」的能力拆成可弹性装卸的单元。每个插件是一个目录,包含:

- **manifest.json** — 唯一的声明入口:身份、权限、贡献点
- **PLUGIN.md**(推荐)— 这个插件是什么、怎么用;agent 靠它学会调用你
- **后端脚本**(可选)— Node.js 子进程,承载工具逻辑与状态
- **UI 面板**(可选)— 标准 HTML 页面,经沙箱 iframe 渲染在右侧栏

宿主提供:面板基础设施、能力枢纽(权限门控)、市场分发、与 agent 的双向集成。

**宿主只保留两个内置面板**(模型设置、插件中心)和内核。其余一切 —— 浏览器自动化、文件中心、待办、邮件、日历、知识库、ERP —— 都是插件。

## 快速开始

```bash
# 1. 创建插件目录
mkdir my-plugin && cd my-plugin

# 2. 最小 manifest
cat > manifest.json << 'EOF'
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "contributes": {
    "tools": [{ "name": "hello", "description": "Say hello" }]
  },
  "backend": "./dist/main.mjs"
}
EOF

# 3. 最小后端
mkdir dist
cat > dist/main.mjs << 'EOF'
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'tool-call' && msg.name === 'hello') {
    process.parentPort.postMessage({
      type: 'tool-result', id: msg.id,
      content: [{ type: 'text', text: 'Hello!' }],
    });
  }
});
process.parentPort.postMessage({ type: 'ready' });
EOF
```

把插件目录加入 `~/.pi/agent/plugins.json` 的 `devPaths` 数组,重启应用即可。

## PLUGIN.md — 让 agent 会用你的插件

在插件根目录放一份 `PLUGIN.md`,agent 就知道这个插件存在、能干什么、该怎么调。
**没有它,agent 对你的插件的全部认知只有工具 schema 里的 name 和 description。**

```markdown
---
name: files
description: "查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——用户要打开这类文件，
  或要求修改演示文稿的文字、表格、排版、增删幻灯片时用它。"
---

# 文件中心

（正文：覆盖范围表、每个工具怎么用、标准流程、常见错误、边界）
```

### 工作方式：索引常驻，正文按需读

跟 skill 一样,是**两级**的:

| | 进系统提示 | 何时发生 |
|---|---|---|
| frontmatter 的 `description` | ✅ 常驻 | 每次对话,占一行 |
| 正文 | ❌ 不常驻 | agent 判断任务匹配后,自己用 `read` 读进来 |

所以几十个插件也不会把上下文撑爆。agent 看到的是这样一个索引:

```xml
<available_plugins>
  <plugin>
    <name>文件中心</name>
    <description>查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——…</description>
    <location>/path/to/plugins/com.pi.files/PLUGIN.md</location>
  </plugin>
</available_plugins>
```

### description 写的是「什么时候用」,不是「这是什么」

**这一行是整个匹配面的全部。**写错了,agent 永远不会打开你的文档,你的工具也就永远不会被调用。

- ❌ `文件中心 — 自包含的 office 引擎(创建/编辑/预览 docx/pptx/xlsx/pdf),基于 GenOffice(Apache-2.0),无需外部工具或联网安装`
  —— 这是写给**人**看的:讲自己是什么、基于什么、什么许可证。agent 看完不知道什么时候该掏它。
- ✅ `查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——用户要打开这类文件,或要求修改演示文稿的文字、表格、排版、增删幻灯片时用它。`
  —— 讲的是**用户会说什么样的话**,agent 才能把任务和插件对上。

写正文时把边界也写清楚:哪些格式支持、哪些还不支持、失败了该怎么办。agent 读到
「这个格式没接,不要重试」就不会在那儿反复试错。

### 和 `contributes.skills` 的区别

- **`PLUGIN.md`** — 一个插件一份,讲**这个插件**是什么、什么时候用、工具怎么配合。
- **`contributes.skills`** — 插件附带的可复用技能,会被同步进 `~/.pi/agent/skills/`。

大多数插件只需要 `PLUGIN.md`。文件直接放在插件目录里,不拷贝、不写进用户的 skills 目录,
装卸即时生效(下次开对话就更新,不用重启)。

## manifest.json 参考

### 顶层字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 反向 DNS 格式(`com.company.plugin`),也是目录名 |
| `name` | ✅ | 显示名称 |
| `version` | ✅ | semver |
| `engines` | — | 宿主版本约束 `{ "pi-desktop": ">=0.1.0" }` |
| `backend` | — | 后端入口(相对路径);省略则纯 UI 插件 |
| `permissions` | — | 权限声明数组 |
| `icon` | — | 品牌图标,相对路径(推荐 SVG) |
| `contributes` | — | 贡献点(见下) |

### 贡献点(contributes)

#### panels — 面板

面板默认落在**右侧栏**。想在左侧栏出现,用 `region` 声明 —— 左侧是「全局视角」那一列
(全部文件、全部会话、agent 的常驻配置),右侧是「当前对象」那一列(会话日志、文件预览、
浏览器实时画面)。放哪边取决于面板讲的是工作区整体还是你正在看的那一个东西。

```json
{
  "panels": [
    {
      "id": "main",
      "title": "面板标题",
      "kind": "iframe",
      "entry": "./ui/index.html",
      "iconPath": "./assets/icon.svg",
      "keepAlive": "lru",
      "hidden": false,
      "companionOf": null,
      "autoHeight": false,
      "region": "right",
      "anchor": "top",
      "order": 0
    },
    {
      "id": "web",
      "kind": "liveview",
      "title": "内嵌网页"
    }
  ]
}
```

**面板类型(kind)**:

| kind | 说明 | 适用 |
|------|------|------|
| `iframe` | 标准 HTML 面板(沙箱独立源,piSDK 全套) | 绝大多数场景 |
| `liveview` | 原生视图挂载点(宿主管理 WebContentsView) | 嵌第三方网页、重 GPU |
| `declarative` | 仅消息卡片(UiNode 声明式,内部用) | 不建议对外使用 |

**面板属性**:

| 属性 | 说明 |
|------|------|
| `iconPath` | 插件自带图标(优先于 `icon` 词汇表名) |
| `keepAlive` | `always` / `lru`(默认)/ `never` — 切走时 iframe 保活策略 |
| `hidden` | `true` 不上 Rail,仅 panel.open 可达 |
| `companionOf` | 声明为本 liveview 面板的伴随卡片(贴在其上方) |
| `autoHeight` | `true` = 宿主按内容自适应 iframe 高度 |
| `region` | `left` / `right`(默认)。**`liveview` 强制留在右侧**:所有 liveview 共用一个原生视图,隐藏的左侧槽报 0×0 会把可见的那个刷白 |
| `anchor` | `top`(默认)/ `bottom` — 在所属栏图标列里的位置 |
| `order` | 同一 region + anchor 内的排序,默认 0 |

> 左侧栏的面板建议 `keepAlive: "always"`。LRU 预算是**左右共享**的(只保留 2 个),
> `lru` 会被右侧插件面板挤掉,面板状态全丢。

#### tools — agent 工具

MCP 格式的 `inputSchema`:

```json
{
  "tools": [{
    "name": "query_orders",
    "description": "Query orders by status",
    "inputSchema": {
      "type": "object",
      "properties": { "status": { "type": "string" } },
      "required": ["status"]
    }
  }]
}
```

#### commands — 斜杠命令

```json
{ "commands": [{ "name": "/sync", "title": "同步数据" }] }
```

#### selectionActions — 滑词动作

```json
{ "selectionActions": [{ "id": "save-to-kb", "title": "存入知识库" }] }
```

#### contextProviders — 上下文注入

```json
{ "contextProviders": [{ "id": "relevant-docs", "auto": true }] }
```

#### settings — 插件设置(插件中心自动渲染)

```json
{ "settings": [{ "key": "apiKey", "type": "string", "label": "API Key" }] }
```

#### messageRenderers — 对话内卡片

```json
{ "messageRenderers": [{ "type": "mail:draft", "kind": "declarative" }] }
```

#### filePreview — 文件树路由

```json
{ "filePreview": [{ "match": ["docx", "xlsx", "pptx"] }] }
```

#### skills — agent 使用说明

```json
{ "skills": [{ "path": "./skills/usage" }] }
```

## 后端开发

后端是 Node.js UtilityProcess 子进程。消息协议:

### 接收(parentPort.on('message'))

| type | 说明 |
|------|------|
| `init` | 初始化(启动后立即) |
| `tool-call` | agent 调用工具;必须回 `tool-result` |
| `ui-port` | MessagePort 转移;此后可与面板 UI 点对点通信 |
| `call-result` | 能力调用的回复 |
| `host-event` | 宿主推送(如 browser.urlChanged) |

### 发送(parentPort.postMessage)

| type | 说明 |
|------|------|
| `ready` | 必须在启动后 10s 内发,否则后端被终止 |
| `tool-result` | 回复 tool-call |
| `call` | 调用 host.* 能力(异步,回 call-result) |

### 能力调用(CapabilityHub)

```js
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'c' + (++seq);
    pending.set(id, { resolve, reject });
    post({ type: 'call', id, method, params });
    setTimeout(() => reject(new Error('timeout')), 30_000);
  });
}

// 使用
await call('filesystem.read', { path: '/workspace/data.json' });
await call('filesystem.write', { path, content, expectedMtime });
await call('browser.navigate', { url });
await call('network.fetch', { url, method: 'GET' });
await call('notify.show', { title, body });
await call('storage.set', { key, value });
await call('panel.open', { panelId, focus: true });

// 要让用户选文件,只能用宿主对话框:插件拿不到路径,只能拿到用户选中的结果。
// 这两个能力不需要权限——用户亲手选就是授权。
await call('dialog.openFile', { filters: [{ name: 'Word', extensions: ['docx'] }] });
// → { canceled, path, paths }
await call('dialog.saveFile', { defaultName: '未命名.docx' });
// → { canceled, path }
```

### UI 通信(MessagePort 点对点)

`ui-port` 到达后,通过 `state.uiPort.postMessage` 与面板 UI 双向通信:

```js
// 后端 → UI(渲染状态)
uiPort.postMessage({ kind: 'event', event: 'ui.render', panelId, data: state });

// UI → 后端(面板操作)
// 后端 onUiMessage 收 { kind: 'event', event: 'ui.event', data: { eventId } }
```

## 面板开发(HTML + piSDK)

面板是标准 HTML 页面,由宿主注入 piSDK:

```html
<script>
  // 能力调用(经权限门)
  const result = await piSDK.request('storage.get', { key: 'x' });

  // 后端消息(后端 → UI 方向)
  piSDK.onMessage((msg) => { ... });

  // 后端事件(与后端 state.uiPort 双向)
</script>
```

主题自动注入:宿主推送 CSS 变量(`--background` / `--foreground` / `--card` 等 17 个),
面板用 `var(--background)` 等引用即可自动适配明暗主题。

**文字可选**:iframe 内的 DOM 文字可直接选中 → 滑词菜单弹出 → 引用到对话/存知识库。

## 权限模型

| 权限 | 说明 |
|------|------|
| `storage` | 插件私有 KV(plugins-data/&lt;id&gt;/storage.json) |
| `notify` | 系统通知 |
| `selection` | 注册滑词动作 |
| `clipboard` | 系统剪贴板 |
| `browser` | 驱动宿主浏览器自动化 |
| `network:&lt;host&gt;` | 出站网络(域名白名单) |
| `filesystem` | 读写文件,**任意绝对路径**(含二进制) — 不限于工作区,见下方说明 |
| `secrets:&lt;ns&gt;` | 凭据保管箱 |

权限在安装时逐条展示给用户确认。运行时 CapabilityHub 强制校验,未授权调用直接拒绝。

> **`filesystem` 的范围,是这台机器上本进程能碰到的所有路径**,不是某个工作区。
> 写清楚是因为安装时用户是看着这句话点同意的:一个 `filesystem` 插件能读
> `~/.ssh/id_rsa`,也能写 `~/.zshrc`。真要收窄,得给 manifest 一个路径范围声明
> (例如 `filesystem:~/Documents`)—— 那是协议层的改动,目前没有。
>
> 所以:**需要用户指定文件时,用 `dialog.*` 让用户自己选**,别去猜路径。用户亲手
> 选出来的路径,才是这条权限唯一有意义的边界。

## 定时任务

定时器/调度逻辑放在**后端**(UtilityProcess 长驻进程),不放 UI —— 宿主在启动时会拉起
所有已启用插件的后端,且没有空闲回收,所以后端是插件里唯一活得比面板久的地方。
面板里的定时器会在用户切走的那一刻停掉,而那正是需要提醒的时候。

评估窗口记在 storage 里,每次只算 `(上次评估, 现在]` 这一段:

```js
async function tick() {
  const from = state.lastTickAt ? new Date(state.lastTickAt) : new Date();
  const now = new Date();
  for (const firing of dueBetween(state.items, from, now)) {
    await perform(firing);           // notify.show / chat.send
  }
  state.lastTickAt = now;
  await save();
}
```

三个容易踩的点:

**1. 用半开区间 `(from, to]`。** 左闭的话,每次 tick 都会把边界上那一次重放一遍。

**2. 给每一次触发一个稳定的 key,已经跑过的跳过。** key 用
`条目 + 发生在哪一次 + 触发器`,不要用时间戳或自增序号 —— 否则 tick 和
启动补齐重叠时会重复触发。幂等做对了,补跑和重启才都是安全的。

**3. 别用固定 `setInterval` 轮询。** 30 秒一跳意味着提醒最多晚 30 秒,而「下一次
什么时候该响」是算得出来的:

```js
const next = soonestFiringAfter(items, now);
setTimeout(tick, next ? clamp(next - now, 250, 30_000) : 30_000);
```
上限 30 秒是兜底(时钟跳变、休眠唤醒、日期翻页),下限 250 毫秒防止空转。

### 错过的触发:记下来,**不要**自动补跑

App 关闭期间不会执行。后端启动时拿 storage 里的时间戳一比,就能算出这段时间里
本该发生什么 —— 这一段是可靠的。

但**不要把错过的触发一次性全补上**:一次性弹 8 小时的通知是噪音,一口气跑 8 个
agent 任务还可能花掉用户的钱。正确做法是给一个宽限期(两分钟左右,用来吸收 tick
抖动和短暂重启),超过宽限期的记成「错过」,**由用户决定要不要补跑**。

### 判断「用户还在不在」没有可靠信号

后端拿不到渲染进程已死的通知 —— 宿主在 webContents 销毁时只清理自己的表,
不会关闭 port,也不会告诉后端。往死掉的 port 上 `postMessage` 是**静默 no-op**,
所以 `try/catch` 什么也抓不到。

实测的一个反直觉现象:**在 macOS 上关掉窗口,插件的面板视图仍然活着**
(`visibilityState` 是 `hidden`)。所以「面板还响应」并不能证明「消息送得出去」——
composer 在 shell 窗口里,不在插件面板里。

结论:与其猜,不如**以发送本身的结果为准**。`chat.send` 失败就记成「没送到」
(而不是「出错」),把原始错误留在详情里,并在界面上写清楚这类触发要求窗口开着。
不要因为服务不可用在界面上显示「已送达」。

## 市场上架

1. 打包插件目录为 zip
2. 计算 sha256
3. 发布到注册表 index.json:

```json
{
  "plugins": [{
    "id": "com.example.my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "url": "https://cdn.example.com/my-plugin-1.0.0.zip",
    "sha256": "…",
    "permissions": ["storage", "network:api.example.com"]
  }]
}
```

4. 宿主安装流:fetch index → 下载 zip → sha256 校验 → engines 协商 → 原子解压 → 授权确认 → 激活

## 图标规范

- 插件品牌图标:自带 SVG(单色,CSS mask 渲染随主题变色)
- 上架必须带品牌图标
- 面板图标:可声明 `iconPath`(专属)或 `icon`(词汇表名)
- 词汇表:puzzle / gear / globe / mail / calendar / todo / knowledge / erp / chat / eye / note / users / money / clock / sliders / layout

## 最佳实践

1. **状态放后端** — 面板是纯投影;面板关闭/重开不丢状态
2. **定时任务放后端** — 不放 UI(UI 随面板卸载);启动时补跑错过的触发
3. **带 PLUGIN.md** — 否则 agent 不知道这个插件能干什么,工具再全也不会被调用;
   `description` 写「什么时候用」而不是「这是什么」
4. **品牌图标必带** — 上架审核要求;单色 SVG,CSS mask 渲染
5. **权限最小化** — 只声明实际需要的权限
6. **面包屑导航** — 多面板用 `hidden` + `companionOf` 组织,一插件一 Rail 按钮
7. **错误处理** — capability 调用可能失败(权限/网络/文件),catch 并在面板中显示;
   工具返回值里把「不支持、别重试」说清楚,agent 才不会在那儿反复试错
