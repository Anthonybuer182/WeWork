/**
 * Office text extraction (main process, adm-zip based).
 *
 * Text-level preview for the plugin filePreview chain: docx/xlsx/pptx are
 * zip containers with XML parts; we extract readable text without external
 * services. Full-fidelity rendering stays in the host preview for now.
 */
import AdmZip from 'adm-zip';

export interface OfficeText {
  type: 'docx' | 'xlsx' | 'pptx';
  text: string;
  meta?: Record<string, string | number>;
}

/** Extract readable text lines from a docx/xlsx/pptx file. */
export function extractOfficeText(filePath: string, buffer: Buffer): OfficeText {
  const ext = filePath.toLowerCase().split('.').pop();
  const zip = new AdmZip(buffer);

  if (ext === 'docx') {
    const xml = readZipEntry(zip, 'word/document.xml');
    if (!xml) throw new Error('invalid docx: word/document.xml missing');
    const text = xmlToLines(xml, /<\/w:p>/g);
    return { type: 'docx', text, meta: { paragraphs: text.split('\n').length } };
  }

  if (ext === 'xlsx') {
    const shared = readZipEntry(zip, 'xl/sharedStrings.xml');
    const strings = shared ? extractTags(shared, 't') : [];
    const lines: string[] = [];
    // Inline cell values (workbooks without sharedStrings)
    for (const name of zip.getEntries().map((e) => e.entryName)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const sheetXml = readZipEntry(zip, name);
      if (!sheetXml) continue;
      const rows = sheetXml.split(/<\/row>/g).slice(0, -1);
      for (const row of rows.slice(0, 200)) {
        const cells = extractTags(row, 'v')
          .map((v, i) => {
            // t="s" → shared string index
            const typeMatch = row.split('<c ').find(() => true) ?? '';
            void typeMatch;
            return v;
          })
          .filter(Boolean);
        if (cells.length) lines.push(cells.join('\t'));
      }
    }
    if (lines.length === 0 && strings.length) {
      lines.push(...strings.slice(0, 200));
    }
    return { type: 'xlsx', text: lines.join('\n'), meta: { rows: lines.length } };
  }

  if (ext === 'pptx') {
    const slides = zip
      .getEntries()
      .map((e) => e.entryName)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNo(a) - slideNo(b));
    const lines: string[] = [];
    for (const slide of slides.slice(0, 100)) {
      const xml = readZipEntry(zip, slide);
      if (!xml) continue;
      const texts = extractTags(xml, 'a:t');
      if (texts.length) {
        lines.push(`── 幻灯片 ${slideNo(slide)} ──`);
        lines.push(...texts);
      }
    }
    return { type: 'pptx', text: lines.join('\n'), meta: { slides: slides.length } };
  }

  throw new Error(`unsupported office type: ${ext}`);
}

function readZipEntry(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return zip.readAsText(entry);
}

/** Strip XML tags; paragraph boundary markers become newlines. */
function xmlToLines(xml: string, paragraphEnd: RegExp): string {
  return xml
    .replace(paragraphEnd, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n');
}

/** Extract inner text of all occurrences of a tag. */
function extractTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (text) out.push(text);
  }
  return out;
}

function slideNo(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}
