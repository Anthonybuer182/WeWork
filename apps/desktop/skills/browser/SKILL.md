---
name: browser
description: Browse web pages, read content, fill forms, take screenshots, record and replay browser workflows. Use when the user asks to visit a website, scrape content, automate web interactions, or save repetitive browser tasks as reusable workflows.
---

# pi-browser

Browser automation CLI for the Pi Coding Agent desktop app. Control the built-in browser (visible in the right panel) — navigate, click, fill forms, read content, screenshot, record and replay workflows.

## How it works

- The desktop app runs a local HTTP server on `127.0.0.1:19223`
- `pi-browser` CLI sends requests to this server
- The server drives a Playwright-connected Chromium (the app's own `<webview>`)
- Both agent and user see the **same browser instance** — all actions are visible in real time

## Commands

### Navigation & Reading

```bash
# Navigate to a URL
pi-browser navigate https://example.com

# Get the current URL and page title
pi-browser url

# Get accessibility tree of the page (for understanding page structure)
pi-browser snapshot

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
# Click an element
pi-browser click 'button:has-text("Login")'
pi-browser click '[data-testid="submit-btn"]'

# Fill an input field
pi-browser fill 'input[name="email"]' 'user@example.com'
pi-browser fill '#search-box' 'cats'
```

### Recording & Replaying Workflows

Record a sequence of browser interactions, then replay them later — no LLM needed during replay.

```bash
# Start recording (user performs actions in the browser panel)
pi-browser record start

# Stop recording and get captured steps
pi-browser record stop

# Save recorded steps as a named workflow
# Steps come from stdin (pipe from record stop)
pi-browser record stop | pi-browser save "GitHub Login"

# List saved workflows
pi-browser workflows

# Replay a workflow with variables
pi-browser replay "GitHub Login" --var username=myuser --var password=mypass

# Delete a workflow
pi-browser delete "GitHub Login"
```

## Selector Guide

The CLI uses Playwright selectors. Choose the most specific one available:

| Type | Example | When to use |
|------|---------|-------------|
| **data-testid** | `[data-testid="login-btn"]` | Best — most stable |
| **id** | `#email-input` | Good if ID is semantic (not auto-generated) |
| **aria-label** | `[aria-label="Search"]` | Good for icon buttons |
| **has-text** | `button:has-text("Sign In")` | Good for buttons/links with visible text |
| **role** | `role=button[name="Submit"]` | Good for ARIA-compliant pages |
| **name attr** | `input[name="password"]` | Good for form fields |
| **CSS** | `div.header > nav a:first-child` | Fallback — most fragile |

### Selector Tips

- Always **quote** selectors in the shell to avoid glob expansion
- Use `pi-browser snapshot` first to understand the page structure
- Prefer `:has-text()` for clickable elements with visible text
- For complex pages, combine: `div.modal input[name="email"]`

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

1. **Always navigate first** — `pi-browser navigate <url>` before any other command
2. **Snapshot before acting** — run `pi-browser snapshot` to understand the page, then decide what to click/fill
3. **Use screenshots for verification** — after important actions, take a screenshot to confirm the result
4. **Quote all selectors** — shell-special characters in selectors must be quoted
5. **One action per command** — don't try to chain multiple actions in one CLI call

## Typical Workflow

```bash
# 1. Navigate to the target page
pi-browser navigate https://example.com/login

# 2. Get the page structure
pi-browser snapshot

# 3. Fill the form based on what you found
pi-browser fill 'input[name="username"]' 'myuser'
pi-browser fill 'input[name="password"]' 'mypass'

# 4. Click the login button
pi-browser click 'button:has-text("Sign In")'

# 5. Verify the result
pi-browser snapshot
pi-browser screenshot --output /tmp/after-login.png
```

## Recording a Workflow

```bash
# 1. Tell the user to click "Record" in the browser panel
# 2. Start recording
pi-browser record start

# 3. User performs actions in the browser (navigate, click, fill)
#    The system captures each action with a selector

# 4. Stop recording
pi-browser record stop > /tmp/steps.json

# 5. Save as a named workflow
cat /tmp/steps.json | pi-browser save "My Workflow"

# 6. List workflows
pi-browser workflows

# 7. Replay later with variables
pi-browser replay "My Workflow" --var key=value
```

## Notes

- The browser must be open in the right panel of the desktop app
- All commands return JSON on stdout (except `snapshot` which returns text)
- Errors are written to stderr with exit code 1
- The server only listens on `127.0.0.1` — no external access
