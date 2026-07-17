import http from 'http';
import type { BrowserManager } from './browser-manager';
import type { VlmAnalyzer } from './vlm-analyzer';

/** Local HTTP server that the pi-browser CLI tool calls. */
export function startBrowserHttpServer(
  browserManager: BrowserManager,
  port = 19223,
  vlmAnalyzer?: VlmAnalyzer,
): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Read request body for POST
    const body = await readBody(req);

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;

    try {
      const result = await routeRequest(browserManager, req.method ?? 'GET', path, body, url, vlmAnalyzer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[BrowserHTTP] Listening on http://127.0.0.1:${port}`);
  });

  return server;
}

/** Read and parse the request body as JSON. */
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Route HTTP requests to BrowserManager methods. */
async function routeRequest(
  browserManager: BrowserManager,
  method: string,
  path: string,
  body: Record<string, unknown>,
  url: URL,
  vlmAnalyzer?: VlmAnalyzer,
): Promise<unknown> {
  // Commands that need the webview to be connected.
  // 'health' is exempt so the CLI can check server availability without a webview.
  const needsConnection = path !== '/health';
  if (needsConnection) {
    await browserManager.ensureConnected();
  }

  // GET routes
  if (method === 'GET') {
    switch (path) {
      case '/snapshot': {
        const structured = url.searchParams.get('structured') === 'true';
        const snapshot = structured
          ? await browserManager.getStructuredSnapshot()
          : await browserManager.getSnapshot();
        return { snapshot };
      }
      case '/screenshot': {
        const fullPage = url.searchParams.get('fullPage') === 'true';
        const screenshot = await browserManager.screenshot(fullPage ? { fullPage: true } : undefined);
        // If analyze=true is passed, run VLM analysis alongside the screenshot
        if (url.searchParams.get('analyze') === 'true' && vlmAnalyzer) {
          const snapshot = await browserManager.getSnapshot().catch(() => '(snapshot unavailable)');
          const analysis = await vlmAnalyzer.analyze(screenshot.base64,
            `The agent is viewing this page. Snapshot: ${snapshot.slice(0, 3000)}`
          );
          return {
            screenshot: screenshot.base64,
            description: analysis ?? '(VLM analysis unavailable)',
            snapshot,
          };
        }
        return { screenshot: screenshot.base64 };
      }
      case '/url':
        return await browserManager.getUrl();
      case '/text':
        return await browserManager.getText();
      case '/health':
        return { status: 'ok' };
      default:
        throw new Error(`Unknown GET route: ${path}`);
    }
  }

  // POST routes
  if (method === 'POST') {
    switch (path) {
      case '/navigate':
        return await browserManager.navigate(body.url as string, {
          autoHandleGate: body.autoHandleGate as boolean | undefined,
          maxGateRetries: body.maxGateRetries as number | undefined,
        });
      case '/click':
        return await withVlmRecovery(
          () => browserManager.click(body.selector as string),
          body.selector as string,
          'click',
          browserManager,
          vlmAnalyzer,
        );
      case '/fill':
        return await withVlmRecovery(
          () => browserManager.fill(body.selector as string, body.value as string),
          body.selector as string,
          `fill "${String(body.value).slice(0, 20)}"`,
          browserManager,
          vlmAnalyzer,
        );
      case '/hover':
        return await withVlmRecovery(
          () => browserManager.hover(body.selector as string),
          body.selector as string,
          'hover',
          browserManager,
          vlmAnalyzer,
        );
      case '/select':
        return await withVlmRecovery(
          () => browserManager.selectOption(body.selector as string, body.value as string),
          body.selector as string,
          `select "${String(body.value).slice(0, 20)}"`,
          browserManager,
          vlmAnalyzer,
        );
      case '/type-and-select':
        return await withVlmRecovery(
          () => browserManager.typeAndSelect(
            body.selector as string,
            body.text as string,
            body.option as string,
            (body.wait as number) ?? 1500,
          ),
          body.selector as string,
          `type-and-select "${String(body.text).slice(0, 20)}"`,
          browserManager,
          vlmAnalyzer,
        );
      case '/click-and-select':
        return await withVlmRecovery(
          () => browserManager.clickAndSelect(
            body.selector as string,
            body.option as string,
            (body.wait as number) ?? 2000,
          ),
          body.selector as string,
          `click-and-select "${String(body.option).slice(0, 20)}"`,
          browserManager,
          vlmAnalyzer,
        );
      case '/press':
        return await browserManager.pressKey(body.key as string);
      case '/wait':
        return await browserManager.waitForSelector(
          body.selector as string,
          (body.timeout as number) ?? 10000,
        );
      case '/text':
        return await browserManager.getText(body.selector as string | undefined);
      case '/attribute':
        return await browserManager.getAttribute(body.selector as string, body.attribute as string);
      case '/scroll':
        return await browserManager.scroll(
          (body.direction as 'up' | 'down') ?? 'down',
          (body.amount as number) ?? 500,
        );
      case '/evaluate':
        return await browserManager.evaluate(body.expression as string);
      case '/find':
        return { matches: await browserManager.find(body.query as string) };
      case '/walk':
        if (!vlmAnalyzer) {
          throw new Error('VLM analyzer is not configured. Walk requires visual analysis to plan navigation paths.');
        }
        return await browserManager.walk(
          body.goal as string,
          vlmAnalyzer,
          (body.maxSteps as number) ?? 5,
        );
      default:
        throw new Error(`Unknown POST route: ${path}`);
    }
  }

  throw new Error(`Method ${method} not supported`);
}

/**
 * Wraps an interactive operation with VLM-powered error recovery.
 *
 * On success: returns the result as-is (zero VLM overhead).
 * On failure: takes a screenshot, runs VLM analysis, and appends the
 * visual description + current snapshot to the error so the text-only
 * agent can understand WHY the operation failed.
 */
async function withVlmRecovery<T>(
  operation: () => Promise<T>,
  selector: string,
  actionLabel: string,
  browserManager: BrowserManager,
  vlmAnalyzer?: VlmAnalyzer,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    // If no VLM, just rethrow the original error
    if (!vlmAnalyzer) throw err;

    try {
      // Capture current page state
      const [screenshot, snapshot] = await Promise.all([
        browserManager.screenshot().catch(() => null),
        browserManager.getSnapshot().catch(() => '(snapshot unavailable)'),
      ]);

      let visualContext = '';
      if (screenshot?.base64) {
        const analysis = await vlmAnalyzer.analyze(
          screenshot.base64,
          `The agent tried to ${actionLabel} on selector "${selector}" but it failed with: ${errorMsg}. ` +
          `Current page snapshot: ${snapshot?.slice(0, 2000) ?? '(unavailable)'}. ` +
          `Explain why this action might have failed and what the agent should try instead.`,
        );
        if (analysis) {
          visualContext = `\n\n[Visual Analysis] ${analysis}`;
        }
      }

      if (snapshot && !snapshot.startsWith('(snapshot')) {
        visualContext += `\n\n[Current Snapshot]\n${snapshot.slice(0, 4000)}`;
      }

      // Augment the error with VLM context
      const augmentedError = new Error(`${errorMsg}${visualContext}`);
      throw augmentedError;
    } catch (vlmErr) {
      // VLM analysis itself failed — just rethrow original error
      throw err;
    }
  }
}
