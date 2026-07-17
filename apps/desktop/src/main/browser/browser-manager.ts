import { webContents } from 'electron';
import { BROWSER_HELPERS_JS } from './browser-helpers';
import type { VlmAnalyzer } from './vlm-analyzer';

/** Snapshot node — simplified accessibility tree. */
export interface SnapshotNode {
  role: string;
  name: string;
  ref?: string;
  children?: SnapshotNode[];
}

/** Page analysis — platform-agnostic page classification after navigation. */
export interface PageAnalysis {
  /** 'content' = normal page, 'gate' = few elements (login/auth), 'error' = error page, 'empty' = nothing rendered yet  */
  pageState: 'content' | 'gate' | 'error' | 'loading' | 'empty';
  /** Count of visible interactive elements */
  elementCount: number;
  /** Action-oriented buttons/links found on the page with risk classification */
  coreActions: Array<{ text: string; risk: 'low' | 'high' }>;
  /** Whether the page has text/password/email input fields */
  hasForm: boolean;
  /** Human-readable summary of page state, e.g. "Gate page with low-risk action(s): '登录'. Safe to auto-click." */
  summary: string;
}

/** Result of a single navigation step in a walk. */
export interface WalkStep {
  /** The text label that was searched for */
  action: string;
  /** How the element was clicked */
  selector: string;
  /** Whether this step succeeded */
  success: boolean;
  /** Error message if step failed */
  error?: string;
}

/** Result of a goal-oriented navigation via walk(). */
export interface WalkResult {
  /** Original goal description */
  goal: string;
  /** Destination URL after walk completed */
  url: string;
  /** Destination page title */
  title: string;
  /** Whether the walk reached a new page (not stuck on the starting page) */
  reached: boolean;
  /** Individual steps taken */
  steps: WalkStep[];
  /** Final page analysis after walk */
  page: PageAnalysis;
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

  /**
   * Navigate to a URL and analyze the resulting page.
   *
   * By default, automatically handles gate pages (login, authorization, etc.)
   * by clicking low-risk action buttons. Set `autoHandleGate: false` to disable.
   */
  async navigate(
    url: string,
    options?: { autoHandleGate?: boolean; maxGateRetries?: number },
  ): Promise<{ url: string; title: string; page: PageAnalysis }> {
    const autoHandleGate = options?.autoHandleGate !== false;
    const maxGateRetries = options?.maxGateRetries ?? 2;

    await this.sendCommand('Page.navigate', { url });
    // Wait for page to load (DOM complete)
    await this.waitForPageLoad();
    // Extra wait for SPA rendering (JS-heavy pages like WeChat, DingTalk)
    await this.waitForSpaReady();
    let title = await this.getTitle();
    let currentUrl = await this.getCurrentUrl();
    // Analyze page to help LLM determine next action
    let page = await this.analyzePage();

    // Auto-handle gate pages: click low-risk actions (login, agree, confirm, etc.)
    if (autoHandleGate) {
      let retries = 0;
      while (page.pageState === 'gate' && retries < maxGateRetries) {
        const lowRiskAction = page.coreActions.find((a) => a.risk === 'low');
        if (!lowRiskAction) break;

        console.log('[BrowserManager] Gate page detected, auto-clicking:', lowRiskAction.text);
        const clickResult = await this.click(`text="${lowRiskAction.text}"`);
        if (!clickResult.clicked) {
          console.warn('[BrowserManager] Auto-click failed:', clickResult.error);
          break;
        }

        // Wait for page to change after click
        await this.waitForPageLoad();
        await this.waitForSpaReady();

        title = await this.getTitle();
        currentUrl = await this.getCurrentUrl();
        page = await this.analyzePage();
        retries++;
      }

      if (page.pageState === 'gate' && retries >= maxGateRetries) {
        console.warn(
          '[BrowserManager] Gate page persists after',
          maxGateRetries,
          'retries. May require manual action (e.g., QR code scan).',
        );
      }
    }

    return { url: currentUrl, title, page };
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

  /**
   * Wait for SPA (React/Vue/Angular) pages to finish rendering.
   *
   * After `readyState === 'complete'`, JS-heavy pages still need time to
   * bootstrap the framework and render the actual UI. We wait a minimum
   * time, then poll for DOM stability (no new children added).
   */
  private async waitForSpaReady(timeoutMs = 8000): Promise<void> {
    const minWaitMs = 1500; // Minimum time for SPA to bootstrap
    const stabilityPollMs = 500;
    const stableThreshold = 2; // Consecutive stable polls needed

    const start = Date.now();

    // Minimum wait for SPA to bootstrap
    const elapsed = Date.now() - start;
    if (elapsed < minWaitMs) {
      await new Promise((r) => setTimeout(r, minWaitMs - elapsed));
    }

    // Poll for DOM stability
    let stableCount = 0;
    let lastCount = -1;

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sendCommand('Runtime.evaluate', {
          expression: 'document.body ? document.body.children.length : 0',
          returnByValue: true,
        });
        const count = (result?.result as { value?: number })?.value ?? 0;

        if (count === lastCount) {
          stableCount++;
          if (stableCount >= stableThreshold) return; // DOM stable
        } else {
          stableCount = 0;
          lastCount = count;
        }
      } catch {
        // Ignore transient eval errors
      }
      await new Promise((r) => setTimeout(r, stabilityPollMs));
    }
    // If we time out, proceed anyway — the page is as ready as it'll get
  }

  /**
   * Analyze the current page state. Runs `piAnalyzePage()` in the page context
   * to classify the page type and extract core actions the LLM might want to take.
   */
  private async analyzePage(): Promise<PageAnalysis> {
    try {
      // Ensure helpers are injected
      await this.sendCommand('Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: 'window.piAnalyzePage ? JSON.stringify(window.piAnalyzePage()) : null',
        returnByValue: true,
      });
      const value = (result?.result as { value?: string })?.value;
      if (value) return JSON.parse(value) as PageAnalysis;
    } catch {
      // Page analysis is best-effort
    }

    return {
      pageState: 'empty',
      elementCount: 0,
      coreActions: [],
      hasForm: false,
      summary: 'Page analysis unavailable',
    };
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

  /** Search for interactive elements matching a semantic query.
   *  Returns scored matches with text, role, ref ID, and page section. */
  async find(query: string): Promise<Array<{ score: number; role: string; text: string; section: string }>> {
    try {
      await this.sendCommand('Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `window.piFind ? JSON.stringify(window.piFind(${JSON.stringify(query)})) : null`,
        returnByValue: true,
      });
      const value = (result?.result as { value?: string })?.value;
      if (value) return JSON.parse(value);
    } catch (err) {
      console.warn('[BrowserManager] find error:', err);
    }
    return [];
  }

  /** Take a snapshot grouped by page section (sidebar, header, main, footer). */
  async getStructuredSnapshot(): Promise<string> {
    try {
      await this.sendCommand('Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: 'window.piSnapshotStructured ? window.piSnapshotStructured() : "(structured snapshot unavailable)"',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? '(empty page)';
    } catch {
      return '(structured snapshot unavailable)';
    }
  }

  /**
   * Goal-oriented navigation: use VLM to plan a navigation path from a screenshot,
   * then execute it automatically.
   *
   * This is the universal, platform-agnostic navigation method. The LLM only
   * specifies a GOAL (e.g. "article editor"), and the VLM reads the actual UI
   * text from the screenshot to plan the path. Works on ANY platform.
   */
  async walk(
    goal: string,
    vlmAnalyzer: VlmAnalyzer,
    maxSteps = 5,
  ): Promise<WalkResult> {
    const startUrl = await this.getCurrentUrl();
    const startTitle = await this.getTitle();
    const steps: WalkStep[] = [];

    // Step 1: Plan the path with VLM
    const screenshot = await this.screenshot();
    const snapshot = await this.getSnapshot().catch(() => '(unavailable)');

    const pathPlanPrompt =
      `You are a navigation planner. The user wants to reach: "${goal}".\n\n` +
      `The current page snapshot shows these interactive elements:\n${snapshot.slice(0, 2500)}\n\n` +
      `Look at the screenshot and plan a path of clicks to reach the goal. ` +
      `Return ONLY a JSON array like [{"text":"Label","where":"sidebar"},...] ` +
      `where "text" is the exact visible text to click and "where" is optional context ` +
      `(sidebar, header, main, footer). Be concise — plan the shortest path. ` +
      `If the goal is already reached (page appears to be the destination), return [].`;

    let pathPlan: Array<{ text: string; where?: string }> = [];

    try {
      const rawPlan = await vlmAnalyzer.analyze(screenshot.base64, pathPlanPrompt);
      if (rawPlan) {
        // Try to extract JSON from the response (it may be wrapped in markdown)
        const jsonMatch = rawPlan.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          pathPlan = JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      console.warn('[walk] VLM path planning failed, falling back to heuristic', err);
    }

    // Heuristic fallback: if VLM returned nothing, split goal into keywords
    if (pathPlan.length === 0 && goal) {
      const keywords = goal.split(/[\s,，、]+/).filter(k => k.length > 1);
      for (const keyword of keywords.slice(0, maxSteps)) {
        const matches = await this.find(keyword);
        if (matches.length > 0 && matches[0].score >= 30) {
          pathPlan.push({ text: matches[0].text, where: matches[0].section });
        }
      }
    }

    // If we still have no path, we can't navigate
    if (pathPlan.length === 0) {
      return {
        goal,
        url: startUrl,
        title: startTitle,
        reached: false,
        steps: [],
        page: await this.analyzePage().catch(() => ({ type: 'unknown' } as unknown as PageAnalysis)),
      };
    }

    // Step 2: Execute the path
    for (const plannedStep of pathPlan) {
      // Try exact text match first
      let clickResult = await this.click(`text="${plannedStep.text}"`);
      // On failure, try fuzzy find
      if (!clickResult.clicked) {
        const matches = await this.find(plannedStep.text);
        if (matches.length > 0 && matches[0].score >= 30) {
          clickResult = await this.click(`text="${matches[0].text}"`);
        }
      }

      steps.push({
        action: `click "${plannedStep.text}"`,
        selector: `text="${plannedStep.text}"`,
        success: clickResult.clicked,
        error: clickResult.clicked ? undefined : clickResult.error || 'Element not found',
      });

      if (!clickResult.clicked) break; // Stop on first failure

      // Wait for navigation / SPA transition
      await this.waitForPageLoad().catch(() => {});
      await this.waitForSpaReady().catch(() => {});
    }

    const finalUrl = await this.getCurrentUrl().catch(() => startUrl);
    const finalTitle = await this.getTitle().catch(() => startTitle);

    return {
      goal,
      url: finalUrl,
      title: finalTitle,
      reached: steps.every(s => s.success),
      steps,
      page: await this.analyzePage().catch(() => ({ type: 'unknown' } as unknown as PageAnalysis)),
    };
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

  /**
   * Universal popup handler: click a trigger element, wait for a popup/dropdown/modal
   * to appear, find a matching option by text, and click it.
   *
   * Works for any popup type: dropdown menus, context menus, selection panels,
   * modal dialogs, date pickers, color pickers, etc.
   *
   * Platform-agnostic — works on WeChat, DingTalk, Xiaohongshu, and any web app.
   *
   * @param triggerSelector - Selector for the element that opens the popup
   * @param optionText - Text to match in the popup options (case-insensitive substring)
   * @param waitMs - Time to wait for popup to render (default 2000ms)
   */
  async clickAndSelect(
    triggerSelector: string,
    optionText: string,
    waitMs = 2000,
  ): Promise<{ trigger: string; matched: string | null; selected: boolean; error?: string }> {
    // 1. Click the trigger element
    const clickResult = await this.click(triggerSelector);
    if (!clickResult.clicked) {
      return { trigger: triggerSelector, matched: null, selected: false, error: clickResult.error ?? 'Click failed' };
    }

    // 2. Wait for popup to appear (animation + network delay)
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // 3. Re-inject helpers so piIsVisible etc. work inside the popup
    await this.sendCommand('Runtime.evaluate', {
      expression: BROWSER_HELPERS_JS,
      returnByValue: true,
    });

    // 4. Multi-strategy search for matching option inside popup containers
    const matcherEscaped = JSON.stringify(optionText.toLowerCase());
    const expr = this.buildExpression(`(function(){
      // Find popup/floating containers (must be visible NOW, after delay)
      var floatingContainers = [];

      // Strategy for finding containers: high z-index + position fixed/absolute
      var containers = document.querySelectorAll('div, ul, ol, section, aside, nav, [role="listbox"], [role="menu"], [role="dialog"], [role="tooltip"], [role="alertdialog"], [role="presentation"], [role="tree"]');
      for (var c = 0; c < containers.length; c++) {
        var el = containers[c];
        if (!el.isConnected) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        var role = el.getAttribute('role') || '';
        var isFloating = false;

        // ARIA role indicates overlay
        if (role === 'listbox' || role === 'menu' || role === 'dialog' || role === 'tooltip' || role === 'alertdialog' || role === 'tree') {
          isFloating = true;
        }

        // High z-index positioned element
        if (!isFloating && (cs.position === 'fixed' || cs.position === 'absolute')) {
          var zIndex = parseInt(cs.zIndex, 10);
          if (zIndex > 10) isFloating = true;
        }

        // Class-based popup patterns
        if (!isFloating && el.children.length > 0 && el.children.length <= 100) {
          var cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
          if (/(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer|picker|panel|flyout|pulldown)/.test(cls)) {
            var zIdx = parseInt(cs.zIndex, 10);
            if (zIdx > 0 || cs.position === 'absolute' || cs.position === 'fixed') {
              isFloating = true;
            }
          }
        }

        if (isFloating && piIsVisible(el)) {
          floatingContainers.push(el);
        }
      }

      // Deduplicate: remove parent containers (keep only top-level floating containers)
      var rootContainers = [];
      for (var d = 0; d < floatingContainers.length; d++) {
        var isChild = false;
        for (var p = 0; p < floatingContainers.length; p++) {
          if (d !== p && floatingContainers[p].contains(floatingContainers[d])) {
            isChild = true;
            break;
          }
        }
        if (!isChild) rootContainers.push(floatingContainers[d]);
      }

      if (rootContainers.length === 0) return null;

      // Search inside each floating container for matching option
      var searchSelectors = [
        '[role="option"]', '[role="menuitem"]', '[role="treeitem"]',
        'li', 'a', 'button', 'option',
        'div[onclick]', 'span[onclick]',
        '.menu-item', '.dropdown-item', '.popup-item',
        '.select-option', '.picker-option'
      ].join(', ');

      var matcher = ${matcherEscaped};

      for (var rc = 0; rc < rootContainers.length; rc++) {
        var container = rootContainers[rc];
        var items = container.querySelectorAll(searchSelectors);

        for (var i = 0; i < items.length; i++) {
          if (!piIsVisible(items[i])) continue;
          var text = (items[i].textContent || '').trim().toLowerCase();

          // Substring match, but exclude very long text (descriptive paragraphs, not menu items)
          if (text.includes(matcher) && text.length < 200) {
            // Click it via DOM events
            items[i].scrollIntoView({block:'center', behavior:'instant'});
            var rect = items[i].getBoundingClientRect();
            items[i].dispatchEvent(new MouseEvent('mouseover', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            // Also try native click() for good measure
            try { items[i].click(); } catch(e) {}
            return items[i].textContent.trim().slice(0, 100);
          }
        }
      }

      // Second pass: search for ANY visible element with matching text inside float containers
      for (var rc2 = 0; rc2 < rootContainers.length; rc2++) {
        var container2 = rootContainers[rc2];
        var allEls = container2.querySelectorAll('*');
        for (var j = 0; j < allEls.length; j++) {
          if (!piIsVisible(allEls[j])) continue;
          var t = (allEls[j].textContent || '').trim().toLowerCase();
          // Exact match on deeper elements
          if (t === matcher && t.length < 100 && allEls[j].children.length === 0) {
            allEls[j].scrollIntoView({block:'center', behavior:'instant'});
            var r = allEls[j].getBoundingClientRect();
            allEls[j].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
            try { allEls[j].click(); } catch(e) {}
            return allEls[j].textContent.trim().slice(0, 100);
          }
        }
      }

      return null;
    })()`);

    const result = await this.sendCommand('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });

    const matched = (result?.result as { value?: string | null })?.value ?? null;

    if (matched) {
      // Small delay for the popup to close after selection
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { trigger: triggerSelector, matched, selected: true };
    }

    return {
      trigger: triggerSelector,
      matched: null,
      selected: false,
      error: `No option matching "${optionText}" found in popup triggered by "${triggerSelector}". The popup may have a different structure — try using \`pi-browser snapshot\` to inspect available options.`,
    };
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

      // Reset zoom to 1.0 for accurate content dimension measurement
      try { this.webviewWc?.setZoomFactor(1); } catch {}
      // Wait for the renderer to repaint after zoom change
      await new Promise((r) => setTimeout(r, 300));
    }

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
        // Viewport screenshot: capture at current zoom level.
        // Do NOT reset zoom — the user wants to see exactly what they're viewing.
        // Use Page.getLayoutMetrics for accurate viewport dimensions.
        const layoutMetrics = await this.sendCommand('Page.getLayoutMetrics', {}) as Record<string, unknown>;
        const cssViewport = layoutMetrics?.cssVisualViewport as Record<string, number> | undefined;
        const vpWidth = cssViewport?.clientWidth ?? 0;
        const vpHeight = cssViewport?.clientHeight ?? 0;

        const result = await this.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: vpWidth > 0 && vpHeight > 0 ? {
            x: 0,
            y: 0,
            width: Math.floor(vpWidth),
            height: Math.floor(vpHeight),
            scale: 1,
          } : undefined,
        });
        return { base64: (result?.data as string) ?? '' };
      }
    } finally {
      // Restore zoom (only if we changed it for full-page)
      if (options?.fullPage) {
        try { this.webviewWc?.setZoomFactor(savedZoom); } catch {}
      }
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
