# Pi 插件开发指南

> 本文档面向第三方插件开发者,覆盖从零到上架的完整流程。

## 概念

Pi 的插件系统把「work agent」的能力拆成可弹性装卸的单元。每个插件是一个目录,包含:

- **manifest.json** — 唯一的声明入口:身份、权限、贡献点
- **PLUGIN.md**(推荐)— 这个插件是什么、怎么用;agent 靠它学会调用你
- **后端脚本**(可选)— Node.js 子进程,承载工具逻辑与状态
- **UI 面板**(可选)— 标准 HTML 页面,由宿主装进窗口在右侧栏显示

宿主提供:面板基础设施、能力枢纽(权限门控)、市场分发、与 agent 的双向集成。

**宿主自带的面板**:设置、插件中心、文件、会话、搜索、上下文、浏览器。
其余一切 —— 待办事项、邮件、知识库、文件查看器、浏览器自动化工具 —— 都是插件。

> 「浏览器」和「文件查看器」值得分清:前者是**宿主自带的面板**(那块视图是宿主自己的浏览器,
> agent 的浏览器工具驱动的就是它),后者是**插件**(页面和引擎都由插件提供)。

## 快速开始

一个最小插件:没有面板,只有一个工具。做完你就能看到它出现在插件中心。

### 1 · 建目录

```bash
mkdir com.example.hello && cd com.example.hello
```

### 2 · `manifest.json`

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "0.1.0",
  "apiVersion": 2,
  "backend": "./dist/main.mjs",
  "contributes": {
    "tools": [{ "name": "hello", "description": "Say hello" }]
  }
}
```

`id` 用反向域名,同时也是目录名。

### 3 · 后端

```bash
npm init -y
npm install @pi/plugin-sdk
npm install -D esbuild
```

> SDK 目前还没发到 npm。在那之前,用路径依赖指向仓库里的
> `packages/plugin-sdk`(`"@pi/plugin-sdk": "file:…/packages/plugin-sdk"`)。

```ts
// src/backend/index.ts
import { plugin } from '@pi/plugin-sdk';

plugin({
  async onTool(name) {
    if (name === 'hello') return 'Hello!';
    throw new Error(`unknown tool: ${name}`);
  },
});
```

打包:

```bash
npx esbuild src/backend/index.ts --bundle --platform=node --format=esm \
  --target=node20 --outfile=dist/main.mjs
```

**必须 bundle。** 宿主只 fork `dist/main.mjs` 这一个文件 —— SDK 要打进去,
不然运行时报找不到模块。

### 4 · 装上去

```bash
mkdir -p ~/.pi/agent/plugins/com.example.hello
cp -r manifest.json dist ~/.pi/agent/plugins/com.example.hello/
```

重启应用,插件中心里就有它了。对 agent 说「跟我说声 hello」,它会调 `hello` 工具。

> 分发给别人走插件市场(见「市场上架」),不是让人手动拷目录。

### 加一个面板?

在 `manifest.json` 的 `contributes` 里加:

```json
"panels": [{ "id": "main", "title": "Hello", "entry": "./ui/index.html" }]
```

再写一个 `ui/index.html` —— 它就是一个普通网页,宿主注入的 `window.piSDK` 用来跟后端说话。
见「面板开发」。

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
| `version` | ✅ | 你自己的版本号,semver |
| `apiVersion` | — | 你照哪一版协议写的。当前是 **2**。对不上会被标成 `incompatible` 并说明原因 |
| `description` | — | 一句话说明 |
| `engines` | — | 宿主版本约束 `{ "pi-desktop": ">=0.1.0" }` |
| `backend` | — | 后端入口(相对路径);省略则纯 UI 插件 |
| `permissions` | — | 权限声明数组 |
| `icon` | — | 品牌图标,相对路径(推荐 SVG) |
| `contributes` | — | 贡献点(见下) |

### 贡献点(contributes)

#### panels — 面板

**面板就是一张网页。** 你在 `entry` 里指明它在哪,剩下的宿主负责。

面板默认落在**右侧栏**。想在左侧栏出现,用 `region` 声明 —— 左侧是「全局视角」那一列
(全部文件、全部会话、agent 的常驻配置),右侧是「当前对象」那一列(会话日志、文件预览)。
放哪边取决于面板讲的是工作区整体还是你正在看的那一个东西。

```json
{
  "panels": [
    {
      "id": "main",
      "title": "面板标题",
      "entry": "./ui/index.html",
      "icon": "./assets/icon.svg",
      "keepAlive": "lru",
      "region": "right",
      "anchor": "top",
      "order": 0
    },
    {
      "id": "overview",
      "title": "全局视图",
      "entry": "./ui/overview.html",
      "icon": "calendar",
      "region": "left",
      "keepAlive": "always"
    }
  ]
}
```

一个插件可以有多个面板 —— 它们各自在图标栏里有一个按钮。多面板的时候,后端要靠
`panelId` 分辨消息是哪个面板发来的(见「UI 通信」一节)。

> **没有「面板类型」这个字段。** 你不需要声明面板长什么样、宿主怎么装它 ——
> 那是宿主的事,而且会变(桌面端用原生视图,不是为了好看,是因为 iframe 里输入法会错位、
> 打印和下载都不行)。你的面板在任何宿主上都是同一张网页,同一套 `piSDK`。

**面板属性**:

| 属性 | 说明 |
|------|------|
| `entry` | ✅ 面板的 HTML 页面,相对插件根目录 |
| `icon` | 图标。写 `./assets/x.svg` 就是自带文件,写 `calendar` 就是用系统图标名。**不写就继承插件品牌图标** |
| `keepAlive` | `always` / `lru`(默认)/ `never` — 切走时面板保活策略 |
| `hidden` | `true` 不上图标栏,仅 `panel.open` 可达 |
| `region` | `left` / `right`(默认) |
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
{ "messageRenderers": [{ "type": "mail:draft" }] }
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

后端是一个 Node 进程。宿主负责把它拉起来、给它一个私有目录、把面板和它的消息接上。

**这些管道 SDK 全包了,你不要手写。**

### 最小后端

```ts
import { plugin } from '@pi/plugin-sdk';

plugin({
  async onTool(name, params, ctx) {
    if (name === 'note_add') {
      await ctx.call('storage.set', { key: 'note', value: params.text });
      return '记下了。';
    }
    throw new Error(`unknown tool: ${name}`);
  },

  async onPanelMounted(panelId, params, ctx) {
    // 面板的第一次绘制放这里
    ctx.send(panelId, 'ui.render', { note: await ctx.call('storage.get', { key: 'note' }) });
  },
});
```

`plugin(...)` 在**模块顶层调用一次**。宿主 fork 的就是这个文件,所以"导入即启动"。

### 能实现哪些回调

| 回调 | 什么时候被调 |
|------|------|
| `onInit(ctx)` | 后端起来了。**此时面板还没开**,别在这儿画界面 |
| `onPanelMounted(panelId, params, ctx)` | 某个面板加载完了 —— 第一次绘制放这儿 |
| `onRequest(panelId, method, params, ctx)` | 面板在等一个答复 |
| `onEvent(panelId, event, data, ctx)` | 面板报了一件事 |
| `onTool(name, params, ctx)` | agent 调了你的工具 |
| `onCommand(name, args, ctx)` | 斜杠命令跑了 |
| `onSelectionAction(actionId, text, ctx)` | 滑词动作被点了 |
| `onContextRequest(providerId, message, ctx)` | 宿主发消息前要上下文,返回要注入的文字 |
| `onHostEvent(event, data, ctx)` | 宿主推了个事件 |

一个都不实现也行 —— 那就是一个没有后端的插件(把 manifest 里的 `backend` 去掉)。

### `ctx` 里有什么

| | |
|---|---|
| `ctx.pluginId` | 插件 id |
| `ctx.dataDir` | 这个插件的私有目录(启动前就建好了) |
| `ctx.call(method, params)` | 调宿主能力,返回 Promise |
| `ctx.send(panelId, event, data)` | 往某个面板推事件 |
| `ctx.openPanel(panelId, { focus })` | 打开自己的面板 |
| `ctx.setBadge(panelId, n)` | 面板图标上的角标,传 `null` 清掉 |
| `ctx.log.info / warn / error(msg)` | 写进应用日志,前缀是你的插件 id |

### 能力(`ctx.call`)

```js
await ctx.call('filesystem.read', { path: '/workspace/data.json' });
await ctx.call('filesystem.write', { path, content, expectedMtime });
await ctx.call('browser.navigate', { url });
await ctx.call('network.fetch', { url, method: 'GET' });
await ctx.call('notify.show', { title, body });
await ctx.call('storage.set', { key, value });
await ctx.call('panel.open', { panelId, focus: true });

// 让用户选文件只能用宿主对话框:插件拿不到路径,只能拿到用户选中的结果。
// 这两个不需要权限——用户亲手选就是授权。
await ctx.call('dialog.openFile', { filters: [{ name: 'Word', extensions: ['docx'] }] });
// → { canceled, path, paths }
await ctx.call('dialog.saveFile', { defaultName: '未命名.docx' });
// → { canceled, path }
```

### 写错了会怎样

**这一节是整个 SDK 存在的理由。下面每一条,以前全都是静默的** —— 界面上"点了没反应",
日志里什么都没有,只能靠猜:

| 你写了什么 | 会发生什么 |
|---|---|
| `onRequest` 忘了 `return` | 面板收到 `ok:false`,说明哪个方法没返回东西 |
| handler 抛异常 | 面板收到 `ok:false`,带着异常信息 |
| `onTool` 忘了 `return` | agent 收到报错,说明这个工具没返回任何东西 |
| 面板发了个你没处理的事件 | 后端日志一条 `warn`,带事件名 |
| 面板的消息没带 panel id | 后端日志一条 `warn` |
| 实现了 `onEvent` 但没实现 `onPanelMounted` | 面板首次挂载时 `warn` 一条,提醒你别忘了画 |
| `ctx.call` 一直不回 | 30 秒后 reject,带方法名 |
| 面板的 `piSDK.request` 一直不回 | 30 秒后 reject,带方法名 |

日志前缀是 `[plugin:你的插件id]`,和应用日志混在一起 —— 直接搜插件 id 就能找到。

### 底层协议(一般不用看)

SDK 底下是两套通道。**只有你不打算用 SDK 的时候才需要知道这些**(比如给一个已经很复杂的
既有后端做适配):

- **控制面** —— `process.parentPort`。生命周期、能力调用、工具、命令都走这儿,都要过 main
  进程,所以权限在这边判。
- **数据面** —— 一个 `MessagePort`,面板和你的后端点对点。**宿主只转发,不看内容。**

启动后 10 秒内必须发 `ready`,否则宿主会把后端杀掉。

控制面的消息类型在 `packages/types/src/plugin/protocol.ts`;数据面那几条在
`packages/plugin-sdk/src/index.ts` 的 `onPanelMessage` 里(面板侧的另一半在
`apps/desktop/src/main/plugins/plugin-sdk-js.ts`)。

> 内置的五个插件全都用 SDK。上面这段是给你**不打算用 SDK** 时看的 ——
> 比如给一个已经很复杂的既有后端做适配,那种情况下你要自己接这两套通道。

### 自测

后端可以不启动应用就验 —— 拿一个假宿主驱动打包好的 `dist/main.mjs`:

```js
process.parentPort = fakePort;                 // 必须在 import 之前
await import('./dist/main.mjs');               // SDK 在导入时接管
```

> 顺序不能反。SDK 在 `plugin(...)` 被调用的那一刻就要宿主端口,拿不到会直接抛错。
> 而且后端在 `onInit` 里读一次存储 —— 种子数据也要在 import 之前放好。

`@pi/plugin-sdk` 自己的契约测试(21 项,覆盖每一条报错路径)是个现成的样板:

```bash
node packages/plugin-sdk/tests/smoke.mjs
```

内置插件各有一个 `scripts/smoke-backend.mjs`,跑法:

```bash
cd plugins/com.pi.tasks && node scripts/smoke-backend.mjs
```

五个插件合计 **128 项检查**(浏览器 9 / 知识库 16 / 邮件 20 / 事项 38 / 文件查看器 45),
加上 SDK 自己的 21 项契约测试。

## 面板开发(HTML + piSDK)

面板就是一个普通 HTML 页面。宿主在页面加载前注入 `window.piSDK` ——
**不用打包、不用手写消息、不用知道宿主怎么把它装进窗口。**

```js
// ① 问后端要数据(后端实现 onRequest)
const view = await piSDK.request('state.get');

// ② 告诉后端用户干了什么(后端实现 onEvent)
piSDK.emit('note.add', { text });

// ③ 收后端推来的东西
piSDK.onMessage((msg) => {
  if (msg.event === 'ui.render') render(msg.data);
});
```

**面板 id 不用你管。** 宿主加载页面时把"你是哪块面板"注进去,`piSDK` 自动盖在每条
发出的消息上。所以一个插件有多块面板时,后端天然分得清是谁在说话 ——
以前这件事要作者自己把 id 放在正确的嵌套层里,放错了**两端都不报错**。

### ⚠️ 唯一要记的一条:面板不能直接调宿主能力

面板只能跟**你自己这个插件的后端**说话。中间那根管子宿主只负责转发,**完全不看内容**。

所以下面这行是错的 —— 宿主不会拦下来帮你转成能力调用:

```js
// ❌ 这不叫「读插件存储」,除非你的后端自己实现了一个叫 storage.get 的方法
await piSDK.request('storage.get', { key: 'x' });
```

正确做法是**后端**去调,面板只跟后端说话:

```js
// 面板
const note = await piSDK.request('note.get');

// 后端
async onRequest(panelId, method, ctx) {
  if (method === 'note.get') return ctx.call('storage.get', { key: 'note' });
}
```

宿主能力(`storage.*` / `notify.show` / `network.fetch` …)统统走**后端**的 `ctx.call()`,
因为那些调用要过 main 进程的权限门。面板里没有权限门。

### 三条对应关系

| 面板这头 | 后端那头 |
|---|---|
| `await piSDK.request('m', p)` | `onRequest(panelId, 'm', p, ctx)` |
| `piSDK.emit('e', d)` | `onEvent(panelId, 'e', d, ctx)` |
| `piSDK.onMessage(cb)` | `ctx.send(panelId, 'e', d)` |

**对不上会报错,不会静默:**

- 面板请求后端却没回应 → 30 秒后 reject,并告诉你卡在哪个方法上
- 后端收到没处理过的事件 → 日志一条警告,带事件名
- 面板打开后一直空白 → 后端日志会提醒你可能是没实现 `onPanelMounted`

主题自动注入:宿主推送 CSS 变量(`--background` / `--foreground` / `--card` 等 17 个),
面板用 `var(--background)` 等引用即可自动适配明暗主题。

**文字可选**:面板里的 DOM 文字可以直接选中 → 滑词菜单弹出 → 引用到对话/存知识库。

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

**前四步不用手写** —— 仓库里的 `scripts/build-market.mjs` 全干了：

```bash
node scripts/build-market.mjs          # 打包 + 算 sha256 + 写 index.json
node scripts/build-market.mjs --out ./dist-market
```

它只打**运行时该带的**（`manifest` / `dist/` / `ui-dist/` / `assets/` / `PLUGIN.md`），
跳过 `src/ tests/ scripts/ vendor/ node_modules/` —— 对文件查看器来说这是 60 MB 和 900 MB 的差别。
打完把 `market-dist/` 传到哪儿都行，然后把 `_state.json` 的 `registry` 指过去。

想自己实现一遍，是这四步：

1. 打包插件目录为 zip
2. 计算 sha256（**索引里必须有，缺了会拒绝安装**）
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

### 做一个「连接器」插件

把外部业务系统（ERP / CRM / 工单）接进来，仓库里有个现成的脚手架：
**`templates/connector-plugin/`**。复制、把 `NAME` 全局替换成你的系统标识、改三处就好：

| 改哪 | 改什么 |
|---|---|
| `src/backend/index.ts` → `fetchRecords()` | 换成对你系统的 HTTP API 调用 |
| `src/backend/index.ts` → `toListItems()` | 把 API 记录映射成面板行 |
| `manifest.json` | id / 名称 / 权限 |

它和内置插件走**同一套** SDK 和同一套构建方式（`node scripts/build-backend.mjs`），
照着写不会踩旧坑。

## 图标规范

- 插件品牌图标:自带 SVG(单色,CSS mask 渲染随主题变色)
- 上架必须带品牌图标
- 面板图标:一个 `icon` 字段。写路径(`./assets/x.svg`)就是自带文件,写名字(`calendar`)就用系统图标
- 词汇表:puzzle / gear / globe / mail / calendar / todo / knowledge / erp / chat / eye / note / users / money / clock / sliders / layout

## 最佳实践

1. **状态放后端** — 面板是纯投影;面板关闭/重开不丢状态
2. **定时任务放后端** — 不放 UI(UI 随面板卸载);启动时补跑错过的触发
3. **带 PLUGIN.md** — 否则 agent 不知道这个插件能干什么,工具再全也不会被调用;
   `description` 写「什么时候用」而不是「这是什么」
4. **品牌图标必带** — 上架审核要求;单色 SVG,CSS mask 渲染
5. **权限最小化** — 只声明实际需要的权限
6. **一插件一 Rail 按钮** — 次要面板用 `hidden`,由主面板里的人自己打开
7. **错误处理** — capability 调用可能失败(权限/网络/文件),catch 并在面板中显示;
   工具返回值里把「不支持、别重试」说清楚,agent 才不会在那儿反复试错
