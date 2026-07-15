import http from 'http';
import type { BrowserManager, WorkflowStep } from './browser-manager';

/** Local HTTP server that the pi-browser CLI tool calls. */
export function startBrowserHttpServer(
  browserManager: BrowserManager,
  port = 19223,
): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      const result = await routeRequest(browserManager, req.method ?? 'GET', path, body, url);
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
      case '/snapshot':
        return { snapshot: await browserManager.getSnapshot() };
      case '/screenshot':
        return await browserManager.screenshot(url.searchParams.get('fullPage') === 'true' ? { fullPage: true } : undefined);
      case '/url':
        return await browserManager.getUrl();
      case '/workflows':
        return { workflows: await browserManager.listWorkflows() };
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
        return await browserManager.navigate(body.url as string);
      case '/click':
        return await browserManager.click(body.selector as string);
      case '/fill':
        return await browserManager.fill(body.selector as string, body.value as string);
      case '/hover':
        return await browserManager.hover(body.selector as string);
      case '/select':
        return await browserManager.selectOption(body.selector as string, body.value as string);
      case '/type-and-select':
        return await browserManager.typeAndSelect(
          body.selector as string,
          body.text as string,
          body.option as string,
          (body.wait as number) ?? 1500,
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
      case '/record/start':
        return await browserManager.startRecording();
      case '/record/stop':
        return await browserManager.stopRecording();
      case '/replay': {
        const name = body.name as string;
        const variables = (body.variables as Record<string, string>) ?? {};
        return await browserManager.replay(name, variables);
      }
      case '/workflow/save': {
        const name = body.name as string;
        const steps = body.steps as WorkflowStep[];
        return await browserManager.saveWorkflow(name, steps);
      }
      default:
        throw new Error(`Unknown POST route: ${path}`);
    }
  }

  // DELETE routes
  if (method === 'DELETE') {
    switch (path) {
      case '/workflow': {
        // Name passed as query param
        return await browserManager.deleteWorkflow(body.name as string);
      }
      default:
        throw new Error(`Unknown DELETE route: ${path}`);
    }
  }

  throw new Error(`Method ${method} not supported`);
}
