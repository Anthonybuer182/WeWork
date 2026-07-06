import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** File extensions that can be edited as text in the Monaco editor */
const TEXT_EDITABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less',
  '.html', '.htm', '.vue', '.svelte', '.astro',
  '.py', '.pyi', '.pyx',
  '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.swift', '.kt', '.rb', '.php',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.sql', '.prisma', '.graphql',
  '.md', '.mdx', '.txt', '.log', '.env', '.env.local', '.editorconfig',
  '.gitignore', '.dockerignore', '.npmrc',
  '.sh', '.bash', '.zsh', '.fish',
  '.toml', '.ini', '.cfg', '.conf',
]);

/** File extensions that have their own structured preview in the right panel */
const PREVIEWABLE_EXTENSIONS = new Set([
  '.html', '.htm',
  '.docx', '.xlsx', '.pptx',
  '.pdf',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif',
  // Videos
  '.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi', '.3gp',
]);

/** Returns true if the file can be opened and edited as text */
export function isTextEditableFile(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = name.includes('.') ? '.' + name.split('.').pop()?.toLowerCase() : '';
  if (TEXT_EDITABLE_EXTENSIONS.has(ext)) return true;
  // Also handle files without extensions that are commonly text
  const basename = name.toLowerCase();
  return ['makefile', 'dockerfile', 'license', 'readme', 'changelog'].includes(basename);
}

/** Returns true if the file should open in the right panel (text editor or structured preview) */
export function isPreviewableInRightPanel(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = name.includes('.') ? '.' + name.split('.').pop()?.toLowerCase() : '';
  return isTextEditableFile(filePath) || PREVIEWABLE_EXTENSIONS.has(ext);
}

/** Reveal a file in the system file manager (Finder on macOS, Explorer on Windows) */
export function showInFinder(filePath: string): void {
  const electronAPI = (window as unknown as { electronAPI?: { shell?: { showItemInFolder?: (p: string) => void } } }).electronAPI;
  electronAPI?.shell?.showItemInFolder?.(filePath);
}

/** Open a file with the system's default application */
export function openWithSystemApp(filePath: string, workspaceId?: string): void {
  const electronAPI = (window as unknown as { electronAPI?: { shell?: { openPath: (p: string) => Promise<void> } } }).electronAPI;
  if (electronAPI?.shell?.openPath) {
    electronAPI.shell.openPath(filePath).catch((err) => {
      console.error('Failed to open file:', err);
    });
  } else {
    // Web fallback: download via API, browser will prompt to open with system app
    const url = `/api/file/download?path=${encodeURIComponent(filePath)}`;
    const finalUrl = workspaceId ? `${url}&workspaceId=${encodeURIComponent(workspaceId)}` : url;
    const a = document.createElement('a');
    a.href = finalUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
