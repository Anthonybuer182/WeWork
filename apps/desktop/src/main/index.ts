import { app, BrowserWindow, WebContentsView } from 'electron';
import { createMainWindow } from '@main/window-manager';
import { registerIpcHandlers } from '@main/ipc/index';
import { registerNativeIpcHandlers } from '@main/ipc/native';
import { SettingsManager, ModelRegistry, AuthStorage } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserManager, VlmAnalyzer } from '@main/browser';
import { PluginSystem, registerPluginSchemePrivileges } from '@main/plugins';
import { registerPluginIpcHandlers } from '@main/ipc/plugins';
import { registerLiveSlotIpcHandlers, LiveSlotRegistry } from '@main/plugins/slots';
import { PluginWebViews } from '@main/plugins/plugin-webview';
import { createHostAgentTools, type AgentCustomTool } from '@main/agent-tools';
import { PermissionService, installPermissionGate, registerPermissionIpc } from '@main/permissions';

let mainWindow: BrowserWindow | null = null;

// BrowserManager instance — one singleton behind the plugin capability surface
// (browser.*) and the engine live slot the browser plugin's panel embeds via
// piSDK.liveSlot. Agent tools and user clicks drive the same view and the same
// persist session.
export const browserManager = new BrowserManager();

// Native-view slots. Each slot owns its own WebContentsView; the renderer only
// reports where its slot sits, and the registry positions the view to match.
export const liveSlots = new LiveSlotRegistry();

// Enable Chrome DevTools Protocol so external tooling (Playwright, DevTools)
// can connect to the app's own webContents (including the embedded browser
// view) via CDP. Sibling forks of this project bind the same default port —
// PI_CDP_PORT lets a dev run step aside instead of silently losing the race.
app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_CDP_PORT ?? '19222');

// Contract-level plugin isolation: force every site (each pi-plugin:// origin)
// into its own renderer process. Site isolation is Chromium's default, but
// this pins it as a launch guarantee — plugin UI can never share a renderer
// with the host shell regardless of future policy drift.
// app.commandLine.appendSwitch('site-per-process'); // TEMP: 因果实验

// Prevent Chromium from culling the embedded browser view's compositor surface.
// Without these switches, Chromium's window-occlusion detector and
// background-throttler incorrectly mark the view as occluded
// after certain page navigations (notably zhipin.com's anti-bot
// triggered sub-frame loads). The GPU process then fails to produce
// compositor overlays ("Invalid mailbox" / "non-existent mailbox"
// errors in skia_output_device_buffer_queue.cc and
// shared_image_manager.cc), leaving the view permanently white
// while the underlying webContents still renders correctly.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

const gotLock = app.requestSingleInstanceLock();

// Register the plugin scheme BEFORE app ready — every plugin panel is served
// from a unique `pi-plugin://<pluginId>/` origin (process isolation via site
// isolation; see src/main/plugins/protocol.ts).
registerPluginSchemePrivileges();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const settingsManager = SettingsManager.create(app.getPath('home'));

    // Shared ModelRegistry — used by the chat service and the browser walk
    // planner's VLM analyzer.
    const sharedModelRegistry = ModelRegistry.create(AuthStorage.inMemory());
    // VLM analyzer for goal-directed browser navigation (gracefully handles
    // missing VLM config).
    const vlmAnalyzer = new VlmAnalyzer(sharedModelRegistry, { timeoutMs: 15000 });

    injectBundledShell(settingsManager);

    mainWindow = createMainWindow();

    // Create the embedded browser as a WebContentsView (the modern replacement
    // for BrowserView, which is deprecated since Electron 30). Like BrowserView
    // it owns a persistent webContents — no guest recreation on redirects, no
    // use-after-free — but it attaches through `contentView.addChildView`, which
    // can hold more than one view.
    const browserView = new WebContentsView({
      webPreferences: {
        partition: 'persist:pi-browser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Prevent Chromium from throttling/hiding the view's compositor
        // surface when the window is occluded or backgrounded — without this,
        // the view can go permanently white while the webContents still
        // has rendered content (this is what caused the zhipin.com blanking bug).
        backgroundThrottling: false,
      },
    });
    // Hide initially — bounds are set by the renderer when the browser panel opens.
    // (No setAutoResize: WebContentsView keeps exactly the bounds it is given,
    // which is what we want — the renderer owns layout.)
    browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    mainWindow.contentView.addChildView(browserView);
    browserManager.setBrowserView(browserView, mainWindow);

    // The engine view has no host panel of its own any more: the browser
    // plugin's panel embeds it via piSDK.liveSlot, and plugin-webview.ts
    // registers the `<pluginId>:page` slot for it.

    // A renderer reload never runs React cleanup, so slots vanish without
    // calling detach — their views would keep stale bounds and invisibly
    // occlude the UI (eating real mouse clicks). Reset every slot on any
    // renderer navigation; each slot re-reports its bounds after remounting.
    mainWindow.webContents.on('did-start-navigation', () => {
      console.log('[slots] renderer navigation — hiding all native views (stale-overlay guard)');
      liveSlots.hideAll();
    });

    // Warm up the CDP connection at boot. The legacy preview panel used to do
    // this on mount; with the browser now plugin-owned, pre-connect here so
    // the first browser.* capability call doesn't pay the attach latency.
    browserManager.connect().catch(() => {});

    registerNativeIpcHandlers();

    // Plugin kernel: scan ~/.pi/agent/plugins (plus the dev root when set),
    // spawn backend UtilityProcesses, serve pi-plugin:// and expose IPC.
    // Created BEFORE the SDK IPC handlers so plugin tools can be injected
    // into the agent session (customTools).
    const pluginSystem = new PluginSystem({
      browserManager,
      vlmAnalyzer,
      // chat.send: relay a plugin's message to the renderer, which owns the composer.
      sendToRenderer: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    });
    // Register IPC handlers BEFORE init completes — the file:// renderer loads
    // in milliseconds in packaged builds, and its first `pi:plugin:list` must
    // queue behind kernel boot (whenReady) instead of rejecting outright.
    registerPluginIpcHandlers(pluginSystem);
    await pluginSystem.init();
    registerLiveSlotIpcHandlers(liveSlots);

    // Plugin web panels are hosted in native views, not iframes: a panel gets a
    // real top-level frame (correct IME, working print/alert/download, its own
    // renderer process). Registered against the same live-slot registry as the
    // browser preview, so `hideAll()`'s renderer-navigation guard covers them.
    const pluginWebViews = new PluginWebViews({
      registry: pluginSystem.registry,
      liveSlots,
      getWindow: () => mainWindow,
      browserManager,
    });
    pluginWebViews.installIpc();
    pluginWebViews.sync();

    // A reused panel view never re-requests its backend port (its page did not
    // reload), so the host pushes a fresh pair whenever a backend (re)starts —
    // disable→enable, install, rollback, crash restart.
    pluginSystem.onBackendStarted = (pluginId) => {
      pluginWebViews.rewirePluginPorts(pluginId, (wc) => {
        pluginSystem.ensureUiPort(pluginId, wc);
      });
    };

    // Host-contributed tools are built after the chat service exists, but the
    // provider is only *called* when a session is created — so the array is
    // filled in below and read through this closure.
    let hostTools: AgentCustomTool[] = [];

    // Session-scoped permission modes (默认 / 完全访问). All state lives here in
    // main, keyed by session — nothing persists, so a restart always lands on
    // the safe default. High-risk calls in default mode block the agent until
    // the renderer's inline approval card answers; 完全访问 lets everything
    // through but leaves an audit line behind.
    const permissionService = new PermissionService(
      (payload) => {
        mainWindow?.webContents.send('pi:permission:request', payload);
      },
      (payload) => {
        mainWindow?.webContents.send('pi:permission:cancelled', payload);
      },
    );
    registerPermissionIpc(permissionService);

    const { chatService } = registerIpcHandlers(settingsManager, sharedModelRegistry, {
      customToolsProvider: () => [...hostTools, ...pluginSystem.aggregateTools()],
      pluginDocsProvider: () => pluginSystem.listPluginDocs(),
      onSessionCreated: (session, info) =>
        installPermissionGate(session, info.sessionKey, permissionService),
    });
    hostTools = createHostAgentTools({
      readContextConfig: chatService.getAgentContextConfig.bind(chatService),
    });
    // Plugin tool/doc set changed at runtime → rebuild agent sessions, and
    // pick up panels of plugins that were just installed or enabled.
    pluginSystem.onExtensionsChanged = () => {
      pluginWebViews.sync();
      chatService.invalidateSessions?.();
    };

    // Push browser URL changes to plugin backends holding "browser" permission.
    browserManager.onUrlChanged((url) => {
      pluginSystem.pushHostEvent('browser.urlChanged', 'browser', { url });
    });

    app.on('will-quit', () => pluginSystem.dispose());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * On Windows, detect the bundled MinGit environment (shipped as
 * extraResources) and configure SettingsManager to use it.
 *
 * Standard MinGit provides:
 *   - bash.exe (GNU Bash 4.x)             → set as shellPath (preferred)
 *   - ash.exe (BusyBox POSIX shell)       → fallback if bash.exe is missing
 *   - git.exe                            → added to PATH
 *   - GNU coreutils (ls, cat…)           → added to PATH
 *
 * This is a no-op on macOS and Linux, where the OS ships a shell natively.
 */
function injectBundledShell(settingsManager: SettingsManager): void {
  if (process.platform !== 'win32') return;

  // process.resourcesPath → app's resources directory.
  // The bundled shell is at resources/bash-bundle/ (from extraResources).
  const bundleRoot = join(process.resourcesPath, 'bash-bundle');

  // BusyBox MinGit ships ash.exe (POSIX sh, limited but functional) next to
  // busybox.exe. MinGit ≤2.55 lays this out under mingw64/bin/; 2.56+ moved
  // to ucrt64/bin/ — search both, plus the generic locations.
  const shellNames = ['bash.exe', 'ash.exe'];
  const binDirs = ['mingw64/bin', 'ucrt64/bin', 'bin', 'usr/bin'].map((d) => join(bundleRoot, d));

  let shellPath: string | null = null;
  for (const dir of binDirs) {
    for (const name of shellNames) {
      const p = join(dir, name);
      if (existsSync(p)) { shellPath = p; break; }
    }
    if (shellPath) break;
  }

  if (!shellPath) {
    console.warn('[bash-bundle] No bundled shell found. Falling back to system Git Bash search.');
    // Bundled shell not found. SDK will fall back to searching for Git
    // Bash on the system, then show a clear error if nothing is found.
    return;
  }

  // Integrity check: warn (but proceed) if git.exe is missing — the agent
  // can still run bash commands, but git operations will fail.
  const gitCandidates = ['mingw64/bin', 'ucrt64/bin', 'cmd'].map((d) => join(bundleRoot, d, 'git.exe'));
  const gitExe = gitCandidates.find((p) => existsSync(p));
  if (!gitExe) {
    console.warn(`[bash-bundle] git.exe not found (searched ${gitCandidates.join(', ')}). Git operations may fail.`);
  }

  console.log(`[bash-bundle] Using shell: ${shellPath}`);
  settingsManager.setShellPath(shellPath);

  // Add bundled bin dirs to PATH so git, coreutils, and msys-2.0.dll
  // can be found. On MSYS2, Windows paths are mapped as:
  //   C:\foo\bar → /c/foo/bar
  const pathDirs = [
    join(bundleRoot, 'mingw64', 'bin'),
    join(bundleRoot, 'ucrt64', 'bin'),
    join(bundleRoot, 'usr', 'bin'),
    join(bundleRoot, 'cmd'),
    join(bundleRoot, 'bin'),
  ].filter((p) => existsSync(p));

  if (pathDirs.length > 0) {
    const unixPaths = pathDirs.map((p) =>
      '/' + p.replace(/^([A-Z]):/i, (_, d) => d.toLowerCase()).replace(/\\/g, '/'),
    );
    settingsManager.setShellCommandPrefix(
      `export PATH="${unixPaths.join(':')}:$PATH"`,
    );
  }
}
