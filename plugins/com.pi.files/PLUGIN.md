---
name: files
description: "查看和编辑 Office 文档（docx / pptx / xlsx / pdf）——用户要打开这类文件，或要求修改演示文稿／Word 文档的文字、表格、排版、增删幻灯片时用它；用户只说得出文档大概是什么（「上次那份季度汇报」）而没给路径时，也用它找。改 pptx / docx / xlsx 都用它的 office_read / office_edit 工具，不要另写 Python 或解压 OOXML 手改；改 docx 前必须先在查看器里打开那个文档。"
---

# 文件查看器

工作区文件的查看器（右栏）和 Office 文档的编辑器。文件树里点开一个文件，就是它在右栏渲染：
Office / PDF 走内置的 GenOffice 引擎，markdown / html 走 GenOffice 的查看器，txt / json / log 是纯文本视图。
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
| `txt` `json` `log` | ✅ 纯文本视图（等宽；json 美化） | — |
| `png` `jpg` `gif` `webp` `svg` 等 | ✅ 图片查看器（适应 / 1:1 / 缩放 / 拖动） | — |
| `mp4` `webm` `mov` `m4v` | ✅ 视频播放（系统内核解码；HEVC 等编码可能放不了） | — |
| `mp3` `m4a` `wav` `flac` `ogg` `aac` | ✅ 音频播放 | — |
| `mkv` `avi` 等 | ❌ 交给系统播放器 | — |
| `doc` `ppt`（97-2003 旧格式） | ✅ 仅文字（提取正文；排版、图片、表格不还原） | ❌ 不支持；要改就先另存为 docx/pptx |

> **`office_read` / `office_edit` 目前认 `pptx`、`docx` 和 `xlsx`。** 其它格式会拿到一句
> "not wired yet"。那不是报错也不是提示你换参数——是这条路径确实没接，**不要重试**，
> 直接告诉用户这个格式还不支持结构化编辑。

## 先找文件：`files_search({ root, query })`

用户只说得出文档是什么、没给路径时（「上次那份季度汇报」「客户发来的方案」），**先调它**，
不要用 `ls` 猜，也不要挨个 `office_read`——后者会把每份文档的结构都读进上下文。

**它只管 Office 文档（含 doc / ppt 旧格式）和 PDF。** md / txt / csv 和代码是纯文本，**用 `grep` 搜**（全文、带行号），
不要用 `files_search` 找它们，也不要指望它把文本文件列出来。

- `root`：当前工作区目录（绝对路径，通常就是 cwd）
- `query`：按文件名、目录名、**文档标题**、**正文开头的一段文字**匹配，多个词要全部命中；
  传关键词，不要传用户整句（`"华东 预算"`，不是 `"帮我找那份提过华东预算的文件"`）；
  不传就是最近修改的若干份
- 返回：绝对路径、类型、修改时间、标题；如果命中的是正文，会多带一行命中片段

它的行为：

- 正文是**抠出来的原文**（docx 开头几段、pptx 按页顺序的文字、xlsx 的文本单元格），
  最多存 1500 字，不是模型写的摘要。
  所以搜「华东区预算」能找到正文里提过这句话的文档，哪怕标题里没有。
- 每次查询都会重新核对文件。你在 Word/Excel 里改过一份、存盘，下一次查询就会重新读它的标题和正文；
  被删掉的文件会从结果里消失。
- 索引只回答「哪份文件」，**不回答「里面是什么」**。选中之后：Office 文档（docx/pptx/xlsx）
  用 `office_read` 打开，md / txt / csv 用 `read` 工具打开；**PDF 目前只能打开查看器看，正文读不了**，
  不要对 PDF 调 `office_read` 或 `read` 指望拿到内容。
- 只覆盖 docx/docm/pptx/pptm/xlsx/xlsm、doc/ppt 的内容，pdf 只有标题；md/txt/csv 和代码不进来，走 `grep`。
  搜不到时换个词或去看目录，不要断言文件不存在。

## 文档工具（office_*）

### `office_read({ path })`

读一份 pptx 的结构，返回每张幻灯片和它上面的元素，**元素 id 就是 `office_edit` 的操作对象**。

先读后改。id 不要凭记忆或凭命名习惯推断——它是文档里的真实标识。

### `office_guide({ domain, group?, style? })`

op 的说明书。**写 ops 之前必须调一次。**

- 不带 `group`：返回按组分类的 op 名称表（6 个组：`text` / `element` / `insert` /
  `table` / `slide` / `deck`）
- 带 `group`：返回那一组的字段表、示例、以及常见错误；组名写错时返回有效组名列表，
  按它改重试即可
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
