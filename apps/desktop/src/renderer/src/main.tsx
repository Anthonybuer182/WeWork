import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@pi/ui/globals.css';

// ── Content Security Policy ──────────────────────────────────────────
// file:// (packaged) pages get no CSP by default and Electron warns on
// every boot. Inject a meta policy before the app mounts; dev keeps the
// Vite HMR requirements (ws + inline react-refresh preamble).
const isDev = location.protocol !== 'file:';
const csp = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: pi-plugin:",
  "font-src 'self' data:",
  // Vite HMR (dev) + plugin panel iframes (pi-plugin:// unique origins).
  isDev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
  "frame-src pi-plugin:",
  "worker-src 'self' blob:",
].join('; ');
const meta = document.createElement('meta');
meta.httpEquiv = 'Content-Security-Policy';
meta.content = csp;
document.head.appendChild(meta);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
