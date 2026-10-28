import * as fs from 'fs';
import * as path from 'path';

/** Map file extension to MIME type */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.json': 'application/json',
    '.xml': 'text/xml',
    '.csv': 'text/csv',
    '.yaml': 'application/x-yaml',
    '.yml': 'application/x-yaml',
    '.py': 'text/x-python',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.sh': 'application/x-sh',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export interface DetectedFile {
  absPath: string;
  relPath: string;
  size: number;
  mimeType: string;
}

/** Known file-writing/editing tools — extract path from args (precise, no regex) */
const WRITE_TOOLS = new Set([
  'write', 'write_to_file', 'Write',
  'Edit', 'mcp__filesystem__edit_file',
  'mcp__filesystem__write_file',
]);

/** Read-only tools whose results should never be scanned for created files */
const READ_ONLY_TOOLS = new Set([
  'read', 'Read', 'ls', 'LS', 'glob', 'Glob',
  'grep', 'Grep', 'find', 'Find', 'SearchCodebase', 'search',
  'stat', 'exists', 'file_info',
]);

/** Detect file paths written by tools, returning existing files with stats */
export function detectWrittenFiles(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  resultText: string,
  workspaceCwd: string | undefined,
): DetectedFile[] {
  const files: DetectedFile[] = [];
  const cwd = workspaceCwd || process.cwd();

  const tryAdd = (candidate: string) => {
    if (!candidate) return;
    const absPath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return;
    if (files.some((f) => f.absPath === absPath)) return;
    const relPath = path.relative(cwd, absPath);
    if (relPath.startsWith('..')) return;
    files.push({ absPath, relPath, size: stat.size, mimeType: getMimeType(absPath) });
  };

  // Skip read-only tools entirely
  if (toolName && READ_ONLY_TOOLS.has(toolName)) {
    return files;
  }

  // Known file-writing tools: extract path from args (precise, no regex)
  if (toolName && WRITE_TOOLS.has(toolName) && args) {
    const filePath = (args as any).path || (args as any).filePath || (args as any).file_path;
    if (filePath && typeof filePath === 'string') {
      tryAdd(filePath);
      return files;
    }
  }

  // For other tools (Bash, etc.): parse result text for file paths.
  // Only match paths with explicit file-creation context to avoid false positives
  // from ls output, build logs, or error messages.
  // NOTE: removed `^` (bare text start) and bare `:\s*` (any colon) which caused
  // false positives like "Files: old.pptx" being treated as file creation.
  if (resultText && cwd) {
    const creationPrefix = '(?:created[:,]?\\s+|created\\s+at\\s+|saved\\s+(?:to[:,]?\\s+)?|written\\s+(?:to[:,]?\\s+)?|generated[:,]?\\s+|wrote[:,]?\\s+|exported[:,]?\\s+|已生成\\S*\\s*[：:]\\s*|生成\\S*\\s*[：:]\\s*)';
    const pathPart = '[\\p{L}\\w\\-./]+\\.\\w{2,6}|\\/[\\p{L}\\w\\-./\\\\ ]+\\.\\w{2,6}|[A-Za-z]:[/\\\\][\\p{L}\\w\\-./\\\\ ]+\\.\\w{2,6}';
    const pathPattern = new RegExp(`(?<=${creationPrefix})(${pathPart})\\b`, 'giu');
    let match;
    while ((match = pathPattern.exec(resultText)) !== null) {
      tryAdd(match[1].trim());
    }
  }

  return files;
}
