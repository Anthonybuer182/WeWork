import { protocol } from 'electron';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import type { PluginRegistry } from './registry';
import { PI_SDK_FILENAME, buildPluginSdkJs } from './plugin-sdk-js';

export const PI_PLUGIN_SCHEME = 'pi-plugin';

/** Reserved first path segments (host-provided, not plugin files). */
const WS_FILE_ENDPOINT = '/ws-file';

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
      return await handleRequest(registry, request);
    } catch (err) {
      console.error('[pi-plugin] handler error:', err);
      return new Response('Internal error', { status: 500 });
    }
  });
}

async function handleRequest(registry: PluginRegistry, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pluginId = url.hostname.toLowerCase();
  const pathname = decodeURIComponent(url.pathname);

  // Reserved: host-provided SDK script.
  if (pathname === '/' + PI_SDK_FILENAME) {
    return serveSdk(pluginId);
  }

  // Reserved: raw workspace-file streaming (binary channel for viewer
  // plugins). Permission-gated on the requesting plugin's manifest.
  if (pathname === WS_FILE_ENDPOINT) {
    return serveWorkspaceFile(registry, pluginId, url, request);
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

/**
 * `pi-plugin://<id>/ws-file?path=<absolute>` → raw bytes of a workspace file.
 * Only plugins whose manifest declares the `filesystem` permission may stream
 * through their own origin; cross-origin reads stay blocked (no CORS), so the
 * bytes never leak to other plugins' frames. Supports HTTP Range so video /
 * large-file viewers can seek.
 */
function serveWorkspaceFile(registry: PluginRegistry, pluginId: string, url: URL, request: Request): Response {
  const plugin = registry.get(pluginId);
  const permissions = plugin?.manifest.permissions ?? [];
  if (!permissions.includes('filesystem')) {
    return new Response('Forbidden: plugin lacks filesystem permission', { status: 403 });
  }
  const filePath = url.searchParams.get('path') ?? '';
  if (!filePath || !filePath.startsWith('/')) {
    return new Response('Bad Request: absolute path required', { status: 400 });
  }
  if (!existsSync(filePath)) {
    return new Response('Not found', { status: 404 });
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return new Response('Not a file', { status: 400 });
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const commonHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };

  // Range request → 206 partial content (video seeking, chunked fetch).
  const range = request.headers.get('range');
  const rangeMatch = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (rangeMatch) {
    const start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
    const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` },
      });
    }
    const chunk = Buffer.alloc(end - start + 1);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, chunk, 0, chunk.length, start);
    } finally {
      closeSync(fd);
    }
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(chunk.length),
      },
    });
  }

  return new Response(new Uint8Array(readFileSync(filePath)), {
    headers: { ...commonHeaders, 'Content-Length': String(stat.size) },
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
