# 连接器插件脚手架

把业务系统(ERP/CRM/OA/工单)接入 pi 桌面端的最快路径。复制本目录,全局替换 `NAME` 为你的系统标识(如 `crm`),然后只改两个文件里的两处:

## 你需要写的代码

| 位置 | 改什么 |
|---|---|
| `dist/main.mjs` → `fetchRecords()` | 换成对目标系统 HTTP API 的调用 |
| `dist/main.mjs` → `toListItems()` / `toToolText()` | 把 API 记录映射成面板行 / agent 文本 |
| `manifest.json` | id/名称/工具 schema/权限 |

其余一切——面板渲染、工具路由、存储、生命周期、badge、Rail 注册——由框架处理。

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
# 开发模式(改完即生效,无需打包)
# 在 ~/.pi/agent/plugins.json 的 devPaths 里加入本目录的副本路径

# 打包上架(官方目录)
zip -r com.yourco.connector-crm-0.1.0.zip manifest.json dist/
# 提交到官方索引 index.json
```

## 参考

- 完整示例:`examples/plugins/com.pi.erp-demo/`(订单查询,mock 数据)
- 框架文档:仓库根目录设计文档的"连接器模式"章节
