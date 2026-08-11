# Pi Coding Agent Desktop

基于 Electron + React 的 AI 编程助手桌面应用，提供 Web 和桌面双端体验。

## 主要功能

- **AI 对话** — 多轮对话式编程助手，支持思考过程展示和工具调用可视化
- **工作空间管理** — 创建和管理多个项目工作空间
- **会话管理** — 支持会话分组、历史查看和会话切换
- **文件浏览** — 内置文件树，支持文件浏览和管理
- **文档预览** — 支持代码高亮、Markdown、PDF、Office 文档（.docx/.xlsx/.pptx）等格式预览
- **模型配置** — 支持多种 AI 提供商和模型选择，可自定义思考等级
- **斜杠命令** — 支持 `/help`、`/clear`、`/compact`、`/model`、`/config` 等命令
- **浏览器自动化** — 支持通过 AI 驱动浏览器进行网页操作，实现自动化浏览与交互

## 功能演示

### AI 编程助手

![Demo](./assets/demo.gif)

### 浏览器自动化

![Browser Automation](./assets/chrome.gif)

## 技术栈

| 类别 | 技术 |
|------|------|
| **桌面框架** | Electron + electron-vite |
| **前端框架** | React 19 + TypeScript |
| **Web 构建** | Vite |
| **UI** | Tailwind CSS + shadcn/ui (Radix) |
| **状态管理** | Zustand + TanStack React Query |
| **代码编辑器** | Monaco Editor |
| **文档预览** | PDF.js、Mammoth (.docx)、SheetJS (.xlsx) |
| **构建工具** | Turborepo + pnpm workspace |
| **AI SDK** | @earendil-works/pi-coding-agent |

## 架构概览

项目采用 monorepo 架构，桌面端和 Web 端共享同一套 UI 组件，仅传输层不同：

```
桌面端:  Renderer (React) ──IPC──▶ Main Process ──▶ SDK ──▶ AI Backend
Web 端:  Browser (React)   ──HTTP─▶ Vite API Proxy ──▶ SDK ──▶ AI Backend
```

```
pi-coding-agent-desktop/
├── apps/
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/main/     # 主进程 (窗口管理、IPC 处理)
│   │   ├── src/preload/  # 预加载脚本 (contextBridge)
│   │   └── src/renderer/ # 渲染进程 (React)
│   └── web/              # Web 应用
├── packages/
│   ├── sdk-wrapper/      # SDK 封装层 (IPC/HTTP 双传输)
│   ├── types/            # 共享类型定义
│   └── ui/               # 共享 UI 组件库 (布局、聊天、预览等)
├── pnpm-workspace.yaml
└── turbo.json
```

## 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动 Web 开发服务器 (localhost:5173)
# Web 端内置 API 代理，无需单独启动后端服务
pnpm dev:web

# 启动 Electron 桌面应用
pnpm dev:desktop
```

## 命令参考

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm dev:web` | 启动 Web 应用 (localhost:5173) |
| `pnpm dev:desktop` | 启动 Electron 桌面应用 |

### 构建与打包

| 命令 | 说明 |
|------|------|
| `pnpm build` | 构建所有子包 |
| `pnpm pack:mac` | 打包 macOS 应用 (.dmg) |
| `pnpm pack:win` | 打包 Windows 应用 (.exe) |
| `pnpm pack:linux` | 打包 Linux 应用 (AppImage) |
| `pnpm pack:all` | 打包全平台 |

打包产物输出在 `apps/desktop/release/` 目录。

### 代码质量

| 命令 | 说明 |
|------|------|
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 代码检查 |
| `pnpm format` | 代码格式化 (Prettier) |
| `pnpm clean` | 清理构建产物 |
