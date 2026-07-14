import { webContents } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { RECORDING_SCRIPT, RECORDING_MESSAGE_PREFIX } from './recording-script';

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
  private workflowsDir: string;

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
    this.injectWindowOpenOverride();

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
        // Re-inject window.open override after each navigation
        this.injectWindowOpenOverride();
      }
    });

    // Enable necessary CDP domains
    await this.sendCommand('Page.enable');
    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Accessibility.enable');

    // Inject the window.open override immediately
    this.injectWindowOpenOverride();

    console.log('[BrowserManager] Connected to webview via debugger API');
  }

  /** Inject JS to override window.open and rewrite target="_blank" links so they navigate in-place. */
  private injectWindowOpenOverride(): void {
    if (!this.webviewWc) return;
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

  /** Take an accessibility snapshot and format it as a text tree with refs. */
  async getSnapshot(): Promise<string> {
    try {
      // Use DOM-based snapshot (more reliable than AXTree)
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `(function() {
          function buildNode(el, depth, ref) {
            var indent = '  '.repeat(depth);
            var tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
            var role = el.getAttribute('role') || '';
            var ariaLabel = el.getAttribute('aria-label') || '';
            var text = (el.textContent || '').trim().slice(0, 50);
            var name = ariaLabel || text;

            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return '';

            var nodeRef = ref + (depth + 1);
            var line = indent + '[' + nodeRef + '] ';
            if (role) line += role;
            else line += tag;
            if (name) line += ': "' + name + '"';

            var childLines = [];
            var children = el.children;
            for (var i = 0; i < children.length && i < 50; i++) {
              var childRef = nodeRef + '.' + (i + 1) + '.';
              var childLine = buildNode(children[i], depth + 1, childRef);
              if (childLine) childLines.push(childLine);
            }

            return [line].concat(childLines).join('\\n');
          }

          var body = document.body;
          if (!body) return '(empty page)';
          return buildNode(body, 0, '');
        })()`,
        returnByValue: true,
      });

      return (result?.result as { value?: string })?.value ?? '(empty page)';
    } catch {
      return '(snapshot unavailable)';
    }
  }

  /** ——— Interaction ——— */

  /** Click an element by selector. */
  async click(selector: string): Promise<{ selector: string; clicked: boolean }> {
    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: `(function(){
        var el = document.querySelector('${escapedSelector}');
        if (el) { el.scrollIntoView({block:'center'}); el.click(); return true; }
        return false;
      })()`,
      returnByValue: true,
    });
    const clicked = (result?.result as { value?: boolean })?.value ?? false;
    return { selector, clicked };
  }

  /** Fill an input by selector. Uses the native value setter to support React/Vue controlled inputs. */
  async fill(selector: string, value: string): Promise<{ selector: string; value: string }> {
    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    await this.sendCommand('Runtime.evaluate', {
      expression: `(function(){
        var el = document.querySelector('${escapedSelector}');
        if (!el) return;
        el.focus();

        // Use native value setter for React/Vue controlled inputs
        var tag = el.tagName && el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(el, '${escapedValue}');
          } else {
            el.value = '${escapedValue}';
          }
        } else if (el.isContentEditable) {
          el.textContent = '${escapedValue}';
        } else {
          el.value = '${escapedValue}';
        }

        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
      })()`,
      returnByValue: true,
    });
    return { selector, value };
  }

  /** Take a screenshot and return base64. */
  async screenshot(): Promise<{ base64: string }> {
    const result = await this.sendCommand('Page.captureScreenshot', {
      format: 'png',
    });
    return { base64: (result?.data as string) ?? '' };
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

  /** ——— Viewport ——— */

  /** Override the webview's device metrics to match the panel width. */
  async setDeviceMetrics(width: number, height: number): Promise<void> {
    await this.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: 1,
      mobile: false,
    });
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
