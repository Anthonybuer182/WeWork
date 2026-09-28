---
name: files
description: "查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——用户要打开这类文件，或要求修改演示文稿的文字、表格、排版、增删幻灯片时用它。改 pptx 用它的 office_read / office_edit 工具，不要另写 Python 或解压 OOXML 手改。"
---

# 文件中心

工作区里 Office 文档的查看器和编辑器。文件树里点开一个可预览文件，就是它在右栏渲染；
agent 通过它贡献的工具读写文档。

## 覆盖范围（先看这张表，别猜）

| 格式 | 面板预览 | agent 读写 |
|------|---------|-----------|
| `pptx` | ✅ Konva 渲染器 | ✅ **唯一接通读写的格式** |
| `docx` | ✅ 分页渲染器，可编辑 | ❌ 工具返回 "not wired yet" |
| `xlsx` `xls` `xlsm` `csv` `ods` | ✅ 表格渲染器（只读，公式显示缓存值） | ❌ 工具返回 "not wired yet" |
| `pdf` | ✅ | ❌ |
| `txt` `md` `markdown` `json` `log` `html` | ✅ | — |

> **`office_read` 和 `office_edit` 目前只认 `pptx`。** 拿别的扩展名去调，会拿到一句
> "not wired yet"。那不是报错也不是提示你换参数——是这条路径确实没接，**不要重试**，
> 直接告诉用户这个格式还不支持结构化编辑。

## 三个工具

### `office_read({ path })`

读一份 pptx 的结构，返回每张幻灯片和它上面的元素，**元素 id 就是 `office_edit` 的操作对象**。

先读后改。id 不要凭记忆或凭命名习惯推断——它是文档里的真实标识。

### `office_guide({ domain, group?, style? })`

op 的说明书。**写 ops 之前必须调一次。**

- 不带 `group`：返回按组分类的 op 名称表（6 个组：`text` / `element` / `insert` /
  `table` / `slide` / `deck`）
- 带 `group`：返回那一组的字段表、示例、以及常见错误
- `style: "signatures"`：每个 op 一行签名，想快速扫一遍完整签名表时用

**字段名靠猜是 batch 被拒的头号原因。** 这个工具就是用来消除猜测的。

### `office_edit({ path, ops, dryRun? })`

对文档应用一批 op 并保存。

- **整批原子**：任何一个 op 被拒，就什么都不写，并在 `failures` 里说明哪里要改。
  所以失败不会留下半改的状态——放心提交，按 `failures` 修完重来。
- `dryRun: true`：只校验并回一个执行计划，不碰文件。**不熟的 batch 先跑这个。**
- 写回带 mtime 冲突检测：如果文件在你读之后被外部改过，写入会被拒绝而不是覆盖。
  这时重新 `office_read` 再改。
- 返回里的 `details.opsAvailable` 用来发现你缓存的 op 列表已经过期。

## 改 pptx 的标准流程

1. `office_read` —— 拿到幻灯片和元素 id
2. 不确定字段名 → `office_guide`（先看组名，再进具体组）
3. `office_edit` + `dryRun: true` —— 先验证
4. `office_edit` —— 正式提交
5. 报 `failures` 时按提示改 op 重提，**不要**逐个 op 拆开试

## 边界

- 打印 / 导出 PDF / 另存为：宿主还没提供对应的对话框能力，调用会返回"未接入"。
- docx 的编辑走面板里的富文本编辑器，不走 agent 工具。
- 文档渲染跑的是内置的 GenOffice 引擎（Apache-2.0），不需要联网、不需要外部工具。
