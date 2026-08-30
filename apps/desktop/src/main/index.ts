import { app, BrowserWindow, BrowserView } from 'electron';
import { createMainWindow } from '@main/window-manager';
import { registerIpcHandlers } from '@main/ipc/index';
import { registerNativeIpcHandlers } from '@main/ipc/native';
import { SettingsManager, getAgentDir, ModelRegistry, AuthStorage } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readdirSync, readFileSync, cpSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { exec, execSync } from 'child_process';
import { join, dirname, delimiter } from 'path';
import { fileURLToPath } from 'url';
import { BrowserManager, startBrowserHttpServer, VlmAnalyzer } from '@main/browser';
import { registerBrowserIpcHandlers } from '@main/ipc/browser';
import { PluginSystem, registerPluginSchemePrivileges } from '@main/plugins';
import { registerPluginIpcHandlers } from '@main/ipc/plugins';
import { registerLiveViewIpcHandlers } from '@main/plugins/liveview';

let mainWindow: BrowserWindow | null = null;

// BrowserManager instance — shared between IPC handlers and the HTTP server.
// The HTTP server (port 19223) is the entry point for the pi-browser CLI tool.
export const browserManager = new BrowserManager();

// Enable Chrome DevTools Protocol so Playwright can connect to the
// Electron app's own webContents (including BrowserView) via CDP.
// The CLI tool (pi-browser) talks to a local HTTP server which drives
// Playwright — both agent and user see the same browser instance.
app.commandLine.appendSwitch('remote-debugging-port', '19222');

// Prevent Chromium from culling the BrowserView's compositor surface.
// Without these switches, Chromium's window-occlusion detector and
// background-throttler incorrectly mark the BrowserView as occluded
// after certain page navigations (notably zhipin.com's anti-bot
// triggered sub-frame loads). The GPU process then fails to produce
// compositor overlays ("Invalid mailbox" / "non-existent mailbox"
// errors in skia_output_device_buffer_queue.cc and
// shared_image_manager.cc), leaving the BrowserView permanently white
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

  // Known multimodal model name patterns for auto-detection.
  const MULTIMODAL_NAME_PATTERNS: RegExp[] = [
    /vl/i, /vision/i, /visual/i, /multimodal/i,
    /gpt-4o/i, /gpt-4-turbo/i,
    /claude-3/i, /claude-4/i, /claude-sonnet/i, /claude-opus/i,
    /gemini/i,
    /pixtral/i, /llava/i, /cogv/i, /internvl/i, /minicpm-v/i,
    /deepseek-vl/i, /glm-4v/i, /yi-vl/i, /phi-3-v/i,
    /moondream/i, /paligemma/i, /florence/i, /owlv/i,
    /qwen-vl/i, /qwen2-vl/i, /qwen2.5-vl/i,
    /minimax-m1/i, /minimax-m3/i, /janus/i, /step.*v/i,
    /doubao.*vision/i, /doubao.*vl/i,
    /ernie.*vl/i, /ernie-4/i,
    /hunyuan.*vision/i, /hunyuan.*vl/i, /hunyuan-turbos/i,
    /spark.*vl/i,
  ];

  /** One-time migration: auto-patch existing models.json to mark known multimodal models. */
  function migrateMultimodalModels(): void {
    const path = join(getAgentDir(), 'models.json');
    if (!existsSync(path)) return;

    try {
      const raw = readFileSync(path, 'utf-8');
      const config = JSON.parse(raw);
      if (!config?.providers) return;

      let patched = 0;
      for (const provider of Object.values(config.providers) as any[]) {
        if (!provider.models) continue;
        for (const model of provider.models as any[]) {
          const name = ((model.name || model.id) ?? '').toLowerCase();
          if (
            !model.input?.includes('image') &&
            MULTIMODAL_NAME_PATTERNS.some((p) => p.test(name))
          ) {
            model.input = ['text', 'image'];
            patched++;
            console.log(`[migrate] Auto-detected multimodal model: ${model.id || model.name}`);
          }
        }
      }

      if (patched > 0) {
        writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`[migrate] Patched ${patched} model(s) to include image input support.`);
      }
    } catch (err) {
      // models.json unreadable — continue without migration
      console.warn('[migrate] Could not migrate models.json:', err);
    }
  }

  /**
   * On launch, sync bundled skills from the app's resources into
   * ~/.pi/agent/skills/ so the pi-coding-agent SDK auto-discovers them.
   *
   * Always overwrites app-provided files (SKILL.md, bin/) to ensure
   * the latest versions are used. User-created files are preserved.
   */
  function migrateSkills(): void {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const bundledSource = app.isPackaged
      ? join(process.resourcesPath, 'skills')
      : join(__dirname, '..', '..', 'skills');

    if (!existsSync(bundledSource)) return;

    const targetDir = join(getAgentDir(), 'skills');
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const bundledDirs = readdirSync(bundledSource, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of bundledDirs) {
      const sourcePath = join(bundledSource, dir.name);
      const target = join(targetDir, dir.name);
      if (!existsSync(target)) {
        // New skill — copy entirely
        cpSync(sourcePath, target, { recursive: true });
      } else {
        // Existing skill — sync app-provided files (SKILL.md, bin/)
        const filesToSync = readdirSync(sourcePath, { withFileTypes: true });
        for (const entry of filesToSync) {
          const srcFile = join(sourcePath, entry.name);
          const tgtFile = join(target, entry.name);
          if (entry.isDirectory()) {
            // Always overwrite bin/ directory contents
            cpSync(srcFile, tgtFile, { recursive: true, force: true });
          } else {
            // Overwrite top-level files like SKILL.md
            cpSync(srcFile, tgtFile, { force: true });
          }
        }
      }
    }
  }

  /**
   * Pre-install CLI tools required by bundled skills during app startup.
   * Runs non-blocking: failures are silent (Agent can install on demand).
   */
  function ensureSkillBinaries(): void {
    // Install pi-browser CLI (bundled with the app)
    ensurePiBrowserBinary();

    try {
      execSync('command -v officecli', { stdio: 'ignore' });
      return; // Already in PATH
    } catch {
      // Not installed — download in background
    }

    exec('curl -fsSL https://d.officecli.ai/install.sh | bash', (error) => {
      if (error) {
        console.error('[officecli] Install failed:', error.message);
        return;
      }
      console.log('[officecli] Installed successfully');
    });
  }

  /**
   * Install the pi-browser CLI by symlinking the bundled .mjs script
   * into ~/.local/bin. The script is a thin Node.js wrapper that calls
   * the local HTTP server in the main process.
   */
  function ensurePiBrowserBinary(): void {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const binSource = app.isPackaged
      ? join(process.resourcesPath, 'skills', 'browser', 'bin', 'pi-browser.mjs')
      : join(__dirname, '..', '..', 'skills', 'browser', 'bin', 'pi-browser.mjs');

    if (!existsSync(binSource)) {
      console.warn('[pi-browser] Source not found:', binSource);
      return;
    }

    if (process.platform === 'win32') {
      ensurePiBrowserBinaryWindows(binSource);
    } else {
      ensurePiBrowserBinaryUnix(binSource);
    }
  }

  function ensurePiBrowserBinaryUnix(binSource: string): void {
    const installDir = join(homedir(), '.local', 'bin');
    const installTarget = join(installDir, 'pi-browser');

    // Already installed and pointing to the right place
    try {
      if (existsSync(installTarget)) {
        const link = execSync(`readlink "${installTarget}" 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
        if (link === binSource) return; // Already linked correctly
      }
    } catch {
      // readlink failed, proceed with install
    }

    try {
      mkdirSync(installDir, { recursive: true });
      execSync(`chmod +x "${binSource}"`);
      execSync(`rm -f "${installTarget}"`);
      execSync(`ln -s "${binSource}" "${installTarget}"`);
      execSync(`chmod +x "${installTarget}"`);
      console.log('[pi-browser] Installed to', installTarget);
    } catch (err) {
      console.error('[pi-browser] Install failed:', err);
    }
  }

  function ensurePiBrowserBinaryWindows(binSource: string): void {
    const installDir = join(homedir(), '.local', 'bin');
    const installTarget = join(installDir, 'pi-browser.cmd');

    const cmdContent = `@echo off\r\nnode "${binSource}" %*`;

    try {
      // Check if already installed with correct content
      if (existsSync(installTarget)) {
        const existing = execSync(`type "${installTarget}" 2>nul || echo ""`, {
          encoding: 'utf-8',
          windowsHide: true,
        }).trim();
        if (existing.includes(binSource)) return;
      }
    } catch {
      // proceed with install
    }

    try {
      mkdirSync(installDir, { recursive: true });
      writeFileSync(installTarget, cmdContent, { encoding: 'utf-8' });
      console.log('[pi-browser] Installed to', installTarget);

      // Best-effort: add install directory to user PATH
      ensureWindowsPath(installDir);
    } catch (err) {
      console.error('[pi-browser] Windows install failed:', err);
    }
  }

  function ensureWindowsPath(dir: string): void {
    // Check if already in current PATH
    if ((process.env.PATH ?? '').toLowerCase().includes(dir.toLowerCase())) return;

    // Check user PATH from registry
    try {
      const regOutput = execSync('reg query "HKCU\\Environment" /v Path 2>nul', {
        encoding: 'utf-8', windowsHide: true,
      });
      if (regOutput.toLowerCase().includes(dir.toLowerCase())) return;
    } catch {}

    // Use PowerShell .NET API (no 1024-char limit, preserves REG_EXPAND_SZ)
    try {
      execSync(
        `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '${dir};' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"`,
        { windowsHide: true },
      );
      // Also update current process PATH so it takes effect immediately
      process.env.PATH = dir + delimiter + (process.env.PATH ?? '');
    } catch {
      // Best-effort only
    }
  }

  app.whenReady().then(async () => {
    const settingsManager = SettingsManager.create(app.getPath('home'));

    // Migrate existing models.json: auto-detect multimodal models that
    // were configured before the auto-detection feature existed (e.g. MiniMax-M3).
    migrateMultimodalModels();

    // Shared ModelRegistry — used by chat service AND VLM analyzer
    const sharedModelRegistry = ModelRegistry.create(AuthStorage.inMemory());
    // VLM analyzer for error recovery (gracefully handles missing VLM config)
    const vlmAnalyzer = new VlmAnalyzer(sharedModelRegistry, { timeoutMs: 15000 });

    migrateSkills();
    ensureSkillBinaries();
    injectBundledShell(settingsManager);

    mainWindow = createMainWindow();

    // Create BrowserView (replaces <webview> to avoid guest-instance crashes on redirects).
    // BrowserView uses a persistent webContents — no guest recreation, no use-after-free.
    const browserView = new BrowserView({
      webPreferences: {
        partition: 'persist:pi-browser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Prevent Chromium from throttling/hiding the BrowserView's compositor
        // surface when the window is occluded or backgrounded — without this,
        // the BrowserView can go permanently white while the webContents still
        // has rendered content (this is what caused the zhipin.com blanking bug).
        backgroundThrottling: false,
        paintWhenInitiallyHidden: true,
      },
    });
    // Hide initially — bounds are set by the renderer when the Browser tab opens.
    browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    browserView.setAutoResize({ width: false, height: false });
    mainWindow.setBrowserView(browserView);
    browserManager.setBrowserView(browserView, mainWindow);

    // Warm up the CDP connection at boot. The legacy preview panel used to do
    // this on mount; with the browser now plugin-owned, pre-connect here so
    // the first browser.* capability call doesn't pay the attach latency.
    browserManager.connect().catch(() => {});

    registerNativeIpcHandlers();
    registerBrowserIpcHandlers(browserManager);

    // Plugin kernel: scan ~/.pi/agent/plugins (plus dev/builtin roots),
    // spawn backend UtilityProcesses, serve pi-plugin:// and expose IPC.
    // Created BEFORE the SDK IPC handlers so plugin tools can be injected
    // into the agent session (customTools).
    const pluginSystem = new PluginSystem({ browserManager });
    await pluginSystem.init();
    registerPluginIpcHandlers(pluginSystem);
    registerLiveViewIpcHandlers(browserManager);

    const { chatService } = registerIpcHandlers(settingsManager, sharedModelRegistry, {
      customToolsProvider: () => pluginSystem.aggregateTools(),
    });
    // Plugin tool/skill set changed at runtime → rebuild agent sessions.
    pluginSystem.onExtensionsChanged = () => chatService.invalidateSessions?.();

    // Push browser URL changes to plugin backends holding "browser" permission.
    browserManager.onUrlChanged((url) => {
      pluginSystem.pushHostEvent('browser.urlChanged', 'browser', { url });
    });

    app.on('will-quit', () => pluginSystem.dispose());

    // Start the browser automation HTTP server (for pi-browser CLI).
    // The BrowserManager connects to CDP lazily when the webview is ready.
    startBrowserHttpServer(browserManager, 19223, vlmAnalyzer);

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

  // Standard MinGit ships bash.exe in mingw64/bin/. BusyBox-only builds only
  // have ash.exe — keep it as a fallback (POSIX sh, limited but functional).
  const shellNames = ['bash.exe', 'ash.exe'];
  const binDirs = ['mingw64/bin', 'bin', 'usr/bin'].map((d) => join(bundleRoot, d));

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
  const gitExe = join(bundleRoot, 'mingw64', 'bin', 'git.exe');
  if (!existsSync(gitExe)) {
    console.warn(`[bash-bundle] git.exe not found at ${gitExe}. Git operations may fail.`);
  }

  console.log(`[bash-bundle] Using shell: ${shellPath}`);
  settingsManager.setShellPath(shellPath);

  // Add bundled bin dirs to PATH so git, coreutils, and msys-2.0.dll
  // can be found. On MSYS2, Windows paths are mapped as:
  //   C:\foo\bar → /c/foo/bar
  const pathDirs = [
    join(bundleRoot, 'mingw64', 'bin'),
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
