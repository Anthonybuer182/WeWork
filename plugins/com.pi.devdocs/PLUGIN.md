# com.pi.devdocs — 插件开发文档(纯 UI 插件)

给第三方开发者在客户端内阅读的插件开发文档。**它本身就是一个最小的纯 UI 插件**:
manifest.json + 一张静态网页,没有 backend、没有工具、没有构建步骤 — 面板就是一张网页。

## 文档来源(单一事实源)

正文是仓库的 `docs/plugin-dev-guide.md`,由脚本同步进面板:

```bash
node scripts/sync-devdocs.mjs
```

该脚本同时把 marked(markdown 渲染,MIT)从 workspace 依赖拷到 `ui/lib/`。
**不要直接改 `ui/docs/` 下的文件** — 下一次同步会覆盖。

## 发布流程

改完 `docs/plugin-dev-guide.md` 后:

1. `node scripts/sync-devdocs.mjs`
2. bump `manifest.json` 的 `version`
3. `node scripts/build-market.mjs` — 装了旧版的客户端会在插件中心看到「可更新」

## 新增一篇文档

1. 仓库 `docs/` 下写好 md
2. `ui/app.js` 的 `DOCS` 目录加一项
3. `scripts/sync-devdocs.mjs` 的同步清单加一行
4. 走上面的发布流程
