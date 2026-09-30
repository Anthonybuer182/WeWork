# 连接器插件脚手架

把业务系统(ERP/CRM/OA/工单)接入 pi 桌面端的最快路径。复制本目录,全局替换 `NAME` 为你的系统标识(如 `crm`)。

## 你需要写的代码

| 位置 | 改什么 |
|---|---|
| `src/backend/index.ts` → `fetchRecords()` | 换成对目标系统 HTTP API 的调用 |
| `src/backend/index.ts` → `toListItems()` / `toToolText()` | 把 API 记录映射成面板行 / agent 文本 |
| `manifest.json` | id/名称/工具 schema/权限 |
| `ui/index.html` | 面板长什么样(模板里已经能跑,按需改) |

其余一切——握手、能力调用、面板路由、存储、生命周期、badge、错误上报——由 **SDK** 处理。

> `dist/main.mjs` 是**构建产物**,不要直接改它——改 `src/`,然后重新构建:

```bash
npm install                 # 装 @pi/plugin-sdk 和 esbuild
node scripts/build-backend.mjs
node scripts/typecheck.mjs  # 可选
```

> **面板就是一张网页。** 宿主负责把它装进窗口(`manifest` 里那个 `entry` 指向它),
> 你用 `window.piSDK` 跟自己的后端说话,不需要知道宿主是怎么装的。
>
> 面板 id 也不用你管:SDK 会自动盖在每条消息上。

## 前置:插件身份与权限

```jsonc
// manifest.json
{
  "id": "com.yourco.connector-crm",
  "permissions": [
    "storage",                       // 插件私有存储
    "network:api.crm.example",       // 出站到目标 API 域名
    "secrets:crm"                    // 凭据保管箱命名空间
  ]
}
```

凭据流:插件首次运行时引导用户授权 → `storage` 存 token 或接入 `host.secrets`(系统钥匙串)→ API 调用带 `Authorization`。

## 工具即插即用

`contributes.tools` 里的 MCP JSON Schema 工具会自动注册进 agent 会话——用户对 agent 说"查一下上周的订单",agent 直接调 `crm_query`,结果回流到对话;面板和工具共享同一份 backend 状态。

## 安装与调试

```bash
# 开发模式:改完 src/ 就重新构建,然后把整个目录拷到用户插件目录
node scripts/build-backend.mjs
cp -r manifest.json dist ui ~/.pi/agent/plugins/com.yourco.connector-crm/
# 重启应用,或者从开发模式启动:node scripts/dev-plugin.mjs

# 打包上架
node ../../scripts/build-market.mjs   # 打包 + 算 sha256 + 写 index.json
```

（`build-market.mjs` 只打运行时该带的:manifest / dist / ui / assets / PLUGIN.md。）

## 参考

- 真实例子:`plugins/com.pi.mail/`——面板 + 工具 + 私有存储 + 出站权限齐全,是仓库里最接近连接器的一个
- 框架文档:`docs/plugin-dev-guide.md`
