import { protocol } from 'electron';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import type { PluginRegistry } from './registry';
import { PI_SDK_FILENAME, buildPluginSdkJs } from './plugin-sdk-js';

export const PI_PLUGIN_SCHEME = 'pi-plugin';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Must be called before app ready. */
export function registerPluginSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PI_PLUGIN_SCHEME,
      privileges: {
        // "standard" gives the scheme URL semantics (hostname = plugin id,
        // path resolution), so every plugin gets a unique origin.
        standard: true,
        // "secure" makes the origin potentially trustworthy, which the
        // Origin-Agent-Cluster response header requires.
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Serve plugin files at `pi-plugin://<pluginId>/<path>` from the plugin's
 * resolved root. HTML files get the host SDK injected; HTML responses carry
 * `Origin-Agent-Cluster: 1` so each plugin origin gets its own renderer
 * process (site isolation).
 */
export function registerPluginProtocolHandler(registry: PluginRegistry): void {
  protocol.handle(PI_PLUGIN_SCHEME, async (request) => {
    try {
      return await handleRequest(registry, request.url);
    } catch (err) {
      console.error('[pi-plugin] handler error:', err);
      return new Response('Internal error', { status: 500 });
    }
  });
}

async function handleRequest(registry: PluginRegistry, rawUrl: string): Promise<Response> {
  const url = new URL(rawUrl);
  const pluginId = url.hostname.toLowerCase();
  const pathname = decodeURIComponent(url.pathname);

  // Reserved: host-provided SDK script.
  if (pathname === '/' + PI_SDK_FILENAME) {
    return serveSdk(pluginId);
  }

  const root = registry.getRoot(pluginId);
  if (!root) {
    return new Response(`Unknown plugin: ${pluginId}`, { status: 404 });
  }

  // Resolve and jail the path inside the plugin root.
  let relPath = pathname.replace(/^\/+/, '');
  let filePath = resolve(root, relPath);
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    return new Response('Forbidden', { status: 403 });
  }

  // Directory → index.html
  try {
    if (statSync(filePath).isDirectory()) {
      relPath = join(relPath, 'index.html');
      filePath = join(filePath, 'index.html');
    }
  } catch {
    // not found — fall through
  }

  if (!existsSync(filePath)) {
    return new Response(`Not found: ${relPath}`, { status: 404 });
  }

  const ext = extname(filePath).toLowerCase();
  const body = readFileSync(filePath);

  if (ext === '.html' || ext === '.htm') {
    const html = injectSdk(body.toString('utf-8'), pluginId);
    return new Response(html, {
      headers: {
        'Content-Type': MIME_TYPES['.html'],
        // Force per-origin process isolation for plugin iframes.
        'Origin-Agent-Cluster': '1',
        'Cache-Control': 'no-cache',
      },
    });
  }

  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

function serveSdk(pluginId: string): Response {
  return new Response(buildPluginSdkJs(pluginId), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/** Inject the SDK <script> as the first thing in <head>. */
function injectSdk(html: string, pluginId: string): string {
  const tag = `<script src="pi-plugin://${pluginId}/${PI_SDK_FILENAME}" data-pi-plugin="${pluginId}"></script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + tag);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + `<head>${tag}</head>`);
  }
  return tag + html;
}
