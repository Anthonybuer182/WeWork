import { webContents } from 'electron';
import { BROWSER_HELPERS_JS } from './browser-helpers';

/** Snapshot node — simplified accessibility tree. */
export interface SnapshotNode {
  role: string;
  name: string;
  ref?: string;
  children?: SnapshotNode[];
}

type UrlChangedCallback = (url: string) => void;
type SwitchToBrowserTabCallback = () => void;

/**
 * BrowserManager — manages the Electron webview via the debugger API
 * and browser automation.
 *
 * Uses Electron's webContents.debugger API instead of Playwright's
 * page enumeration because Playwright's connectOverCDP does not expose
 * `type: "webview"` CDP targets (Electron 38).
 */
export class BrowserManager {
  private webviewWc: Electron.WebContents | null = null;
  private debuggerAttached = false;
  private urlChangedCallbacks: UrlChangedCallback[] = [];
  private switchToBrowserTabCallbacks: SwitchToBrowserTabCallback[] = [];
  private currentZoom = 1;

  constructor() {}

  /** ——— Connection ——— */

  /** Connect to the Electron webview via the debugger API. */
  async connect(): Promise<void> {
    // Find the webview webContents in all Electron views
    const allWc = webContents.getAllWebContents();
    const wv = allWc.find((wc) => wc.getType() === 'webview');

    if (!wv) {
      throw new Error('No webview page found. Ensure the Browser tab is open.');
    }

    this.webviewWc = wv;

    // Intercept window.open() and target="_blank" links — navigate in-place
    // instead of popping up a new BrowserWindow. We inject JS that overrides
    // window.open before each page load, since setWindowOpenHandler doesn't
    // work reliably for <webview> tags in Electron 38.
    this.injectHelpers();

    // Attach the debugger (Electron's debugger API handles CDP messaging)
    try {
      wv.debugger.attach('1.3');
      this.debuggerAttached = true;
    } catch (err) {
      // If already attached by something else, try continuing
      if (err instanceof Error && err.message.includes('already attached')) {
        this.debuggerAttached = true;
      } else {
        throw err;
      }
    }

    // Listen for CDP events (not command responses — those use the Promise from sendCommand)
    wv.debugger.on('message', (_event, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.frameNavigated' && params?.frame) {
        const frame = params.frame as { url?: string };
        const url = frame.url || '';
        if (url && !url.startsWith('about:')) {
          this.urlChangedCallbacks.forEach((cb) => cb(url));
        }
        // Re-inject helpers after each navigation
        this.injectHelpers();
        // Also try auto-zoom here as a fallback
        this.computeAutoZoom();
      }

      if (method === 'Page.loadEventFired') {
        console.log('[BrowserManager] Page.loadEventFired');
        this.injectHelpers();
        this.computeAutoZoom();
      }
    });

    // Enable necessary CDP domains
    await this.sendCommand('Page.enable');
    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Accessibility.enable');

    // Inject the helpers immediately
    this.injectHelpers();

    console.log('[BrowserManager] Connected to webview via debugger API');
  }

  /** Check if the debugger is attached and the webview is alive. */
  isConnected(): boolean {
    if (!this.webviewWc || !this.debuggerAttached) return false;
    try {
      return !this.webviewWc.isDestroyed();
    } catch {
      return false;
    }
  }

  /**
   * Ensure the webview is connected before executing a command.
   * If the webview doesn't exist (Browser tab not open), notify the
   * renderer to switch to the Browser tab, then retry connecting.
   */
  async ensureConnected(timeoutMs = 15000): Promise<void> {
    // Already connected and alive
    if (this.isConnected()) return;

    // Reset stale state
    this.webviewWc = null;
    this.debuggerAttached = false;

    // Signal the renderer to switch to the Browser tab
    console.log('[BrowserManager] Webview not found — requesting tab switch');
    this.switchToBrowserTabCallbacks.forEach((cb) => cb());

    // Poll for the webview to appear and connect
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const allWc = webContents.getAllWebContents();
        const wv = allWc.find((wc) => wc.getType() === 'webview');
        if (wv && !wv.isDestroyed()) {
          // Found the webview — connect now
          await this.connect();
          if (this.isConnected()) return;
        }
      } catch {
        // Keep retrying
      }
    }

    throw new Error('Browser panel is not open. Please open the Browser tab in the right panel and try again.');
  }

  /** Inject JS helpers (selector resolver, snapshot, window.open override) into the page. */
  private injectHelpers(): void {
    if (!this.webviewWc) return;
    // Inject the helpers (idempotent — checks window.__piHelpers)
    this.webviewWc.executeJavaScript(BROWSER_HELPERS_JS).catch(() => {});
    // Also inject window.open override
    this.webviewWc.executeJavaScript(`
      if (!window.__pi_open_override) {
        window.__pi_open_override = true;
        window.open = function(url) {
          if (url) location.href = url;
          return null;
        };
      }
      document.querySelectorAll('a[target="_blank"]').forEach(function(a) {
        a.target = '_self';
      });
    `).catch(() => {});
  }

  /** Measure page content width and compute auto-fit zoom via CDP. */
  /** Measure page content width vs webview width and auto-fit zoom. */
  private webviewWidth = 600;

  /** Set the webview's CSS width (called from renderer via IPC). */
  setWebviewWidth(width: number): void {
    this.webviewWidth = width;
  }

  private async computeAutoZoom(): Promise<void> {
    if (!this.webviewWc) return;
    try {
      // Reset zoom to 1.0 first to get natural page dimensions
      this.webviewWc.setZoomFactor(1);
      // Wait for layout to settle after zoom reset
      await new Promise((r) => setTimeout(r, 100));

      const clientW = this.webviewWidth;
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `JSON.stringify({scrollW: document.documentElement.scrollWidth || document.body.scrollWidth})`,
        returnByValue: true,
      });
      const dims = JSON.parse((result?.result as { value?: string })?.value ?? '{"scrollW":0}');
      console.log('[BrowserManager] computeAutoZoom:', {scrollW: dims.scrollW, clientW});
      if (dims.scrollW > clientW + 2) {
        this.currentZoom = Math.max(0.3, clientW / dims.scrollW);
      } else {
        this.currentZoom = 1;
      }
      await this.applyZoom();
    } catch (err) {
      console.warn('[BrowserManager] computeAutoZoom error:', err);
    }
  }

  private async applyZoom(): Promise<void> {
    console.log('[BrowserManager] applyZoom:', this.currentZoom);
    try { this.webviewWc?.setZoomFactor(this.currentZoom); } catch {}
  }

  /** ——— CDP communication ——— */

  /**
   * Send a CDP command via Electron's debugger API.
   * Electron automatically manages CDP message IDs and routes responses.
   */
  private sendCommand(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.webviewWc || !this.debuggerAttached) {
      return Promise.reject(new Error('Debugger not attached'));
    }

    // Wrap with timeout
    const timeoutMs = 30000;
    return Promise.race([
      this.webviewWc.debugger.sendCommand(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`CDP command "${method}" timed out`)), timeoutMs)
      ),
    ]) as Promise<Record<string, unknown>>;
  }

  /** ——— Core browser operations ——— */

  /** Navigate to a URL. */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.sendCommand('Page.navigate', { url });
    // Wait for page to load (simple delay approach)
    await this.waitForPageLoad();
    const title = await this.getTitle();
    const currentUrl = await this.getCurrentUrl();
    return { url: currentUrl, title };
  }

  /** Get the current URL. */
  async getUrl(): Promise<{ url: string; title: string }> {
    const [url, title] = await Promise.all([this.getCurrentUrl(), this.getTitle()]);
    return { url, title };
  }

  /** Get the current page title via CDP. */
  private async getTitle(): Promise<string> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? '';
    } catch {
      return '';
    }
  }

  /** Get the current page URL via CDP. */
  private async getCurrentUrl(): Promise<string> {
    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? 'about:blank';
    } catch {
      return 'about:blank';
    }
  }

  /** Wait for the page to finish loading (domcontentloaded). */
  private async waitForPageLoad(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        const state = (result?.result as { value?: string })?.value;
        if (state === 'complete' || state === 'interactive') {
          // Extra small delay for rendering
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
      } catch {
        // Ignore evaluation errors during load
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Page load timed out');
  }

  /** ——— Snapshot / accessibility ——— */

  /** Take a snapshot of interactive elements with ref IDs for easy targeting. */
  async getSnapshot(): Promise<string> {
    try {
      // Ensure helpers are injected
      await this.sendCommand('Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: 'window.piSnapshot ? window.piSnapshot() : "(helpers not loaded)"',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? '(empty page)';
    } catch {
      return '(snapshot unavailable)';
    }
  }

  /** ——— Interaction ——— */

  /** Build an expression that ensures helpers are loaded, then runs the given code. */
  private buildExpression(code: string): string {
    return `${BROWSER_HELPERS_JS}\n${code}`;
  }

  /** Wait for an element to exist and be visible, with timeout. Returns true if found. */
  async waitForElement(selector: string, timeoutMs = 5000): Promise<boolean> {
    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      return !!el;
    })()`);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
        });
        if ((result?.result as { value?: boolean })?.value) return true;
      } catch {
        // Ignore transient errors
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** Click an element by selector. Supports CSS, :has-text(), role=, text=, and [N] ref. */
  async click(selector: string): Promise<{ selector: string; clicked: boolean; error?: string }> {
    // Auto-wait: poll for element up to 5s
    const found = await this.waitForElement(selector, 5000);
    if (!found) {
      // Get suggestions for similar elements
      let suggestions = '';
      try {
        const sugResult = await this.sendCommand('Runtime.evaluate', {
          expression: this.buildExpression(`(window.piFindSimilar ? window.piFindSimilar(${JSON.stringify(selector)}, 5) : []).join('\\n')`),
          returnByValue: true,
        });
        suggestions = (sugResult?.result as { value?: string })?.value ?? '';
      } catch {}
      const errorMsg = suggestions
        ? `Element not found: "${selector}". Did you mean one of these?\n${suggestions}`
        : `Element not found: "${selector}"`;
      return { selector, clicked: false, error: errorMsg };
    }

    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({block:'center', behavior:'instant'});
      el.click();
      return true;
    })()`);
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    const clicked = (result?.result as { value?: boolean })?.value ?? false;
    return { selector, clicked };
  }

  /** Fill an input by selector. Uses native value setter for React/Vue. Supports all selector formats. */
  async fill(selector: string, value: string): Promise<{ selector: string; value: string; error?: string }> {
    const found = await this.waitForElement(selector, 5000);
    if (!found) {
      return { selector, value, error: `Element not found: "${selector}"` };
    }

    // Step 1: Get element rect and click to focus (native mouse click triggers React focus handlers)
    const rectExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', behavior:'instant'});
      var r = el.getBoundingClientRect();
      return {x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height};
    })()`);
    const rectResult = await this.sendCommand('Runtime.evaluate', {
      expression: rectExpr,
      returnByValue: true,
    });
    const rect = (rectResult?.result as { value?: { x: number; y: number; width: number; height: number } })?.value;
    if (!rect) {
      return { selector, value, error: `Cannot get rect for: "${selector}"` };
    }

    // Click 3 times to select all text (triple-click)
    for (let i = 0; i < 3; i++) {
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: i + 1,
      });
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: i + 1,
      });
    }

    // Step 2: Type the new value via Input.insertText (triggers React onChange via browser input pipeline)
    await this.sendCommand('Input.insertText', { text: value });

    return { selector, value };
  }

  /** Hover over an element by selector. */
  async hover(selector: string): Promise<{ selector: string; hovered: boolean; error?: string }> {
    const found = await this.waitForElement(selector, 5000);
    if (!found) {
      return { selector, hovered: false, error: `Element not found: "${selector}"` };
    }

    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({block:'center', behavior:'instant'});
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove','pointerout','pointerleave','mouseout','mouseleave'].forEach(function(evt) {
        el.dispatchEvent(new MouseEvent(evt, {bubbles: true, cancelable: true, clientX: x, clientY: y}));
      });
      return true;
    })()`);
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { selector, hovered: (result?.result as { value?: boolean })?.value ?? false };
  }

  /** Select an option in a <select> element by value or visible text. */
  async selectOption(selector: string, value: string): Promise<{ selector: string; value: string; selected: boolean; error?: string }> {
    const found = await this.waitForElement(selector, 5000);
    if (!found) {
      return { selector, value, selected: false, error: `Element not found: "${selector}"` };
    }

    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el || el.tagName.toLowerCase() !== 'select') return false;
      var opts = Array.from(el.options);
      // Try exact value match, then text match
      var target = opts.find(function(o) { return o.value === ${JSON.stringify(value)}; })
        || opts.find(function(o) { return o.textContent.trim() === ${JSON.stringify(value)}; })
        || opts.find(function(o) { return o.textContent.trim().includes(${JSON.stringify(value)}); });
      if (!target) return false;
      el.value = target.value;
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    })()`);
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { selector, value, selected: (result?.result as { value?: boolean })?.value ?? false };
  }

  /**
   * Type text into an input, wait for suggestion dropdown to appear, then select matching option.
   * Compound operation for autocomplete / typeahead fields.
   *
   * @param selector - Selector for the input element
   * @param text - Text to type into the input
   * @param optionMatcher - Text to match against suggestion options (case-insensitive substring)
   * @param waitMs - How long to wait for suggestions to appear (default 1500ms)
   */
  async typeAndSelect(
    selector: string,
    text: string,
    optionMatcher: string,
    waitMs = 1500,
  ): Promise<{ selector: string; typed: string; matched: string | null; selected: boolean; error?: string }> {
    // 1. Focus and clear the input
    const found = await this.waitForElement(selector, 5000);
    if (!found) {
      return { selector, typed: text, matched: null, selected: false, error: `Input element not found: "${selector}"` };
    }

    // Get element rect for CDP mouse events (same approach as fill())
    const rectExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', behavior:'instant'});
      var r = el.getBoundingClientRect();
      return {x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height};
    })()`);
    const rectResult = await this.sendCommand('Runtime.evaluate', {
      expression: rectExpr,
      returnByValue: true,
    });
    const rect = (rectResult?.result as { value?: { x: number; y: number; width: number; height: number } })?.value;
    if (!rect) {
      return { selector, typed: text, matched: null, selected: false, error: `Cannot get rect for: "${selector}"` };
    }

    // Triple-click to select all existing text (same as fill())
    for (let i = 0; i < 3; i++) {
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: i + 1,
      });
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: i + 1,
      });
    }

    // 2. Type the text using CDP insertText
    await this.sendCommand('Input.insertText', { text });

    // Dispatch DOM input/change events so React/Vue/vanilla JS listeners fire (e.g., autocomplete dropdowns)
    await this.sendCommand('Runtime.evaluate', {
      expression: this.buildExpression(`(function(){
        var el = window.piResolveSelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
          el.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
        }
      })()`),
    });

    // 3. Wait for suggestion dropdown to appear
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // 4. Take a fresh snapshot to find the suggestion options
    await this.sendCommand('Runtime.evaluate', {
      expression: BROWSER_HELPERS_JS,
      returnByValue: true,
    });

    // 5. Try to find and click a matching option
    const matcherEscaped = JSON.stringify(optionMatcher.toLowerCase());
    const expr = this.buildExpression(`(function(){
      // Look for options in dropdown layers
      var candidates = [];

      // Strategy A: role="option" elements that contain the target text
      var options = document.querySelectorAll('[role="option"]');
      for (var o = 0; o < options.length; o++) {
        if (piIsVisible(options[o]) && (options[o].textContent || '').toLowerCase().includes(${matcherEscaped})) {
          candidates.push(options[o]);
        }
      }

      // Strategy B: <li> elements in floating containers
      if (candidates.length === 0) {
        var lis = document.querySelectorAll('li');
        for (var l = 0; l < lis.length; l++) {
          if (piIsVisible(lis[l])) {
            var txt = (lis[l].textContent || '').trim().toLowerCase();
            if (txt.includes(${matcherEscaped}) && txt.length < 200) {
              candidates.push(lis[l]);
            }
          }
        }
      }

      // Strategy C: Any visible element with matching text and onclick/href
      if (candidates.length === 0) {
        var all = document.querySelectorAll('div, span, a, button, p');
        for (var a = 0; a < all.length; a++) {
          if (piIsVisible(all[a])) {
            var atxt = (all[a].textContent || '').trim().toLowerCase();
            if (atxt === ${matcherEscaped}) {
              candidates.push(all[a]);
              break;
            }
          }
        }
        // Fall back to partial match
        if (candidates.length === 0) {
          for (var a2 = 0; a2 < all.length; a2++) {
            if (piIsVisible(all[a2])) {
              var atxt2 = (all[a2].textContent || '').trim().toLowerCase();
              if (atxt2.includes(${matcherEscaped}) && atxt2.length < 100) {
                candidates.push(all[a2]);
                break;
              }
            }
          }
        }
      }

      if (candidates.length > 0) {
        // Click the first matching candidate
        var target = candidates[0];
        var rect = target.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:x, clientY:y}));
        target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y}));
        target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y}));
        return (target.textContent || '').trim().slice(0, 100);
      }
      return null;
    })()`);

    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });

    const matched = (result?.result as { value?: string | null })?.value ?? null;

    if (matched) {
      return { selector, typed: text, matched, selected: true };
    }

    // If no match found, try keyboard navigation approach
    const isSingleChar = text.length === 1;
    if (!matched && !isSingleChar) {
      // Could try pressing ArrowDown + Enter as fallback
      return {
        selector,
        typed: text,
        matched: null,
        selected: false,
        error: `No option matching "${optionMatcher}" found in dropdown. Try re-snapshotting to see available options.`,
      };
    }

    return { selector, typed: text, matched: null, selected: false, error: `No matching option found for "${optionMatcher}"` };
  }

  /** CDP key code mappings for common special keys. */
  private static KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number }> = {
    'Enter':     { key: 'Enter',     code: 'Enter',     windowsVirtualKeyCode: 13,  nativeVirtualKeyCode: 36 },
    'Tab':       { key: 'Tab',       code: 'Tab',       windowsVirtualKeyCode: 9,   nativeVirtualKeyCode: 48 },
    'Escape':    { key: 'Escape',    code: 'Escape',    windowsVirtualKeyCode: 27,  nativeVirtualKeyCode: 53 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40,  nativeVirtualKeyCode: 125 },
    'ArrowUp':   { key: 'ArrowUp',   code: 'ArrowUp',   windowsVirtualKeyCode: 38,  nativeVirtualKeyCode: 126 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37,  nativeVirtualKeyCode: 123 },
    'ArrowRight':{ key: 'ArrowRight',code: 'ArrowRight',windowsVirtualKeyCode: 39,  nativeVirtualKeyCode: 124 },
    'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,   nativeVirtualKeyCode: 51 },
    'Delete':    { key: 'Delete',    code: 'Delete',    windowsVirtualKeyCode: 46,  nativeVirtualKeyCode: 117 },
    'Home':      { key: 'Home',      code: 'Home',      windowsVirtualKeyCode: 36,  nativeVirtualKeyCode: 115 },
    'End':       { key: 'End',       code: 'End',       windowsVirtualKeyCode: 35,  nativeVirtualKeyCode: 119 },
    'PageUp':    { key: 'PageUp',    code: 'PageUp',    windowsVirtualKeyCode: 33,  nativeVirtualKeyCode: 116 },
    'PageDown':  { key: 'PageDown',  code: 'PageDown',  windowsVirtualKeyCode: 34,  nativeVirtualKeyCode: 121 },
    'Space':     { key: ' ',         code: 'Space',     windowsVirtualKeyCode: 32,  nativeVirtualKeyCode: 49 },
    'Shift':     { key: 'Shift',     code: 'ShiftLeft', windowsVirtualKeyCode: 16,  nativeVirtualKeyCode: 56 },
    'Control':   { key: 'Control',   code: 'ControlLeft',windowsVirtualKeyCode: 17,  nativeVirtualKeyCode: 59 },
    'Alt':       { key: 'Alt',       code: 'AltLeft',   windowsVirtualKeyCode: 18,  nativeVirtualKeyCode: 58 },
    'Meta':      { key: 'Meta',      code: 'MetaLeft',  windowsVirtualKeyCode: 91,  nativeVirtualKeyCode: 55 },
    'F5':        { key: 'F5',        code: 'F5',        windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 96 },
  };

  /**
   * Press a keyboard key using CDP Input.dispatchKeyEvent — real OS-level keyboard input
   * that works with React/Vue event systems (unlike JS dispatchEvent).
   *
   * Supports special keys (Enter, Tab, ArrowDown, etc.) and regular characters.
   */
  async pressKey(key: string): Promise<{ key: string; pressed: boolean }> {
    const keyDef = BrowserManager.KEY_MAP[key];

    if (keyDef) {
      // Special key — send keyDown + keyUp via CDP
      const base: Record<string, unknown> = {
        type: 'rawKeyDown',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyDef.nativeVirtualKeyCode,
        isSystemKey: false,
      };

      await this.sendCommand('Input.dispatchKeyEvent', {
        ...base,
        type: 'rawKeyDown',
      });

      // For keys that produce characters (Enter, Space, Tab), also send a char event
      if (['Enter', 'Tab', 'Space'].includes(key)) {
        await this.sendCommand('Input.dispatchKeyEvent', {
          ...base,
          type: 'char',
          text: key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : ' ',
          unmodifiedText: key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : ' ',
        });
      }

      await this.sendCommand('Input.dispatchKeyEvent', {
        ...base,
        type: 'keyUp',
      });
    } else {
      // Regular character — use char event which triggers React onChange properly
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'char',
        key: key,
        text: key,
        unmodifiedText: key,
      });

      // Also send keyDown/keyUp pair for completeness
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      });
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      });
    }

    return { key, pressed: true };
  }

  /** Wait for a selector to appear on the page. */
  async waitForSelector(selector: string, timeoutMs = 10000): Promise<{ selector: string; found: boolean }> {
    const found = await this.waitForElement(selector, timeoutMs);
    return { selector, found };
  }

  /** Get text content of an element (or entire page if no selector). */
  async getText(selector?: string): Promise<{ text: string; selector?: string }> {
    const expr = this.buildExpression(`(function(){
      ${selector ? `var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return '';
      return (el.innerText || el.textContent || '').trim();` : `return (document.body.innerText || document.body.textContent || '').trim();`}
    })()`);
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { text: (result?.result as { value?: string })?.value ?? '', selector };
  }

  /** Get the value of an attribute on an element. */
  async getAttribute(selector: string, attribute: string): Promise<{ selector: string; attribute: string; value: string | null }> {
    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      return el.getAttribute(${JSON.stringify(attribute)});
    })()`);
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { selector, attribute, value: (result?.result as { value?: string | null })?.value ?? null };
  }

  /** Take a screenshot. Resets zoom to 1.0 for full resolution, restores after.
   *  Default: viewport only. Pass fullPage: true for full page (scrolls to trigger lazy load first). */
  async screenshot(options?: { fullPage?: boolean }): Promise<{ base64: string }> {
    const savedZoom = this.currentZoom;

    // For full-page: scroll through the page to trigger lazy-loaded content
    if (options?.fullPage) {
      await this.triggerLazyLoad();
      // Scroll back to top before capturing
      await this.sendCommand('Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)',
        returnByValue: true,
      });
    }

    // Reset zoom to 1.0 for full-resolution capture
    try { this.webviewWc?.setZoomFactor(1); } catch {}
    // Wait for the renderer to repaint after zoom change
    await new Promise((r) => setTimeout(r, 300));

    try {
      if (options?.fullPage) {
        // Use Math.max to include horizontal overflow (scrollWidth > clientWidth)
        // and account for body-level dimensions on pages where html is constrained.
        const metrics = await this.sendCommand('Runtime.evaluate', {
          expression: `JSON.stringify({
            width: Math.max(
              document.documentElement.scrollWidth,
              document.documentElement.clientWidth,
              document.body ? document.body.scrollWidth : 0,
              document.body ? document.body.clientWidth : 0
            ),
            height: Math.max(
              document.documentElement.scrollHeight,
              document.documentElement.clientHeight,
              document.body ? document.body.scrollHeight : 0
            )
          })`,
          returnByValue: true,
        });
        const dims = JSON.parse((metrics?.result as { value?: string })?.value ?? '{"width":800,"height":600}');
        const width = Math.min(dims.width || 1920, 16384);
        const height = Math.min(dims.height || 600, 16384);

        const result = await this.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        return { base64: (result?.data as string) ?? '' };
      } else {
        const result = await this.sendCommand('Page.captureScreenshot', {
          format: 'png',
        });
        return { base64: (result?.data as string) ?? '' };
      }
    } finally {
      // Restore zoom
      try { this.webviewWc?.setZoomFactor(savedZoom); } catch {}
    }
  }

  /** Scroll through the page to trigger lazy-loaded content.
   *  Uses a two-pass approach: first scrolls down in steps, then back up.
   *  Caps at 40 steps to avoid infinite pages, with 400ms between steps
   *  to give lazy loaders and image decoders time to complete. */
  private async triggerLazyLoad(): Promise<void> {
    try {
      const stepExpr = `(function(){
        var step = window.innerHeight * 0.75;
        var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY + 5 >= maxScroll) { window.scrollTo(0, maxScroll); return false; }
        window.scrollBy(0, step);
        return true;
      })()`;
      // Pass 1: scroll down through the entire page
      let hasMore = true;
      let count = 0;
      while (hasMore && count < 40) {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: stepExpr,
          returnByValue: true,
        });
        hasMore = (result?.result as { value?: boolean })?.value ?? false;
        count++;
        await new Promise((r) => setTimeout(r, 400));
        // Also dispatch scroll events to wake IntersectionObserver-based loaders
        await this.sendCommand('Runtime.evaluate', {
          expression: 'window.dispatchEvent(new Event("scroll", {bubbles: true}))',
          returnByValue: true,
        }).catch(() => {});
      }
      // Pass 2: scroll back up to trigger any reverse-direction lazy content
      await this.sendCommand('Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)',
        returnByValue: true,
      });
      // Wait for final render to stabilize
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn('[BrowserManager] triggerLazyLoad error:', err);
    }
  }

  /** Scroll the page. */
  async scroll(direction: 'up' | 'down', amount = 500): Promise<{ direction: string; amount: number }> {
    const dy = direction === 'down' ? amount : -amount;
    await this.sendCommand('Runtime.evaluate', {
      expression: `window.scrollBy(0, ${dy})`,
      returnByValue: true,
    });
    return { direction, amount };
  }

  /** Evaluate a JavaScript expression in the page. */
  async evaluate(expression: string): Promise<{ result: unknown }> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return { result: (result?.result as { value?: unknown })?.value };
  }

  /** ——— Events ——— */

  /** Register a callback for URL changes. */
  onUrlChanged(cb: UrlChangedCallback): void {
    this.urlChangedCallbacks.push(cb);
  }

  /** Register a callback for switching to the Browser tab (main → renderer signal). */
  onSwitchToBrowserTab(cb: SwitchToBrowserTabCallback): void {
    this.switchToBrowserTabCallbacks.push(cb);
  }

  /** ——— Viewport ——— */

  /** Override the webview's device metrics to match the panel width. */
  async setDeviceMetrics(width: number, height: number): Promise<void> {
    this.webviewWidth = width;
    await this.computeAutoZoom();
  }

  /** Set user zoom (0.3–3.0). Combined with auto-fit zoom. */
  async setZoom(factor: number): Promise<{ zoom: number }> {
    this.currentZoom = Math.max(0.3, Math.min(3, factor));
    await this.applyZoom();
    return { zoom: this.currentZoom };
  }

  async resetZoom(): Promise<{ zoom: number }> {
    return await this.setZoom(1);
  }

  getZoom(): number {
    return this.currentZoom;
  }

  /** ——— Cleanup ——— */

  /** Disconnect the debugger. */
  async disconnect(): Promise<void> {
    if (this.webviewWc && this.debuggerAttached) {
      try {
        this.webviewWc.debugger.detach();
      } catch {
        // Ignore detach errors
      }
      this.debuggerAttached = false;
    }
    this.webviewWc = null;
  }
}
