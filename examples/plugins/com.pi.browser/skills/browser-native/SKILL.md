---
name: browser-native
description: 原生浏览器自动化工具(browser_navigate / browser_get_state / browser_screenshot),由 com.pi.browser 插件提供
---

# 浏览器自动化(原生工具)

你可以通过内置浏览器访问网页。三个原生工具直接可用,无需 shell:

## 工具

- **browser_navigate** — 打开网址并等待加载完成,返回最终 URL 和页面标题。
  参数:`{ "url": "https://example.com" }`
- **browser_get_state** — 获取当前页面的 URL 和标题。
- **browser_screenshot** — 截取当前页面截图(base64 PNG),适合需要"看"页面的场景。
  参数:`{ "fullPage": true }`(可选,整页截图)

## 使用建议

1. 先 `browser_navigate` 打开目标页面;
2. 需要了解页面内容时优先用 `browser_screenshot` 直接观察;
3. 需要确认当前页面时用 `browser_get_state`;
4. 用户可以在右侧"浏览器"面板中实时看到你访问的页面。

## 示例

打开一个网站并截图查看:

```
browser_navigate({ "url": "https://news.ycombinator.com" })
browser_screenshot({})
```
