/**
 * Workspace document index for `files_search`.
 *
 * Why this exists: `ls` and `find` see file names, but an office document's
 * content is behind a zip container — the agent cannot grep a docx. So when a
 * user says "the Q3 report" without a path, the only way to answer is to open
 * documents one by one, which is exactly what this index avoids.
 *
 * What it stores: per file, its name, size, mtime, title, and a short DIGEST
 * of the body text (the first ~1.5k characters). The digest is what makes
 * "which document mentions 华东区预算" answerable — a title alone cannot. It is
 * EXTRACTED, never generated: a model-written summary can invent content,
 * "the first paragraphs" cannot.
 *
 * The file system is always the truth. Every search re-walks the directory and
 * re-stats each file, so a document edited in Word/Excel between two searches
 * is seen immediately: an entry whose size/mtime changed is re-read before the
 * answer is returned. A stale index can only ever make a title or digest older
 * — it can never make `office_read`/`office_edit` act on the wrong bytes,
 * because those always operate on the file itself.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

/** Extensions the index covers — the same families the viewer previews. */
const INDEXABLE = new Set([
  'docx',
  'docm',
  'pptx',
  'pptm',
  'xlsx',
  'xlsm',
  'pdf',
  'md',
  'markdown',
  'txt',
  'csv',
]);

/**
 * Directories that are never user documents. Skipped by name so a workspace
 * that happens to be a code repo does not spend its scan on dependencies.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.turbo',
  '.next',
  '.cache',
  'vendor',
]);

/** A bounded scan: the first call must answer inside the tool timeout. */
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
/**
 * Guard rails for a root that is much larger than a workspace (someone passes
 * `/` or their home directory). Without them the WALK could run for minutes
 * before finding 5,000 indexable files; the extraction budget only starts
 * after the walk. A truncated scan still answers — it just says so.
 */
const MAX_DIRS = 20_000;
const WALK_BUDGET_MS = 8000;

/** How many workspace indexes to keep; the rest of the cache is disposable. */
const MAX_INDEX_FILES = 50;

/**
 * How long one search may spend extracting titles/digests. Past this the
 * remaining entries are marked `pending` and picked up by the next call — a
 * cold index over a large workspace is useful after one call, not after all
 * of it.
 */
const TITLE_BUDGET_MS = 6000;

/** A single huge file must not eat the whole budget. */
const MAX_TITLE_BYTES = 40 * 1024 * 1024;
const MAX_PDF_TITLE_BYTES = 20 * 1024 * 1024;
const TITLE_MAX_CHARS = 80;

/**
 * Body text kept per document. Big enough to cover the opening context a
 * person would scan (a slide deck's first slides, a report's opening
 * paragraphs), small enough that 5,000 files stay a few megabytes on disk.
 * This is a search surface, not a preview — `office_read` remains the way to
 * see a document in full.
 */
const DIGEST_MAX_CHARS = 1500;

export interface IndexEntry {
  path: string;
  ext: string;
  size: number;
  mtimeMs: number;
  /** Extracted from the document itself; null when the format has no title. */
  title: string | null;
  /** Extracted body text, first DIGEST_MAX_CHARS characters. */
  digest: string | null;
  /** Title/digest extraction ran out of budget for this entry. */
  pending?: boolean;
}

export interface StoredIndex {
  /** 2 = title + body digest. A v1 file has no digest and must be rebuilt. */
  version: 2;
  root: string;
  scannedAt: number;
  files: IndexEntry[];
}

export interface ScannedIndex extends StoredIndex {
  /** Entries still waiting for a title/digest. */
  pending: number;
  /** Files accepted by the walk before the cap. */
  total: number;
  /** The walk hit its time/dir/file cap — the index is partial. */
  truncated: boolean;
}

export interface SearchRow extends IndexEntry {
  /** Relative to the searched root — what makes sibling documents legible. */
  relPath: string;
  /** The digest window around the first matched word, when the body matched. */
  snippet: string | null;
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Thousands of scans can run concurrently through two conversations; one at a time. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** One index file per workspace root, under the plugin's private data dir. */
function indexPath(dataDir: string, root: string): string {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return join(dataDir, 'file-index', `${key}.json`);
}

async function loadIndex(file: string, root: string): Promise<StoredIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as StoredIndex;
    // A file left over from another root cannot happen with the hash name, but
    // the guard keeps a hand-edited file from answering for the wrong folder.
    // A version mismatch is a stale cache from before body digests existed —
    // rebuilding is cheaper than reasoning about which fields are missing.
    if (parsed?.version !== 2 || parsed.root !== root || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomic save. A crash mid-write must not leave a truncated JSON that every
 * later search fails to parse — rename is the cheapest way to guarantee that.
 */
async function saveIndex(file: string, index: StoredIndex): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(index), 'utf-8');
    await rename(tmp, file);
    // One file per workspace root; workspaces come and go. Keeping the newest
    // 50 bounds the cache without ever costing correctness — a pruned index is
    // simply rebuilt on the next search.
    await pruneIndexes(dirname(file), file);
  } catch {
    // A read-only data dir costs persistence, not correctness: the next search
    // simply rebuilds from disk.
  }
}

async function pruneIndexes(dir: string, current: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    if (names.length <= MAX_INDEX_FILES) return;
    const stamped = await Promise.all(
      names.map(async (name) => ({ name, info: await stat(join(dir, name)).catch(() => null) })),
    );
    const oldestFirst = stamped
      .filter((x): x is { name: string; info: NonNullable<typeof x.info> } => x.info !== null)
      .sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
    for (const { name } of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_INDEX_FILES))) {
      const path = join(dir, name);
      // Never delete the file just written, even if its mtime looks old.
      if (path !== current) await unlink(path).catch(() => undefined);
    }
  } catch {
    // Cache cleanup is best-effort; a failure must not affect the search.
  }
}

/** Walk the workspace, bounded by time, depth, directory and file count. Symlinks are skipped. */
async function walk(
  root: string,
  visit: (path: string, ext: string) => Promise<void>,
): Promise<{ truncated: boolean }> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const deadline = Date.now() + WALK_BUDGET_MS;
  let files = 0;
  let dirs = 0;
  while (stack.length > 0) {
    if (dirs >= MAX_DIRS || Date.now() > deadline) return { truncated: true };
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    dirs++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // Office's owner-lock files (`~$report.docx`) sit beside the real
      // document while it is open in Word/Excel. They are a few bytes of
      // metadata and would show up as empty, unopenable documents.
      if (entry.name.startsWith('~$')) continue;
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      if (!INDEXABLE.has(ext)) continue;
      if (files >= MAX_FILES) return { truncated: true };
      files++;
      await visit(path, ext);
    }
  }
  return { truncated: false };
}

// ── text extraction ──────────────────────────────────────────────────

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Collapse whitespace so a digest is one searchable line, not raw XML soup. */
const cleanText = (s: string): string => s.replace(/\s+/g, ' ').trim();

const cleanTitle = (s: string): string | null => {
  const t = cleanText(s);
  if (!t) return null;
  return t.length > TITLE_MAX_CHARS ? `${t.slice(0, TITLE_MAX_CHARS)}…` : t;
};

const cleanDigest = (parts: string[]): string | null => {
  const t = cleanText(parts.join(' '));
  if (!t) return null;
  return t.length > DIGEST_MAX_CHARS ? t.slice(0, DIGEST_MAX_CHARS) : t;
};

/**
 * Inner text of every occurrence of a tag, prefixes (`w:t`, `a:t`) included.
 * Not truncated: the caller decides whether it wants a title or a digest.
 */
function tagTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = cleanText(unescapeXml(m[1].replace(/<[^>]+>/g, '')));
    if (t) out.push(t);
  }
  return out;
}

interface Meta {
  title: string | null;
  digest: string | null;
}

/**
 * docx: the first heading as title (else the first non-empty paragraph), and
 * the opening paragraphs as digest.
 *
 * Heading markers vary by producer — a style name (`Heading1`, `标题 1`), a
 * numeric style id, or an outline level. All three are checked; none is
 * trusted alone.
 */
async function docxMeta(bytes: Uint8Array): Promise<Meta> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return { title: null, digest: null };
  const paragraphs = xml.match(/<(?:w:)?p\b[^>]*>[\s\S]*?<\/(?:w:)?p>/g) ?? [];
  const parts: string[] = [];
  let first: string | null = null;
  let heading: string | null = null;
  for (const para of paragraphs) {
    const texts = tagTexts(para, 't');
    if (texts.length === 0) continue;
    const text = cleanText(texts.join(''));
    if (!text) continue;
    parts.push(text);
    if (first === null) first = text;
    if (heading === null) {
      const style = /<(?:w:)?pStyle\b[^>]*\b(?:\w+:)?val="([^"]+)"/.exec(para)?.[1] ?? '';
      const outline = /<(?:w:)?outlineLvl\b[^>]*\b(?:\w+:)?val="([0-5])"/.exec(para)?.[1];
      if (outline !== undefined || /heading|title|标题/i.test(style) || /^[1-6]$/.test(style)) {
        heading = text;
      }
    }
  }
  return { title: cleanTitle(heading ?? first ?? ''), digest: cleanDigest(parts) };
}

/** pptx: the first slide's text as title, text from the opening slides as digest. */
async function pptxMeta(bytes: Uint8Array): Promise<Meta> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n);
  const parts: string[] = [];
  let chars = 0;
  // Read until the digest is full, not a fixed page count: a sparse deck (few
  // words per slide) should still reach later slides, while a dense one stops
  // as soon as the budget is spent. The 50-slide cap bounds a pathological
  // deck whose slides are all empty.
  for (const slide of slides.slice(0, 50)) {
    if (chars >= DIGEST_MAX_CHARS) break;
    const xml = await zip.file(slide.name)?.async('string');
    if (!xml) continue;
    const texts = tagTexts(xml, 't');
    parts.push(...texts);
    for (const t of texts) chars += t.length + 1;
  }
  return { title: cleanTitle(parts[0] ?? ''), digest: cleanDigest(parts) };
}

/**
 * xlsx: the first sheet's name as title, sheet names + shared strings as
 * digest. Shared strings are every text cell in the workbook, which is the
 * useful search surface; numbers alone are not worth indexing.
 */
async function xlsxMeta(bytes: Uint8Array): Promise<Meta> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const sheetNames = workbook
    ? [...workbook.matchAll(/<(?:x:)?sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => cleanText(unescapeXml(m[1])))
    : [];
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
  const strings = shared ? tagTexts(shared, 't') : [];
  // Some producers write cell text inline (`<is><t>`) instead of into
  // sharedStrings. Without this pass those workbooks index as empty.
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .slice(0, 10);
  for (const name of sheets) {
    const xml = await zip.file(name)?.async('string');
    if (!xml) continue;
    strings.push(...tagTexts(xml, 't'));
    // A third producer quirk: SheetJS writes strings as `t="str"` with the
    // text in `<v>` — no sharedStrings and no `<t>` at all. Only string-typed
    // cells are read here; pulling every `<v>` would fill the digest with
    // numbers.
    const cellRe = /<c\b[^>]*\bt="(?:str|inlineStr)"[^>]*>([\s\S]*?)<\/c>/g;
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(xml))) strings.push(...tagTexts(m[1], 'v'));
  }
  return {
    title: cleanTitle(sheetNames[0] ?? ''),
    digest: cleanDigest([...sheetNames, ...strings]),
  };
}

/** pdf: the metadata title. Text extraction for PDF is not wired yet. */
async function pdfMeta(bytes: Uint8Array): Promise<Meta> {
  if (bytes.length > MAX_PDF_TITLE_BYTES) return { title: null, digest: null };
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return { title: cleanTitle(doc.getTitle() ?? ''), digest: null };
}

/** Text formats: the first Markdown heading as title, the opening as digest. */
function textMeta(content: string, markdown: boolean): Meta {
  let title: string | null = null;
  if (markdown) {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(content);
    if (heading) title = cleanTitle(heading[1]);
  }
  if (!title) {
    for (const line of content.split(/\r?\n/)) {
      const t = cleanTitle(line);
      if (t) {
        title = t;
        break;
      }
    }
  }
  return { title, digest: cleanDigest([content]) };
}

async function extractMeta(path: string, ext: string, size: number): Promise<Meta> {
  const isOffice =
    ext === 'docx' || ext === 'docm' || ext === 'pptx' || ext === 'pptm' || ext === 'xlsx' || ext === 'xlsm';
  if (size > MAX_TITLE_BYTES && (isOffice || ext === 'pdf')) return { title: null, digest: null };
  if (ext === 'docx' || ext === 'docm') return docxMeta(new Uint8Array(await readFile(path)));
  if (ext === 'pptx' || ext === 'pptm') return pptxMeta(new Uint8Array(await readFile(path)));
  if (ext === 'xlsx' || ext === 'xlsm') return xlsxMeta(new Uint8Array(await readFile(path)));
  if (ext === 'pdf') return pdfMeta(new Uint8Array(await readFile(path)));
  // Text files are read whole, so a multi-megabyte log is not worth a digest —
  // its path still matches, and the agent can `read` it if it needs to.
  if (size > 2 * 1024 * 1024) return { title: null, digest: null };
  if (ext === 'md' || ext === 'markdown') return textMeta(await readFile(path, 'utf-8'), true);
  if (ext === 'txt' || ext === 'csv') return textMeta(await readFile(path, 'utf-8'), false);
  return { title: null, digest: null };
}

// ── scan ─────────────────────────────────────────────────────────────

/**
 * Re-stat every indexed file and refresh only what changed.
 *
 * The walk is the freshness guarantee, so it runs on every search. Extraction
 * is the expensive part, so it is budgeted: changed files are processed
 * newest-first (the ones a user is most likely to mean), and stragglers stay
 * `pending` for the next call.
 */
export async function scanWorkspace(root: string, dataDir: string): Promise<ScannedIndex> {
  // A relative path would resolve against the plugin process's cwd, not the
  // user's workspace — usually scanning the wrong tree silently.
  if (!isAbsolute(root)) throw new Error(`files_search: root must be an absolute path: ${root}`);
  const absolute = resolvePath(root);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isDirectory()) throw new Error(`files_search: not a directory: ${absolute}`);

  return serialize(async () => {
    const file = indexPath(dataDir, absolute);
    const previous = await loadIndex(file, absolute);
    const prior = new Map((previous?.files ?? []).map((e) => [e.path, e]));

    const discovered: Array<Omit<IndexEntry, 'title' | 'digest' | 'pending'>> = [];
    const walked = await walk(absolute, async (path, ext) => {
      const s = await stat(path).catch(() => null);
      if (!s || !s.isFile()) return;
      discovered.push({ path, ext, size: s.size, mtimeMs: s.mtimeMs });
    });

    const entries: IndexEntry[] = discovered.map((d) => {
      const old = prior.get(d.path);
      // Size and mtime both, because a same-size edit is common in office
      // files (one word changed) and mtime alone misses nothing but is cheap
      // to pair.
      const unchanged = old && old.size === d.size && old.mtimeMs === d.mtimeMs && !old.pending;
      return unchanged
        ? { ...d, title: old.title, digest: old.digest }
        : { ...d, title: null, digest: null, pending: true };
    });

    // Newest first: a cold index becomes useful for the documents a person
    // actually means before it finishes the archive.
    const changed = entries.filter((e) => e.pending).sort((a, b) => b.mtimeMs - a.mtimeMs);

    const deadline = Date.now() + TITLE_BUDGET_MS;
    let dirty = entries.length !== (previous?.files.length ?? -1);
    for (const entry of changed) {
      if (Date.now() > deadline) break;
      try {
        const meta = await extractMeta(entry.path, entry.ext, entry.size);
        entry.title = meta.title;
        entry.digest = meta.digest;
      } catch {
        // A corrupt or password-protected document is not a reason to fail the
        // search: it keeps its path, loses its title/digest, and is not retried.
        entry.title = null;
        entry.digest = null;
      }
      delete entry.pending;
      dirty = true;
    }

    let pending = 0;
    for (const e of entries) if (e.pending) pending++;

    const next: StoredIndex = { version: 2, root: absolute, scannedAt: Date.now(), files: entries };
    // Persist only when something changed. A search over an unchanged
    // workspace must not rewrite the index on every call.
    if (dirty || pending !== 0 || !previous) await saveIndex(file, next);

    return { ...next, pending, total: entries.length, truncated: walked.truncated };
  });
}

// ── search ───────────────────────────────────────────────────────────

/** Every word must appear, matched against path + title + body digest. */
function tokenize(query: string): string[] {
  // Chinese users (and models copying their wording) punctuate with full-width
  // marks; treating those as separators turns "华东区预算，30" into two terms
  // instead of one unmatchable string.
  return query
    .toLowerCase()
    .replace(/[，、；;,.!?！？:：\s]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function scoreEntry(entry: IndexEntry, tokens: string[]): number {
  const name = basename(entry.path).toLowerCase();
  const title = (entry.title ?? '').toLowerCase();
  const digest = (entry.digest ?? '').toLowerCase();
  const path = entry.path.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    if (title.includes(token)) score += 3;
    // Body matches rank below the name/title: a document whose TITLE says
    // "budget" is a better answer than one that merely mentions it.
    if (digest.includes(token)) score += 2;
    if (path.includes(token)) score += 1;
  }
  return score;
}

/**
 * The digest window around the first matched word — what tells the agent WHY
 * this file came back, without shipping the whole 1.5k-char digest.
 */
function snippetFor(entry: IndexEntry, tokens: string[]): string | null {
  if (tokens.length === 0 || !entry.digest) return null;
  const lower = entry.digest.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const start = Math.max(0, at - 40);
  const end = Math.min(entry.digest.length, at + 80);
  return `${start > 0 ? '…' : ''}${entry.digest.slice(start, end)}${end < entry.digest.length ? '…' : ''}`;
}

export interface SearchResult {
  index: ScannedIndex;
  rows: SearchRow[];
}

export async function searchWorkspace(
  root: string,
  dataDir: string,
  query: string,
  limit = 20,
): Promise<SearchResult> {
  const index = await scanWorkspace(root, dataDir);
  const tokens = tokenize(query);
  const matches = tokens.length === 0
    ? index.files
    : index.files.filter((e) => {
        const hay = `${e.path}\n${e.title ?? ''}\n${e.digest ?? ''}`.toLowerCase();
        // A pending entry has no title/digest yet; its path still has to match,
        // which is why the path side is never skipped while the index builds.
        return tokens.every((t) => hay.includes(t));
      });

  const ranked = matches
    .map((entry) => ({ entry, score: tokens.length === 0 ? 0 : scoreEntry(entry, tokens) }))
    .sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(({ entry }) => ({
      ...entry,
      relPath: entry.path.slice(index.root.length).replace(/^[/\\]/, ''),
      snippet: snippetFor(entry, tokens),
    }));

  return { index, rows: ranked };
}
