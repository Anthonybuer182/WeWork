---
name: files
description: "查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——用户要打开这类文件，或要求修改演示文稿／Word 文档的文字、表格、排版、增删幻灯片时用它。改 pptx / docx / xlsx 都用它的 office_read / office_edit 工具，不要另写 Python 或解压 OOXML 手改；改 docx 前必须先在查看器里打开那个文档。"
---

# 文件中心

工作区里 Office 文档的查看器和编辑器。文件树里点开一个可预览文件，就是它在右栏渲染；
agent 通过它贡献的工具读写文档。

## 覆盖范围（先看这张表，别猜）

| 格式 | 面板预览 | agent 读写 |
|------|---------|-----------|
| `pptx` | ✅ Konva 渲染器 | ✅ 完整（命名 op，先 office_guide 拿词汇表） |
| `docx` `docm` | ✅ 分页渲染器，可编辑 | ✅ 结构编辑（**需先在查看器里打开该文档**，见下） |
| `xlsx` `xlsm` | ✅ 表格渲染器（只读，公式显示缓存值） | ✅ 单元格编辑（改值 / 清空；不支持公式、格式、增删表） |
| `xls` `csv` | ✅ 表格渲染器（只读） | ❌ 工具返回 "not wired yet" |
| `pdf` | ✅ | ❌ |
| `md` `markdown` | ✅ GenOffice 的 markdown 查看器 | — |
| `html` `htm` | ✅ GenOffice 的 html 查看器（图片暂不支持） | — |
| `txt` `json` `log` | ✅ GenOffice 的 Markdown 组件 | — |

> **`office_read` / `office_edit` 目前认 `pptx`、`docx` 和 `xlsx`。** 其它格式会拿到一句
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

**`domain: "xlsx"` 是另一回事**：表格没有 op 注册表，它的 op 就是单元格编辑。这个工具会
返回那条形状——`{ sheet, cell, value }`，`sheet` 和 `cell` 都来自 `office_read`。

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

## 改 docx 的标准流程

**前提：那份文档必须先在查看器里打开。** docx 的 op 驱动的是一个**活着的编辑器**
（GenOffice 自己的编辑器，它的内置 AI 也是这么工作的）—— 没有无头路径。
文档没开时 `office_edit` 会直接告诉你，不会静默失败。用 `files_probe_open` 打开。

1. `office_guide({ domain: "docx" })` —— 拿 op 形状、target 的写法和 op 列表
2. `office_read` —— 拿 block 下标（**下标会随任何一次编辑失效，别跨轮复用**）
3. `office_edit` + `dryRun: true` —— 先验证
4. `office_edit` —— 正式提交（改完自动保存）

op 形如 `{ op: "setFont", target: { scope: "selection" }, bold: true }`。
**`target.scope: "selection"` 正好接得上用户刚才选中的内容** —— 用户选了东西说"这段"，
就用它，比按 block 下标更稳。字段是**补丁**语义：给了就设、`null` 清空、不给就不动。

`dryRun` 只覆盖注册表 op；`insert_content` / `replace_blocks` 这两个整块命令没有 dry-run，
批里带它们时 `dryRun` 会被拒绝（而不是偷偷改文档）。

## 改 xlsx 的标准流程

1. `office_read` —— 拿到工作表名和单元格地址
2. `office_edit`，ops 形如 `{ sheet: "Sheet1", cell: "B2", value: 4321 }`
   （`value: null` 清空该格）
3. 不熟就先 `dryRun: true`，它会告诉你这批会动到哪些 xlsx 内部条目
4. 改完不必重读——返回里带 `mtime`，下次改动会拿它做冲突检测

**xlsx 目前只支持改单元格的值**：不支持公式、格式、增删工作表、图表、合并单元格。
遇到这些直接说"还不支持"，别换参数重试。

## 边界

- 打印 / 导出 PDF / 另存为：走宿主对话框能力（`dialog.*`）。
- **docx 的 op 要在查看器里开着那份文档才生效** —— 其余格式（pptx / xlsx）后端自己就能改。
- 改完立即落盘，并且带 mtime 冲突检测（读之后被外部改过就拒绝，不覆盖）。
- 文档渲染跑的是内置的 GenOffice 引擎（Apache-2.0），不需要联网、不需要外部工具。
