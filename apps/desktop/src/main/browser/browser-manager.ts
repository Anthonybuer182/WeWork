import { chromium, type Page, type Browser, type Frame } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { RECORDING_SCRIPT, RECORDING_MESSAGE_PREFIX } from './recording-script';

/** CDP endpoint — Electron's remote-debugging-port. */
const CDP_ENDPOINT = 'http://localhost:19222';

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
 * BrowserManager — manages Playwright connection to the Electron webview,
 * browser automation, and recording/replay of workflows.
 *
 * The manager maintains a persistent CDP connection so both the agent
 * (via CLI → HTTP API) and the user (via webview) interact with the
 * same browser instance.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private recording = false;
  private recordedSteps: WorkflowStep[] = [];
  private consoleHandler: ((msg: { text: () => string }) => void) | null = null;
  private urlChangedCallbacks: UrlChangedCallback[] = [];
  private recordingStateCallbacks: RecordingStateCallback[] = [];
  private replayProgressCallbacks: ReplayProgressCallback[] = [];
  private workflowsDir: string;

  constructor(workflowsDir?: string) {
    this.workflowsDir = workflowsDir ?? join(homedir(), '.pi', 'agent', 'workflows');
  }

  /** Connect to the Electron app's Chromium via CDP and find the webview page. */
  async connect(): Promise<void> {
    this.browser = await chromium.connectOverCDP(CDP_ENDPOINT);

    // Find the webview page. Electron webviews appear as separate pages
    // in the CDP session. We look for pages whose URL doesn't match the
    // main app window (which is the renderer).
    await this.findWebviewPage();

    if (!this.page) {
      throw new Error('No webview page found. Ensure the Browser tab is open.');
    }

    // Set up URL change monitoring
    this.page.on('framenavigated', (frame: Frame) => {
      if (frame === this.page!.mainFrame()) {
        const url = frame.url();
        this.urlChangedCallbacks.forEach((cb) => cb(url));
      }
    });

    console.log('[BrowserManager] Connected to webview page');
  }

  /** Find the webview page from all CDP contexts. */
  private async findWebviewPage(): Promise<void> {
    if (!this.browser) return;

    const contexts = this.browser.contexts();
    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        const url = page.url();
        // The webview page will have a URL that's not the app's renderer URL
        // (which is either a file:// or http://localhost:vite-port URL)
        // Webview pages typically have about:blank or external URLs
        if (!url.includes('localhost') && !url.startsWith('file://') && !url.includes('pi-coding-agent')) {
          this.page = page;
          return;
        }
      }
    }

    // If no webview page found, try the first non-main page
    for (const context of contexts) {
      const pages = context.pages();
      if (pages.length > 1) {
        // Second page is likely the webview
        this.page = pages[1];
        return;
      }
    }
  }

  /** Set the active webview page (called when webview is created/changed). */
  async setPage(page: Page): Promise<void> {
    // Clean up old page listeners
    if (this.page && this.consoleHandler) {
      this.page.off('console', this.consoleHandler);
    }

    this.page = page;

    this.page.on('framenavigated', (frame: Frame) => {
      if (frame === this.page!.mainFrame()) {
        const url = frame.url();
        this.urlChangedCallbacks.forEach((cb) => cb(url));
      }
    });

    // Re-attach recording handler if recording
    if (this.recording && this.consoleHandler) {
      this.page.on('console', this.consoleHandler);
    }
  }

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

  /** Ensure we're connected and have a page. */
  private ensurePage(): Page {
    if (!this.page) {
      throw new Error('Browser not connected. Open the Browser tab first.');
    }
    return this.page;
  }

  /** Navigate to a URL. */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = this.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  /** Get the current URL and title. */
  async getUrl(): Promise<{ url: string; title: string }> {
    const page = this.ensurePage();
    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  /** Take an accessibility snapshot and format it as a text tree with refs. */
  async getSnapshot(): Promise<string> {
    const page = this.ensurePage();

    // Use page.evaluate to extract a simplified DOM tree with role/name info.
    // This replaces the deprecated page.accessibility.snapshot() API.
    const tree = await page.evaluate(() => {
      function buildNode(el: Element, depth: number, ref: string): string {
        const indent = '  '.repeat(depth);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') ?? '';
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        const text = (el.textContent ?? '').trim().slice(0, 50);
        const name = ariaLabel || text;

        // Skip non-interactive, non-visible elements
        const computedStyle = window.getComputedStyle(el);
        if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
          return '';
        }

        const nodeRef = ref + (depth + 1);
        let line = `${indent}[${nodeRef}] `;
        if (role) {
          line += `${role}`;
        } else {
          line += tag;
        }
        if (name) {
          line += `: "${name}"`;
        }

        const childLines: string[] = [];
        const children = el.children;
        for (let i = 0; i < children.length; i++) {
          const childRef = nodeRef + '.' + (i + 1) + '.';
          const childLine = buildNode(children[i], depth + 1, childRef);
          if (childLine) childLines.push(childLine);
        }

        return [line, ...childLines].join('\n');
      }

      const body = document.body;
      if (!body) return '(empty page)';
      return buildNode(body, 0, '');
    });

    return tree;
  }

  /** Click an element by selector. */
  async click(selector: string): Promise<{ selector: string; clicked: boolean }> {
    const page = this.ensurePage();
    await page.locator(selector).first().click({ timeout: 10000 });
    return { selector, clicked: true };
  }

  /** Fill an input by selector. */
  async fill(selector: string, value: string): Promise<{ selector: string; value: string }> {
    const page = this.ensurePage();
    await page.locator(selector).first().fill(value, { timeout: 10000 });
    return { selector, value };
  }

  /** Take a screenshot and return base64. */
  async screenshot(): Promise<{ base64: string }> {
    const page = this.ensurePage();
    const buffer = await page.screenshot({ type: 'png' });
    return { base64: buffer.toString('base64') };
  }

  /** Scroll the page. */
  async scroll(direction: 'up' | 'down', amount = 500): Promise<{ direction: string; amount: number }> {
    const page = this.ensurePage();
    const dy = direction === 'down' ? amount : -amount;
    await page.evaluate(`window.scrollBy(0, ${dy})`);
    return { direction, amount };
  }

  /** Evaluate a JavaScript expression in the page. */
  async evaluate(expression: string): Promise<{ result: unknown }> {
    const page = this.ensurePage();
    const result = await page.evaluate(expression);
    return { result };
  }

  // ── Recording ──

  /** Start recording user interactions. */
  async startRecording(): Promise<{ started: boolean }> {
    const page = this.ensurePage();
    this.recording = true;
    this.recordedSteps = [];

    // Set up console handler to capture recording messages
    this.consoleHandler = (msg) => {
      const text = msg.text();
      if (text.startsWith(RECORDING_MESSAGE_PREFIX)) {
        try {
          const step = JSON.parse(text.slice(RECORDING_MESSAGE_PREFIX.length));
          this.recordedSteps.push(step);
        } catch {
          // Ignore malformed messages
        }
      }
    };

    page.on('console', this.consoleHandler);

    // Inject the recording script
    await page.evaluate(RECORDING_SCRIPT);

    this.recordingStateCallbacks.forEach((cb) => cb(true));
    console.log('[BrowserManager] Recording started');
    return { started: true };
  }

  /** Stop recording and return captured steps. */
  async stopRecording(): Promise<{ steps: WorkflowStep[] }> {
    const page = this.ensurePage();

    // Remove the recording script (cleanup)
    await page.evaluate(() => {
      // The script set window.__piBrowserRecording; we can't fully undo the
      // event listeners without a page reload, but we stop collecting.
      (window as unknown as Record<string, unknown>).__piBrowserRecording = false;
    }).catch(() => {
      // Ignore errors if page navigated away
    });

    if (this.consoleHandler) {
      page.off('console', this.consoleHandler);
      this.consoleHandler = null;
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

  // ── Workflow management ──

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
    const page = this.ensurePage();
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
              await page.goto(stepUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
            break;
          case 'click':
            if (stepSelector) {
              await page.locator(stepSelector).first().click({ timeout: 10000 });
            }
            break;
          case 'fill':
            if (stepSelector && stepValue !== undefined) {
              await page.locator(stepSelector).first().fill(stepValue, { timeout: 10000 });
            }
            break;
          case 'scroll':
            if (step.direction && step.amount) {
              const dy = step.direction === 'down' ? step.amount : -step.amount;
              await page.evaluate(`window.scrollBy(0, ${dy})`);
            }
            break;
        }
        // Small delay between steps for stability
        await page.waitForTimeout(300);
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

  /** Disconnect from CDP. */
  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
