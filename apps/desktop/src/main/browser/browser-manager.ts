import { webContents } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { RECORDING_SCRIPT, RECORDING_MESSAGE_PREFIX } from './recording-script';
import { BROWSER_HELPERS_JS } from './browser-helpers';

/** A single recorded workflow step. */
export interface WorkflowStep {
  type: 'click' | 'fill' | 'scroll' | 'navigate';
  selector?: string;
  value?: string;
  direction?: 'up' | 'down';
  amount?: number;
  url?: string;
  timestamp: number;
}

/** A saved workflow definition. */
export interface Workflow {
  name: string;
  steps: WorkflowStep[];
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

/** Snapshot node — simplified accessibility tree. */
export interface SnapshotNode {
  role: string;
  name: string;
  ref?: string;
  children?: SnapshotNode[];
}

type UrlChangedCallback = (url: string) => void;
type RecordingStateCallback = (recording: boolean) => void;
type ReplayProgressCallback = (current: number, total: number, step: WorkflowStep) => void;
type SwitchToBrowserTabCallback = () => void;

/**
 * BrowserManager — manages the Electron webview via the debugger API,
 * browser automation, and recording/replay of workflows.
 *
 * Uses Electron's webContents.debugger API instead of Playwright's
 * page enumeration because Playwright's connectOverCDP does not expose
 * `type: "webview"` CDP targets (Electron 38).
 */
export class BrowserManager {
  private webviewWc: Electron.WebContents | null = null;
  private debuggerAttached = false;
  private recording = false;
  private recordedSteps: WorkflowStep[] = [];
  private urlChangedCallbacks: UrlChangedCallback[] = [];
  private recordingStateCallbacks: RecordingStateCallback[] = [];
  private replayProgressCallbacks: ReplayProgressCallback[] = [];
  private switchToBrowserTabCallbacks: SwitchToBrowserTabCallback[] = [];
  private workflowsDir: string;
  private currentZoom = 1;

  constructor(workflowsDir?: string) {
    this.workflowsDir = workflowsDir ?? join(homedir(), '.pi', 'agent', 'workflows');
  }

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
      if (method === 'Runtime.consoleAPICalled') {
        this.handleConsoleMessage(params);
      }

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

  /** Press a keyboard key. Supports key names like 'Enter', 'Tab', 'Escape', 'ArrowDown'. */
  async pressKey(key: string): Promise<{ key: string; pressed: boolean }> {
    const expr = this.buildExpression(`(function(){
      var key = ${JSON.stringify(key)};
      var target = document.activeElement || document.body;
      var opts = {bubbles: true, cancelable: true, key: key, code: key};
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keypress', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    })()`);
    await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
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
    await new Promise((r) => setTimeout(r, 200));

    try {
      if (options?.fullPage) {
        const metrics = await this.sendCommand('Runtime.evaluate', {
          expression: `JSON.stringify({
            width: document.documentElement.clientWidth,
            height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          })`,
          returnByValue: true,
        });
        const dims = JSON.parse((metrics?.result as { value?: string })?.value ?? '{"width":800,"height":600}');
        const width = dims.width || 800;
        const height = Math.min(dims.height || 600, 8000);

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

  /** Scroll through the page to trigger lazy-loaded content. */
  private async triggerLazyLoad(): Promise<void> {
    try {
      const stepExpr = `(function(){
        var step = window.innerHeight * 0.8;
        var target = window.scrollY + step;
        var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (target >= maxScroll) { window.scrollTo(0, maxScroll); return false; }
        window.scrollTo(0, target);
        return true;
      })()`;
      let hasMore = true;
      let count = 0;
      while (hasMore && count < 50) {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: stepExpr,
          returnByValue: true,
        });
        hasMore = (result?.result as { value?: boolean })?.value ?? false;
        count++;
        await new Promise((r) => setTimeout(r, 300));
      }
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

  /** ——— Recording ——— */

  /** Handle console messages from the webview (for recording). */
  private handleConsoleMessage(params: Record<string, unknown>): void {
    if (!this.recording) return;

    const args = params?.args as Array<{ type?: string; value?: string }> | undefined;
    if (!args || args.length === 0) return;

    const text = args.map((a) => a.value ?? '').join(' ');
    if (text.startsWith(RECORDING_MESSAGE_PREFIX)) {
      try {
        const step = JSON.parse(text.slice(RECORDING_MESSAGE_PREFIX.length));
        this.recordedSteps.push(step);
      } catch {
        // Ignore malformed messages
      }
    }
  }

  /** Start recording user interactions. */
  async startRecording(): Promise<{ started: boolean }> {
    this.recording = true;
    this.recordedSteps = [];

    // Enable console and runtime domains
    await this.sendCommand('Runtime.enable', {});

    // Inject the recording script
    await this.sendCommand('Runtime.evaluate', {
      expression: RECORDING_SCRIPT,
      returnByValue: true,
    });

    this.recordingStateCallbacks.forEach((cb) => cb(true));
    console.log('[BrowserManager] Recording started');
    return { started: true };
  }

  /** Stop recording and return captured steps. */
  async stopRecording(): Promise<{ steps: WorkflowStep[] }> {
    // Set flag to stop recording in the injected script
    try {
      await this.sendCommand('Runtime.evaluate', {
        expression: '(function(){ window.__piBrowserRecording = false; })()',
        returnByValue: true,
      });
    } catch {
      // Ignore errors if page navigated away
    }

    this.recording = false;
    this.recordingStateCallbacks.forEach((cb) => cb(false));
    console.log(`[BrowserManager] Recording stopped, ${this.recordedSteps.length} steps captured`);

    return { steps: [...this.recordedSteps] };
  }

  /** Whether recording is active. */
  isRecording(): boolean {
    return this.recording;
  }

  /** ——— Workflow management ——— */

  /** Save a workflow to disk. */
  async saveWorkflow(name: string, steps: WorkflowStep[]): Promise<{ name: string; saved: boolean }> {
    if (!existsSync(this.workflowsDir)) {
      mkdirSync(this.workflowsDir, { recursive: true });
    }

    const variables = this.extractVariables(steps);
    const now = new Date().toISOString();

    // Check if updating existing
    const filepath = join(this.workflowsDir, `${name}.json`);
    let existing: Workflow | null = null;
    if (existsSync(filepath)) {
      try {
        existing = JSON.parse(readFileSync(filepath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    const workflow: Workflow = {
      name,
      steps,
      variables,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    writeFileSync(filepath, JSON.stringify(workflow, null, 2), 'utf-8');
    console.log(`[BrowserManager] Workflow "${name}" saved with ${steps.length} steps`);
    return { name, saved: true };
  }

  /** List all saved workflows. */
  async listWorkflows(): Promise<Workflow[]> {
    if (!existsSync(this.workflowsDir)) return [];
    const files = readdirSync(this.workflowsDir).filter((f) => f.endsWith('.json'));
    const workflows: Workflow[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(this.workflowsDir, file), 'utf-8');
        workflows.push(JSON.parse(content));
      } catch {
        // Skip invalid files
      }
    }
    return workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Delete a workflow by name. */
  async deleteWorkflow(name: string): Promise<{ name: string; deleted: boolean }> {
    const filepath = join(this.workflowsDir, `${name}.json`);
    if (existsSync(filepath)) {
      unlinkSync(filepath);
      return { name, deleted: true };
    }
    return { name, deleted: false };
  }

  /** Extract {{variable}} placeholders from workflow steps. */
  private extractVariables(steps: WorkflowStep[]): string[] {
    const variables = new Set<string>();
    const regex = /\{\{(\w+)\}\}/g;
    for (const step of steps) {
      const text = `${step.value ?? ''} ${step.url ?? ''} ${step.selector ?? ''}`;
      let match;
      while ((match = regex.exec(text)) !== null) {
        variables.add(match[1]);
      }
    }
    return Array.from(variables);
  }

  /** Replace {{variable}} placeholders in a string. */
  private replaceVariables(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
  }

  /** Replay a saved workflow with optional variable substitutions. */
  async replay(name: string, variables: Record<string, string> = {}): Promise<{ name: string; completed: boolean; stepCount: number }> {
    const filepath = join(this.workflowsDir, `${name}.json`);
    if (!existsSync(filepath)) {
      throw new Error(`Workflow "${name}" not found`);
    }

    const workflow: Workflow = JSON.parse(readFileSync(filepath, 'utf-8'));
    const steps = workflow.steps;
    const total = steps.length;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Notify progress
      this.replayProgressCallbacks.forEach((cb) => cb(i + 1, total, step));

      // Replace variables in step
      const stepValue = step.value ? this.replaceVariables(step.value, variables) : undefined;
      const stepUrl = step.url ? this.replaceVariables(step.url, variables) : undefined;
      const stepSelector = step.selector ? this.replaceVariables(step.selector, variables) : undefined;

      try {
        switch (step.type) {
          case 'navigate':
            if (stepUrl) {
              await this.sendCommand('Page.navigate', { url: stepUrl });
              await this.waitForPageLoad();
            }
            break;
          case 'click':
            if (stepSelector) {
              await this.click(stepSelector);
            }
            break;
          case 'fill':
            if (stepSelector && stepValue !== undefined) {
              await this.fill(stepSelector, stepValue);
            }
            break;
          case 'scroll':
            if (step.direction && step.amount) {
              await this.scroll(step.direction, step.amount);
            }
            break;
        }
        // Small delay between steps for stability
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.error(`[BrowserManager] Replay step ${i + 1}/${total} failed:`, err);
        // Continue with next step rather than aborting entirely
      }
    }

    // Final progress notification
    this.replayProgressCallbacks.forEach((cb) => cb(total, total, steps[total - 1]));

    console.log(`[BrowserManager] Workflow "${name}" replayed (${total} steps)`);
    return { name, completed: true, stepCount: total };
  }

  /** ——— Events ——— */

  /** Register a callback for URL changes. */
  onUrlChanged(cb: UrlChangedCallback): void {
    this.urlChangedCallbacks.push(cb);
  }

  /** Register a callback for recording state changes. */
  onRecordingState(cb: RecordingStateCallback): void {
    this.recordingStateCallbacks.push(cb);
  }

  /** Register a callback for replay progress. */
  onReplayProgress(cb: ReplayProgressCallback): void {
    this.replayProgressCallbacks.push(cb);
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
