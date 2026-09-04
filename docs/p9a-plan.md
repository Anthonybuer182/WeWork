# P9a — 全插件化内核能力(文件数据通道)

宿主不渲染任何业务内容;预览/编辑全部走插件。本阶段补齐三个数据通道能力,并用
`com.pi.files` 骨架插件端到端验证。

## 交付物

1. **`filesystem.write` capability**(权限 `filesystem`)
   - `{ path, content, expectedMtime? }` → 写回 + 返回新 mtime
   - mtime 冲突检测:外部已修改 → 明确错误(防覆盖)
2. **协议文件服务**(protocol.ts 保留路径,与 `__pi_sdk.js` 同级)
   - `pi-plugin://<id>/ws-file?path=<abs>` → 工作区文件原始字节
     - 权限:该插件 manifest 必须声明 `filesystem`
     - HTTP Range 支持(206/Content-Range)— 视频/大文件流式
   - `pi-plugin://<id>/memory/<name>` → 用户上传的内存文件
     - 主进程注册表 + 注册/清除 IPC(LRU 上限)
3. **find-preview 路由优先级**:dev > user > builtin(第三方竞争接管)
4. **`com.pi.files` 骨架插件**(dev 根):
   - filesystem 权限 + 哨兵扩展 `p9probe` 的 filePreview 声明
   - 工具 `files_probe_write` / `files_probe_read`(验证 capability)
   - iframe 面板:fetch ws-file / memory-file 渲染(验证协议)
5. **验收脚本 `scripts/verify-p9a-plugin.mjs`**

## 非目标(P9b/P9c)
- Monaco/pdf.js/officecli 引擎接入 → P9b
- 宿主 document/ 退役、路由无匹配 → 系统打开 → P9c
