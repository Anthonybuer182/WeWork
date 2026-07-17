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

## Quick Start: The 3-Step Workflow

**Always follow this pattern for browser automation:**

```bash
# 1. Navigate to the page
pi-browser navigate https://example.com

# 2. Get the interactive elements snapshot (shows ref IDs)
pi-browser snapshot

# 3. Use the ref ID to click/fill — most reliable
pi-browser click [3]
pi-browser fill [5] 'user@example.com'
```

## Commands

### Navigation & Reading

```bash
# Navigate to a URL
pi-browser navigate https://example.com

# Get the current URL and page title
pi-browser url

# Get interactive elements tree with ref IDs (PRIMARY way to understand the page)
pi-browser snapshot

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

When an interaction command (click, fill, hover, select, type-and-select) **fails**, the system automatically:
1. Takes a screenshot of the current page
2. Runs VLM analysis to understand why the action failed
3. Appends the visual analysis + current snapshot to the error message

This means you don't need to explicitly request a screenshot after a failure — the context is already included in the error. The visual analysis describes:
- What blocked the element (overlays, popups, cookie banners)
- Whether the page changed (redirected, loaded new content)
- What you should try instead

## Best Practices

1. **Navigate first** — `pi-browser navigate <url>` before any other command
2. **Snapshot before acting** — run `pi-browser snapshot` to see the page structure and ref IDs
3. **Use ref IDs** — `click [3]` is more reliable than any CSS selector
4. **Re-snapshot after interactions** — after typing in inputs, clicking buttons that trigger UI changes, or opening modals, run `snapshot` again to capture dynamically appeared elements
5. **Check element state** — the snapshot shows `disabled`, `readonly`, `loading`, `checked`, and `below-fold` flags. Don't try to interact with disabled or readonly elements
6. **Watch for alerts** — the snapshot includes an "Alerts & Notifications" section for error messages and validation feedback
7. **Use `type_and_select` for autocomplete** — it handles the full flow in one command
8. **Quote all selectors** — shell-special characters must be quoted
9. **One action per command** — don't chain multiple actions in one CLI call
10. **Check floating layers** — when `snapshot` shows a "Floating Layer" section, those are dynamically appeared dropdowns/modals/popups
11. **Use `--analyze` for visual-only pages** — `pi-browser screenshot --analyze` returns a text description of CAPTCHAs, canvas apps, and pages where the snapshot is insufficient
12. **Failed actions include automatic analysis** — when click/fill/hover fail, the error already includes a visual analysis of why; read it before retrying

## Typical Workflow

```bash
# 1. Navigate to the target page
pi-browser navigate https://example.com/login

# 2. Get the page structure
pi-browser snapshot
# Output:
# --- Interactive Elements ---
# Page: Login | H1: Sign In
# [1] textbox "Email" [type=email, name=email]
# [2] textbox "Password" [type=password, name=password]
# [3] button "Sign In"
# [4] link "Forgot password?" [href=/forgot]

# 3. Fill the form using ref IDs
pi-browser fill [1] 'myuser@example.com'
pi-browser fill [2] 'mypass123'

# 4. Click the login button
pi-browser click [3]

# 5. Verify the result
pi-browser snapshot
pi-browser screenshot --output /tmp/after-login.png
```

## Notes

- The browser must be open in the right panel of the desktop app
- All commands return JSON on stdout (except `snapshot` and `text` which return plain text)
- Errors are written to stderr with exit code 1
- The server only listens on `127.0.0.1` — no external access
- All interaction commands (click, fill, hover, select) auto-wait up to 5s for the element
