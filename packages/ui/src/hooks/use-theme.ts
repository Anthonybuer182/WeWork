import { useEffect } from 'react';
import { useThemeStore } from '../stores/theme-store';

export function useTheme() {
  const { theme, resolvedTheme, setTheme, setResolvedTheme } = useThemeStore();

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const updateResolved = () => {
      if (theme === 'system') {
        const resolved = mediaQuery.matches ? 'dark' : 'light';
        setResolvedTheme(resolved);
        applyTheme(resolved);
      } else {
        setResolvedTheme(theme);
        applyTheme(theme);
      }
    };

    updateResolved();

    const handler = () => {
      if (theme === 'system') {
        updateResolved();
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme, setResolvedTheme]);

  return { theme, resolvedTheme, setTheme };
}

function applyTheme(theme: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  syncNativeTitleBar();
}

/**
 * Push the resolved theme colors to the host's native window chrome — Windows
 * draws its caption buttons via `titleBarOverlay` and has to be told the color.
 * No-op in the browser build, which has no preload bridge.
 */
function syncNativeTitleBar() {
  const api = (window as unknown as {
    electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
  }).electronAPI;
  if (!api?.invoke) return;

  // Read the tokens back off the DOM so this stays correct if the palette
  // changes — no color values are duplicated here.
  const styles = getComputedStyle(document.body);
  const color = styles.backgroundColor;
  const symbolColor = styles.color;
  if (!color || !symbolColor) return;

  api.invoke('pi:window:setTitleBarOverlay', { color, symbolColor }).catch(() => {});
}
