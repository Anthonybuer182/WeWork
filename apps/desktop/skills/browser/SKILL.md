---
name: browser
description: Browse web pages, read content, fill forms, and take screenshots. Use when the user asks to visit a website, scrape content, or automate web interactions.
---

# pi-browser

Browser automation CLI for the Pi Coding Agent desktop app. Control the built-in browser (visible in the right panel) — navigate, click, fill forms, read content, screenshot.

## How it works

- The desktop app runs a local HTTP server on `127.0.0.1:19223`
- `pi-browser` CLI sends requests to this server
- The server drives the app's `<webview>` via Chrome DevTools Protocol
- Both agent and user see the **same browser instance** — all actions are visible in real time
- After `navigate`, the system automatically analyzes the page to classify its type and surface actionable elements

## Page Analysis (navigate output)

Every `navigate` command returns a `page` object that classifies the page and identifies actions:

```json
{
  "url": "https://open.weixin.qq.com/connect/oauth2/...",
  "title": "微信登录",
  "page": {
    "pageState": "gate",
    "elementCount": 3,
    "coreActions": [
      { "text": "登录", "risk": "low" },
      { "text": "微信账号登录", "risk": "low" }
    ],
    "hasForm": false,
    "summary": "Gate page with low-risk action(s): \"登录\", \"微信账号登录\". Safe to auto-click."
  }
}
```

### pageState values

| State | Meaning | Implication |
|-------|---------|-------------|
| `content` | Normal page with many interactive elements | Run `snapshot` to understand structure before acting |
| `gate` | Few elements (<=5), likely a login/auth/consent page | **Check `coreActions` for low-risk buttons and auto-click them** |
| `error` | Page shows error (404, access denied, etc.) | Check the content before proceeding |
| `empty` | No visible interactive elements | Page may be loading, or is a canvas/image-only page. Wait or use `--analyze` screenshot |

### coreActions and risk

The system extracts action-oriented buttons/links (login, sign in, agree, confirm, submit, etc.) and classifies them:

- **`risk: "low"`** — Safe to click automatically. Includes: login, sign in, register, agree, accept, confirm, submit, authorize, enter, continue, next, start, verify. These are standard gate/authorization actions.
- **`risk: "high"`** — Requires user confirmation. Includes: delete, remove, pay, purchase, subscribe, unsubscribe.

**CRITICAL: When `pageState` is `"gate"` and `coreActions` contains `risk: "low"` actions, you MUST auto-click them by following this workflow:**

```bash
# 1. Navigate — page analysis tells you what to do
pi-browser navigate https://example.com

# Output will contain page.pageState: "gate" with coreActions.
# If summary says "Safe to auto-click", proceed immediately:

# 2. Snapshot to get ref IDs for the action buttons
pi-browser snapshot

# 3. Click the low-risk action button (use text selector if available, or find the ref ID from snapshot)
pi-browser click 'text="登录"'
# Or: pi-browser click [1]  (if [1] is the login button in snapshot)

# 4. After the gate action, navigate may redirect. Re-snapshot to see the new page.
pi-browser snapshot
```

**Why this works for any platform:** The detection is based on page structure (element count, button text patterns), not platform-specific URLs. It works for WeChat, DingTalk, Xiaohongshu, Feishu, or any OAuth/provider login flow.

## Quick Start: Universal Goal-Based Navigation

**The `walk` command is the universal navigation tool.** You specify the GOAL, the system figures out the path — works on ANY platform (WeChat, DingTalk, Feishu, Xiaohongshu, Douyin, etc.).

```bash
# 1. Navigate to the page (gates auto-handled)
pi-browser navigate https://platform.com

# 2. Walk to your goal — VLM analyzes screenshot, plans path, executes clicks
pi-browser walk "article editor"
# → VLM looks at the page, sees "Content → Drafts → New → Article", clicks each one
# → Returns: { reached: true, url: ".../editor", steps: [{action:"Content",...}, ...] }

# 3. Now you're on the target page — interact normally
pi-browser fill 'input[name="title"]' 'My Article'
```

**Why `walk` is universal:**
- You say **what** you want ("article editor"), not **how** to get there ("click 内容管理")
- VLM reads the actual UI text from the screenshot — works in any language
- No platform-specific code — same command on WeChat, DingTalk, Feishu, any site
- Fallback: if VLM is unavailable, uses keyword-based `find` search as backup

**When to use each tool:**

| Tool | Use for | Example |
|------|---------|---------|
| `walk` | **Goal-based navigation** — "get me to X" | `pi-browser walk "article editor"` |
| `find` | **Finding specific elements by intent** | `pi-browser find "drafts"` |
| `snapshot --structured` | Understanding full page layout by section | `pi-browser snapshot --structured` |
| `snapshot` | Capturing all interactive elements (flat list) | `pi-browser snapshot` |
| `click 'text="..."'` | Clicking a known element label | `pi-browser click 'text="Save"'` |

## Goal-Based Navigation with `walk`

The `walk` command uses VLM (visual language model) to plan navigation paths from the current page:

```bash
# Universal: works on any platform, any language
pi-browser walk "create a new draft article"
pi-browser walk "user settings page"
pi-browser walk "order management dashboard"
```

**How it works internally:**
1. Takes a screenshot of the current page
2. Sends screenshot + goal to VLM: "What elements should I click to reach this goal?"
3. VLM returns a path like `["Content", "Drafts", "New Article"]` (actual UI text from screenshot)
4. Executes each step: `find` → `click` → wait for page transition
5. Stops when goal is reached or no more steps

**Fallback: when VLM is unavailable**, `walk` uses keyword-based `find` to search for goal-related elements and clicks the best match. This is less reliable than VLM but still works as a heuristic.

**When `walk` doesn't reach the goal:** it returns `{ reached: false }` with the steps it did take and the current URL. Use `snapshot --structured` to inspect the page and continue manually.

## Semantic Search with `find`
| `snapshot --structured` | Understanding full page layout by section | `pi-browser snapshot --structured` |
| `snapshot` | Capturing all interactive elements (flat list) | `pi-browser snapshot` |
| `screenshot --analyze` | Visual-only pages (canvas, CAPTCHA) | `pi-browser screenshot --analyze` |

## Semantic Search with `find`

Use `find` when you know what kind of element you're looking for but don't know its exact text label. It searches all visible interactive elements and returns scored matches:

```bash
# Find by intent (NOT platform-specific text)
pi-browser find "drafts"           # Matches "Drafts", "草稿箱", "Draft List", etc.
pi-browser find "settings"         # Matches "Settings", "设置", "Einstellungen", etc.
pi-browser find "create new"       # Matches "New", "Create", "新建", "Create New", etc.
pi-browser find "search box"       # Matches search inputs by intent

# Use matched text to click
pi-browser find "drafts"
# {"matches":[{"score":50,"role":"link","text":"草稿箱","section":"sidebar"}]}
pi-browser click 'text="草稿箱"'
```

Results are sorted by match score (higher = better match) and include:
- `score`: relevance score (0-100+)
- `role`: element role (link, button, textbox, etc.)
- `text`: element text content
- `section`: which page section the element is in (sidebar, header, main, footer)

**Use the matched text to click:**
```bash
pi-browser find "草稿箱"
# Result: {"matches":[{"score":50,"role":"link","text":"草稿箱","section":"sidebar"}]}
pi-browser click 'text="草稿箱"'
```

## Structured Snapshots

Use `--structured` to group elements by page section, making it easy to understand page layout at a glance:

```bash
pi-browser snapshot --structured
```

Output:
```
=== Page: Dashboard | H1: Welcome ===

--- Sidebar Navigation (12 items) ---
[1] link "首页"
[2] link "内容管理"
[3] link "草稿箱"
[4] link "素材管理"
...

--- Header (4 items) ---
[13] link "通知"
[14] button "账号"
...

--- Main Content (25 items) ---
[17] button "新的创作"
[18] link "Article Title 1"
[19] link "Article Title 2"
...

--- Floating Layer: dialog ("create-menu") ---
[42] option "写新图文"
[43] option "转载文章"
```

When the `--structured` flag can't detect sections, it falls back to the standard flat snapshot format. Use `find` as the primary tool and `snapshot --structured` when you need the full layout.

## Commands

### Navigation & Reading

```bash
# Navigate to a URL
pi-browser navigate https://example.com

# Get the current URL and page title
pi-browser url

# Search for elements by semantic description (PRIMARY way to find elements)
pi-browser find "drafts"
pi-browser find "new article"
pi-browser find "草稿箱"

# Get interactive elements tree with ref IDs
pi-browser snapshot

# Get structured snapshot grouped by page section (sidebar, header, main, footer)
pi-browser snapshot --structured

# Get text content of the entire page
pi-browser text

# Get text content of a specific element
pi-browser text [3]
pi-browser text 'button:has-text("Save")'

# Get an attribute value of an element
pi-browser attribute [3] href
pi-browser attribute 'a:has-text("Docs")' href

# Take a screenshot (returns base64, or save to file)
pi-browser screenshot
pi-browser screenshot --output /tmp/page.png
pi-browser screenshot --fullpage

# Take a screenshot with VLM-powered text description (for CAPTCHA, canvas apps, etc.)
pi-browser screenshot --analyze
pi-browser screenshot --fullpage --analyze

# Scroll the page
pi-browser scroll down 500
pi-browser scroll up 300

# Evaluate JavaScript in the page context
pi-browser evaluate "document.title"
pi-browser evaluate "document.querySelectorAll('a').length"
```

### Interaction

```bash
# Click an element — supports [N] refs, text selectors, CSS
pi-browser click [3]
pi-browser click 'button:has-text("Login")'
pi-browser click 'text="Sign In"'
pi-browser click 'role=button[name="Submit"]'
pi-browser click '[data-testid="submit-btn"]'

# Fill an input field
pi-browser fill [5] 'user@example.com'
pi-browser fill 'input[name="email"]' 'user@example.com'
pi-browser fill '#search-box' 'cats'

# Hover over an element (triggers hover menus, tooltips)
pi-browser hover [3]
pi-browser hover 'nav a:has-text("Products")'

# Select an option in a <select> dropdown
pi-browser select [7] 'United States'
pi-browser select 'select[name="country"]' 'US'

# Type text into an autocomplete/search field, wait for suggestions, then select matching option
pi-browser type_and_select [5] 'keyword' 'Option Text Match'
pi-browser type_and_select 'input[name="recipient"]' '张' '张三'

# Click a button to open a popup, then select an option from the popup (universal popup handler)
pi-browser click_and_select [3] 'Option Text'
pi-browser click_and_select 'button:has-text("Select")' 'Target Option' 3000

# Press a keyboard key (real CDP keyboard input — works with React/Vue)
pi-browser press Enter
pi-browser press Tab
pi-browser press Escape
pi-browser press ArrowDown
pi-browser press ArrowUp

# Wait for an element to appear (default timeout 10s)
pi-browser wait '[data-testid="results"]'
pi-browser wait 'div.loading' 5000
```

### Handling Dynamic Elements: Dropdowns, Autocomplete, Modals

Web pages often show elements dynamically — suggestion dropdowns after typing, modals after clicking, tooltips on hover. These elements appear AFTER the initial snapshot. Use these patterns:

**Pattern 1: `type_and_select` (recommended for autocomplete)**

Single command for the full flow: type → wait for dropdown → click matching option.

```bash
pi-browser type_and_select [3] 'zhang' '张三'
# Output: {"selector":"[3]","typed":"zhang","matched":"张三 - zhangsan@qq.com","selected":true}
```

This internally:
1. Focuses and clears the input
2. Types the text character by character (triggers React onChange properly)
3. Waits for suggestion dropdown to appear
4. Scans floating layers for matching option text
5. Clicks the matched option

**Pattern 2: Re-snapshot after typing (manual control)**

After typing in an input field, ALWAYS re-snapshot to capture dynamically appeared dropdown options.

```bash
pi-browser fill [1] 'zhang'
pi-browser snapshot           # ← RE-SNAPSHOT after typing!
# Output will include floating layer section:
# --- Floating Layer: listbox ("recipient-suggest") ---
# [12] option "张三 - zhangsan@qq.com"
# [13] option "张四 - zhangsi@aliyun.com"

pi-browser click [12]          # Click the desired option
```

**Pattern 3: Keyboard navigation**

For dropdowns that support arrow key navigation:

```bash
pi-browser fill [1] 'keyword'
pi-browser press ArrowDown    # Select first suggestion
pi-browser press ArrowDown    # Move to next
pi-browser press Enter        # Confirm selection
```

**Pattern 4: Handling modals/dialogs**

After an action that opens a modal, re-snapshot. Modal elements appear in a separate "Floating Layer" section.

```bash
pi-browser click [5]           # Click "Add User" button
pi-browser snapshot            # ← RE-SNAPSHOT to see modal
# --- Floating Layer: dialog ("user-modal") ---
# [20] textbox "Name"
# [21] button "Save"
# [22] button "Cancel"

pi-browser fill [20] 'John'
pi-browser click [21]          # Save in modal
```

**Pattern 5: `click_and_select` for popup selections (recommended for popup menus)**

Single compound command: click trigger → wait for popup → find and click matching option. Works universally across all popup types.

```bash
pi-browser click_and_select [3] 'Option Text'
# Output: {"trigger":"[3]","matched":"Option Text","selected":true}
```

This internally:
1. Clicks the trigger element (button, dropdown toggle, etc.)
2. Waits for the popup to appear (default 2s, configurable)
3. Auto-detects floating containers by z-index, position, ARIA role, and class patterns
4. Searches within containers for the matching option using text substring match
5. Dispatches DOM events + native click on the matched element

This works for **any** popup pattern because it auto-detects containers rather than relying on platform-specific selectors:
- Custom dropdown menus (div-based, not `<select>`)
- Role-based pickers (date, color, emoji)
- Modal dialogs with selectable options
- Ant Design / Element UI / Bootstrap / Tailwind popup menus
- WeChat / DingTalk / Feishu admin panel popups
- Any dynamically appearing floating layer

When the popup content is complex or `click_and_select` can't find the option:
```bash
pi-browser click [3]           # Click trigger
pi-browser wait 2000            # Wait for popup
pi-browser snapshot             # Re-snapshot to see popup elements
pi-browser click [12]           # Click via ref ID (most reliable)
```

## Selectors

Multiple selector formats are supported. **Use ref IDs from snapshot whenever possible** — they're the most reliable.

| Priority | Format | Example | When to use |
|----------|--------|---------|-------------|
| **1** (best) | `[N]` ref ID | `[3]` | From `snapshot` output — always works |
| **2** | `text="..."` | `text="Sign In"` | Find element by exact text |
| **3** | `:has-text()` | `button:has-text("Save")` | CSS tag + text match |
| **4** | `role=` | `role=button[name="Submit"]` | ARIA-compliant pages |
| **5** | `data-testid` | `[data-testid="login-btn"]` | Stable test attributes |
| **6** | `name=` | `input[name="email"]` | Form fields |
| **7** | `aria-label` | `[aria-label="Search"]` | Icon buttons |
| **8** (fallback) | CSS | `#id`, `.class`, `div > a:first-child` | Last resort — most fragile |

### Selector Tips

- **Always run `snapshot` first** to see what elements are available and their ref IDs
- **Quote selectors** in the shell to avoid glob expansion
- Ref IDs (`[N]`) are only valid until the page navigates — after navigation, run `snapshot` again
- All interaction commands **auto-wait** up to 5 seconds for the element to appear
- If an element is not found, the error message suggests similar elements

## Snapshot Output Format

The snapshot now detects and groups elements by **visual layer** and **state**:

```
--- Interactive Elements (Main Page) ---
Page: Example Site | H1: Welcome
[1] link "Home" [href=/]
[2] link "Products" [href=/products]
[3] button "Search" [disabled, aria-label="Search"]
[4] button "Submit" [below-fold]
[5] textbox "Email" [type=email, readonly]

--- Floating Layer: listbox ("search-suggestions") ---
[6] option "Result 1 - Description"
[7] option "Result 2 - Description"

--- Alerts & Notifications ---
[alert-alert] "Password must be at least 8 characters"
```

Each line shows: `[ref]` `role` `"accessible name"` `[attributes]`

**State flags in the snapshot:**
- `disabled` — element is not interactable (button greyed out, input locked)
- `readonly` — input is read-only (can read value but cannot edit)
- `loading` — element is in a loading/spinning state
- `checked` — checkbox or radio is selected
- `below-fold` — element requires scrolling to reach
- Alerts/notifications appear in their own section, including form validation errors

Floating layers (dropdowns, modals, popups) are automatically detected and shown in separate sections. Re-run `snapshot` after interactions that trigger dynamic UI changes to see these layers.

## Screenshot with Visual Analysis

You can request a VLM-powered text description of the current page alongside the screenshot:

```bash
pi-browser "GET /screenshot?analyze=true"
```

This returns:
- `screenshot`: base64 PNG image
- `description`: text description of the page layout, key elements, visual state, and any obstructions
- `snapshot`: current interactive elements tree

Use this when:
- The snapshot is empty or has very few elements (< 3) suggesting a canvas/SPA app
- You encounter a CAPTCHA or visual verification challenge
- You need to understand why elements are positioned strangely (overlapping modals, cookie banners)
- You've tried an action and it failed — the error response already includes automatic visual analysis

## Automatic Visual Analysis on Failures

When an interaction command (click, fill, hover, select, type-and-select, click-and-select) **fails**, the system automatically:
1. Takes a screenshot of the current page
2. Runs VLM analysis to understand why the action failed
3. Appends the visual analysis + current snapshot to the error message

This means you don't need to explicitly request a screenshot after a failure — the context is already included in the error. The visual analysis describes:
- What blocked the element (overlays, popups, cookie banners)
- Whether the page changed (redirected, loaded new content)
- What you should try instead

## Best Practices

1. **Navigate first** — `pi-browser navigate <url>` before any other command
2. **Check page analysis** — `navigate` output includes `page.pageState` and `coreActions`. Read the `summary` field.
3. **Auto-click gate pages** — If `pageState` is `"gate"` with low-risk `coreActions`, the system auto-clicks them in `navigate()`. No manual action needed.
4. **Use `walk` for goal-based navigation** — `pi-browser walk "article editor"` works on ANY platform. Specify the GOAL, not the path. This is the universal solution.
5. **Use `find` when you know what kind of element you want** — `pi-browser find "drafts"` searches semantically across all elements. It works cross-language — "drafts" matches "草稿箱".
6. **Click by text after find** — `pi-browser click 'text="草稿箱"'` is the most reliable click method. Text labels are stable across DOM changes.
7. **Use `snapshot --structured` for page layout** — groups elements by section (sidebar, header, main, footer).
8. **Re-snapshot after interactions** — after typing, clicking, or opening modals, run `snapshot` again to capture dynamically appeared elements
9. **Check element state** — the snapshot shows `disabled`, `readonly`, `loading`, `checked`, and `below-fold` flags. Don't try to interact with disabled or readonly elements
10. **Watch for alerts** — the snapshot includes an "Alerts & Notifications" section for error messages and validation feedback
11. **Use `type_and_select` for autocomplete** — it handles the full flow in one command
12. **Use `click_and_select` for popups** — click trigger, wait for popup, select option in one command
13. **Quote all selectors** — shell-special characters must be quoted
14. **One action per command** — don't chain multiple actions in one CLI call
15. **Failed actions include automatic analysis** — when click/fill/hover fail, the error already includes a visual analysis of why; read it before retrying
16. **Don't guess URL patterns** — URLs vary between platforms. Use `walk` or `find`+`click` to navigate by page structure, never by constructing URLs.

## Navigation Strategy

**CRITICAL**: Never guess URLs. Use `walk` or `find` + `click` to navigate by page structure.

```
WRONG:  pi-browser navigate https://platform.com/admin/edit?id=123
RIGHT:  pi-browser walk "article editor"
        # OR (if no VLM):
        pi-browser find "drafts"                    ← semantic search for target
        pi-browser click 'text="草稿箱"'            ← click by matched text
```

Why guessing URLs fails:
- Session tokens are embedded in URLs and change frequently
- URL structures differ between accounts, languages, versions
- You end up on wrong pages (login, error, redirect loops)

**The universal navigation workflow:**

1. **Navigate to root** — `pi-browser navigate https://platform.com`
2. **Walk to the goal** — `pi-browser walk "article editor"` (preferred, universal)
3. **If walk is unavailable** — use `find` + `click` pairs for each step
4. **If you get stuck** — `pi-browser snapshot --structured` to see full page layout

**Mental model**: You specify the GOAL, the system finds the path. Don't try to navigate by guessing element names or URL patterns.

## Session Expiry & Login Recovery

When a session expires mid-workflow, `navigate()` detects gate pages (login/auth) and **automatically clicks low-risk action buttons** (login, confirm, agree). This means:

- **If redirected to login**: `navigate()` auto-clicks the login button
- **If login requires QR code/scanning**: The gate persists after auto-click → take a screenshot with `--analyze` to understand what's needed
- **If login has a form (username/password)**: Fill credentials manually

However, some gate pages (like WeChat QR code, CAPTCHA) require user action even after auto-click:

```bash
# After navigate() auto-clicked the login button but gate persists:
pi-browser screenshot --analyze     # VLM describes the QR code/CAPTCHA
# → Tell user: "Please scan the QR code to continue. I'll wait."
pi-browser wait '[data-testid="dashboard"]' 30000  # Wait for login to complete
pi-browser snapshot                                 # Verify logged in
```

## Typical Workflow

```bash
# 1. Navigate — gate pages are auto-handled (login, authorization, etc.)
pi-browser navigate https://platform.com
# Output: {"url":"https://platform.com/dashboard","title":"Dashboard","page":{"pageState":"content",...}}

# 2. Walk to the goal — system plans the path from screenshot, executes it
pi-browser walk "article editor"
# VLM sees the UI layout, finds: Sidebar "Content" → "Drafts" → "New Article" button
# Returns: { reached: true, steps: [{action:"Content",...}, {action:"Drafts",...}, {action:"New Article",...}] }

# 3. If walk didn't reach the goal (reached: false), inspect and continue manually
pi-browser snapshot --structured

# 4. Now on the target page — fill content
pi-browser fill 'input[name="title"]' 'My Article'
pi-browser fill 'textarea' 'Article content...'

# 5. Use find for specific actions
pi-browser find "save"
pi-browser click 'text="Save draft"'
```

**Without VLM (fallback workflow):**
```bash
pi-browser navigate https://platform.com
pi-browser find "drafts"                       # Semantic search
pi-browser click 'text="草稿箱"'               # Click matched text
pi-browser snapshot                             # See what changed
pi-browser find "new"                          # Find next action
pi-browser click 'text="New Article"'
```

## Notes

- The browser must be open in the right panel of the desktop app
- All commands return JSON on stdout (except `snapshot` and `text` which return plain text)
- Errors are written to stderr with exit code 1
- The server only listens on `127.0.0.1` — no external access
- All interaction commands (click, fill, hover, select) auto-wait up to 5s for the element
