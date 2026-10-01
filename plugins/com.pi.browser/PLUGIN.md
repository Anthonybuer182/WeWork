---
name: browser
description: "打开网页并操作页面——用户给了一个链接要你看、要你查在线信息、要在网页上点击/填表/登录/下单，或任务需要先打开某个网页时用它。"
---

# 浏览器自动化

宿主内嵌了一个浏览器，你操作的就是它。**本插件不提供面板** —— 那块显示页面的面板是宿主自带的
「浏览器」，里面有一条工具栏（后退 / 前进 / 刷新 / 地址栏）。你开页面、读页面、点按钮、填表单，
用户在面板里看到的一直是你操作的这个页面。

## 标准操作循环

```
browser_navigate → browser_get_state → browser_click / browser_fill → browser_get_state 验证
```

`browser_get_state` 返回页面**可交互元素快照**（按钮 / 链接 / 输入框，各带一个 ref）。
操作优先用快照里的 ref（如 `"[12]"`），找不到再用文字或 CSS。

## 工具一览

| 工具 | 干什么 |
|---|---|
| `browser_navigate({ url })` | 打开网址并等加载完，返回最终地址和标题。没写协议自动补 `https://` |
| `browser_get_state()` | 当前地址、标题 + 可交互元素快照（ref 可直接当选择器用） |
| `browser_find({ query })` | 按文字模糊找元素（带匹配度和分区），快照被截断或要精确定位时用 |
| `browser_click({ selector })` | 点击。等元素出现（最多 5s）、滚到可见再点；失败时会给出相似元素建议 |
| `browser_fill({ selector, value })` | 填输入框（替换现有内容），对 React/Vue 受控组件有效 |
| `browser_hover({ selector })` | 悬停——只展开 hover 菜单 / 气泡提示用 |
| `browser_select({ selector, value })` | 下拉框按 value 或可见文本选中 |
| `browser_scroll({ direction?, amount? })` | 上下滚动，默认向下 500px |
| `browser_evaluate({ expression })` | 在页面上下文执行 JS 并返回结果。读快照表达不了的**计算出来的**数据时用 |
| `browser_walk({ goal, maxSteps? })` | 按目标自动导航（如「进入个人设置页」）：自己看截图规划点击路径并执行。需要配置了视觉模型；失败时退化为关键词匹配 |
| `browser_screenshot({ fullPage? })` | 截图，返回真正的 PNG 图片 |

## 选择器格式

`browser_click` / `browser_fill` / `browser_hover` / `browser_select` 共用一套：

- `[12]` —— 快照 / `browser_find` 给出的 ref（**首选**）
- `text="登录"` —— 按可见文字
- `role=button[name="提交"]` —— 按 ARIA 角色
- 标准 CSS —— 最后手段，站点改版就失效

## 看页面内容的两条路

1. **`browser_get_state`** —— 要"页面上有什么、能点什么"就用它，文字快照，便宜
2. **`browser_screenshot`** —— 要看排版、图表、图片、验证码这类**视觉**信息才用；
   截图占上下文，别没事整页截。页面很长就配合 `browser_scroll` 分段看

## 边界

- 页面在**内嵌的浏览器**里打开，不是系统浏览器。整个应用只有一个浏览器，
  你打开的和用户在「浏览器」面板里看到的是**同一个页面**——你导航，用户那边跟着变；反过来也一样。
  切走面板再回来，页面还在（浏览器本身一直活着）。
- 有些站点会检测自动化环境或需要登录，可能打不开或显示不全；截出来什么样就说什么，别猜。
- `browser_evaluate` 是页面里的明牌 JS，站点看得见。**不要用它绕过站点的反自动化措施**——
  绕不过去就如实告诉用户。
- `browser_walk` 依赖视觉模型配置；没配会直接报错，退回 `get_state → find → click` 手动走。
