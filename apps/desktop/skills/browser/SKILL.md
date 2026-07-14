---
name: browser
description: Browse web pages, read content, fill forms, take screenshots, record and replay browser workflows. Use when the user asks to visit a website, scrape content, automate web interactions, or save repetitive browser tasks as reusable workflows.
---

# pi-browser

Browser automation CLI for the Pi Coding Agent desktop app. Control the built-in browser (visible in the right panel) — navigate, click, fill forms, read content, screenshot, record and replay workflows.

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

# Select an option in a dropdown
pi-browser select [7] 'United States'
pi-browser select 'select[name="country"]' 'US'

# Press a keyboard key
pi-browser press Enter
pi-browser press Tab
pi-browser press Escape
pi-browser press ArrowDown

# Wait for an element to appear (default timeout 10s)
pi-browser wait '[data-testid="results"]'
pi-browser wait 'div.loading' 5000
```

### Recording & Replaying Workflows

Record a sequence of browser interactions, then replay them later — no LLM needed during replay.

```bash
# Start recording (user performs actions in the browser panel)
pi-browser record start

# Stop recording and get captured steps
pi-browser record stop

# Save recorded steps as a named workflow
pi-browser record stop | pi-browser save "GitHub Login"

# List saved workflows
pi-browser workflows

# Replay a workflow with variables
pi-browser replay "GitHub Login" --var username=myuser --var password=mypass

# Delete a workflow
pi-browser delete "GitHub Login"
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

```
--- Interactive Elements ---
Page: Example Site | H1: Welcome
[1] link "Home" [href=/]
[2] link "Products" [href=/products]
[3] button "Search" [aria-label="Search"]
[4] textbox "Email" [type=email, placeholder="Enter email", name=email]
[5] textbox "Password" [type=password, placeholder="Password", name=password]
[6] button "Sign In"
[7] checkbox "Remember me" [name=remember]
[8] link "Forgot password?" [href=/forgot]
[9] combobox "Country" [name=country]
```

Each line shows: `[ref]` `role` `"accessible name"` `[attributes]`

## Workflow Variables

Recorded workflows can contain `{{variableName}}` placeholders. During replay, pass values with `--var`:

```bash
# A recorded login workflow might have steps like:
# fill input[name="user"] {{username}}
# fill input[name="pass"] {{password}}

# Replay with actual values:
pi-browser replay "Login" --var username=alice --var password=secret123
```

Variables are automatically detected from `{{...}}` patterns in fill values and navigate URLs.

## Best Practices

1. **Navigate first** — `pi-browser navigate <url>` before any other command
2. **Snapshot before acting** — run `pi-browser snapshot` to see the page structure and ref IDs
3. **Use ref IDs** — `click [3]` is more reliable than any CSS selector
4. **Verify after actions** — after important clicks/fills, run `snapshot` or `screenshot` to confirm
5. **Quote all selectors** — shell-special characters must be quoted
6. **One action per command** — don't chain multiple actions in one CLI call
7. **Re-snapshot after navigation** — ref IDs reset when the page changes

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
