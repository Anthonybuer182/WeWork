/**
 * com.pi.files viewer — engine dispatch (genoffice engines, Apache-2.0).
 *
 * docx → docx-engine parseDocx → Block 树 → HTML 渲染(DOM,文字可选)
 * pptx → pptx-engine openPptx → pptx-render buildRenderSlide → SVG 渲染
 * 其它类型走 text/图片 兜底;officecli 渲染路径已退役(查看器对生产者无感知)。
 */
import { parseDocx } from '@genoffice/docx-engine';
import { openPptx } from '@genoffice/pptx-engine';
import { buildRenderSlide } from '@genoffice/pptx-render';
import * as pdfjsLib from 'pdfjs-dist';
import * as XLSX from 'xlsx';

// ── 宿主消息协议(与 P9b/P10 一致)──

function send(eventId: string, data?: unknown): void {
  window.parent.postMessage(
    {
      __piPlugin: true,
      pluginId: 'com.pi.files',
      direction: 'ui',
      payload: { kind: 'event', event: 'ui.event', panelId: 'viewer', data: { eventId, data } },
    },
    '*',
  );
}

// ── 状态栏与缩放 ──

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

function setText(id: string, v: string): void { const el = $(id); if (el) el.textContent = v; }
function setDisplay(id: string, v: string): void { const el = $(id); if (el) el.style.display = v; }

function setLoading(name: string, note = ''): void {
  setText('fName', name || '文件中心');
  setText('fMeta', note || '');
  setDisplay('zoomBar', 'none');
  const c = $('content');
  if (c) c.innerHTML = '<div class="state"><div class="spin"></div><div>加载中…</div></div>';
}

function showError(msg: string): void {
  setDisplay('zoomBar', 'none');
  const c = $('content');
  if (c) c.innerHTML = `<div class="state"><div class="big">无法预览</div><div class="err">${escapeHtml(msg)}</div></div>`;
}

function showEmpty(): void {
  setText('fName', '文件中心');
  setText('fMeta', '');
  setDisplay('zoomBar', 'none');
  const c = $('content');
  if (c) c.innerHTML = '<div class="state"><div class="big">未选择文件</div><div>在左侧文件树点击文件,或让 agent 生成文件</div></div>';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── docx:Block 树 → HTML(可编辑 + 字节保留保存)──

let docxState: { parsed: any; path: string; fileName: string; mtime: number } | null = null;

function markDirty(dirty: boolean): void {
  const btn = document.getElementById('saveBtn');
  if (btn) {
    btn.style.display = dirty ? 'inline-block' : 'none';
    const name = $('fName');
    if (name && docxState) name.textContent = docxState.fileName + (dirty ? ' •' : '');
  }
}

async function saveDocxFile(): Promise<void> {
  if (!docxState) return;
  const btn = document.getElementById('saveBtn');
  if (btn) btn.textContent = '保存中…';
  try {
    const page = document.querySelector('.docx-page')!;
    const paragraphs = [...page.querySelectorAll<HTMLElement>('[data-block-id]')];
    // 原 block 索引(可见块顺序)
    const visible = (docxState.parsed.blocks as any[]).filter((b: any) => !b.hidden);
    const saveBlocks: any[] = [];
    const usedOriginal = new Set<number>();
    for (const el of paragraphs) {
      const blockId = el.dataset.blockId!;
      const orig = visible.find((b: any) => b.id === blockId);
      if (!orig || orig.docxIndex == null) continue;
      const newText = el.innerText.replace(/\n$/, '');
      const origText = (orig.runs ?? []).map((r: any) => r.text ?? '').join('');
      usedOriginal.add(orig.docxIndex);
      if (newText === origText) {
        // 未变:字节原样保留
        saveBlocks.push({ kind: 'original', docxIndex: orig.docxIndex });
      } else if (orig.type === 'paragraph' || orig.type === 'heading' || orig.type === 'listItem') {
        // 文本变了:用字节保留策略 — rawPPr 原样 + 新 runs(继承首个原 run 的格式)
        const firstRun = (orig.runs ?? [])[0] ?? {};
        const runs = newText.split(/(?<=。|\.|!|\?|;)/).length ? [{ ...firstRun, text: newText }] : [{ ...firstRun, text: newText }];
        saveBlocks.push({
          kind: 'generated',
          block: { type: orig.type, level: orig.level, list: orig.list, rawPPr: orig.rawPPr, runs },
        });
      } else {
        // 非文本块(表格/图片/受保护)不在此编辑器修改 — 原样
        saveBlocks.push({ kind: 'original', docxIndex: orig.docxIndex });
      }
    }
    // 编辑中删除的段落:不进 saveBlocks(saveDocx 按顺序重建 body)
    // 新增段落(无 data-block-id 的 p)→ generated
    for (const el of [...page.querySelectorAll<HTMLElement>('p:not([data-block-id])')] as HTMLElement[]) {
      const text = el.innerText.replace(/\n$/, '');
      if (!text.trim()) continue;
      saveBlocks.push({ kind: 'generated', block: { type: 'paragraph', runs: [{ text }] } });
    }
    const { saveDocx } = await import('@genoffice/docx-engine');
    const bytes = await saveDocx(docxState.parsed, saveBlocks, {});
    // 写回宿主(经后端 capability → filesystem.write)
    const b64 = arrayToBase64(bytes);
    send('file-save', { path: docxState.path, contentB64: b64, expectedMtime: docxState.mtime > 0 ? docxState.mtime : undefined });
    // 等 ack(后端回 ui.render saved)
    markDirty(false);
    if (btn) btn.textContent = '已保存 ✓';
    setTimeout(() => { if (btn) { btn.textContent = '保存'; btn.style.display = 'none'; } }, 1600);
  } catch (e) {
    showError('保存失败:' + String((e as Error).message ?? e));
    if (btn) btn.textContent = '保存';
  }
}

function arrayToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}


interface Run { text: string; bold?: boolean; italic?: boolean; strike?: boolean; underline?: never | boolean; fontSizePt?: number; font?: string; color?: string; sup?: boolean; sub?: boolean }
interface Block { id: string; type: string; level?: number; runs?: Run[]; label?: string; previewText?: string; imageDataUrl?: string; imageWidthPx?: number; imageHeightPx?: number; format?: { align?: string; indentLeftPx?: number }; list?: { kind: string; numId: string; ilvl: number } }

function renderDocxHtml(blocks: Block[], editable = false): string {
  const out: string[] = [];
  const listCounters = new Map<string, number>();
  const bid = (b: Block) => editable && b.id ? ` data-block-id="${b.id}"` : '';
  for (const b of blocks) {
    const style = b.format?.indentLeftPx ? ` style="margin-left:${Math.round(b.format.indentLeftPx)}px"` : '';
    switch (b.type) {
      case 'heading':
        out.push(`<h${b.level ?? 1}${bid(b)}${style}>${runsHtml(b.runs)}</h${b.level ?? 1}>`);
        break;
      case 'listItem': {
        const key = `${b.list?.numId}:${b.list?.ilvl}`;
        if (b.list?.kind === 'ordered') {
          const n = (listCounters.get(key) ?? 0) + 1;
          listCounters.set(key, n);
          out.push(`<div class="li"${bid(b)} ${style}><span class="mark">${n}.</span><div>${runsHtml(b.runs)}</div></div>`);
        } else {
          out.push(`<div class="li"${bid(b)} ${style}><span class="mark">•</span><div>${runsHtml(b.runs)}</div></div>`);
        }
        break;
      }
      case 'image':
        if (b.imageDataUrl) {
          const w = b.imageWidthPx ? `width="${Math.min(b.imageWidthPx, 640)}"` : '';
          out.push(`<div class="imgwrap"><img src="${b.imageDataUrl}" ${w} alt="" /></div>`);
        }
        break;
      case 'table':
      case 'passthrough':
        out.push(`<div class="passthrough">◈ ${escapeHtml(b.label ?? '受保护内容')}${b.previewText ? `<span class="pv">${escapeHtml(b.previewText.slice(0, 60))}</span>` : ''}</div>`);
        break;
      default: {
        const align = b.format?.align === 'center' ? ' style="text-align:center"' : b.format?.align === 'right' ? ' style="text-align:right"' : '';
        const text = runsHtml(b.runs);
        out.push(text.trim() || b.runs?.length ? `<p${bid(b)}${align}${style}>${text || '&nbsp;'}</p>` : `<p class="blank"${bid(b)}>&nbsp;</p>`);
      }
    }
  }
  return out.join('\n');
}

function runsHtml(runs?: Run[]): string {
  if (!runs?.length) return '';
  return runs
    .map((r) => {
      let html = escapeHtml(r.text ?? '');
      if (r.bold) html = `<b>${html}</b>`;
      if (r.italic) html = `<i>${html}</i>`;
      if (r.strike) html = `<s>${html}</s>`;
      const styles: string[] = [];
      if (r.fontSizePt) styles.push(`font-size:${r.fontSizePt}pt`);
      if (r.font) styles.push(`font-family:${escapeHtml(r.font)}`);
      if (r.color) styles.push(`color:${escapeHtml(r.color)}`);
      if (r.sup) styles.push('vertical-align:super;font-size:0.75em');
      if (r.sub) styles.push('vertical-align:sub;font-size:0.75em');
      return styles.length ? `<span style="${styles.join(';')}">${html}</span>` : html;
    })
    .join('');
}

async function previewDocx(url: string, fileName: string, mtime: number): Promise<void> {
  const buf = await (await fetch(url)).arrayBuffer();
  const parsed = await parseDocx(new Uint8Array(buf));
  docxState = { parsed, path: lastPath, fileName, mtime };
  const html = renderDocxHtml(parsed.blocks as unknown as Block[], true);
  setText('fName', fileName);
  setText('fMeta', `genoffice 引擎 · ${parsed.blocks.length} 块 · 可编辑`);
  const c = $('content');
  if (c) {
    c.innerHTML = `<button id="saveBtn" style="display:none">保存</button><div class="docx-page" contenteditable="true" spellcheck="false">${html}</div>`;
    const btn = document.getElementById('saveBtn');
    btn?.addEventListener('click', () => { void saveDocxFile(); });
    c.querySelector('.docx-page')?.addEventListener('input', () => markDirty(true));
  }
}

// ── pptx:RenderNode 树 → SVG(完整渲染器:几何/渐变/线/表格/图表/阴影/分组)──

interface GRun { text: string; x: number; baselineY: number; fontFamily: string; fontSizePx: number; color: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; highlight?: string }
interface GLine { runs: GRun[]; top: number; height: number }
interface TLayout { lines?: GLine[]; insets?: { l: number; t: number; r: number; b: number }; anchor?: string; contentHeight?: number }
interface RFill { kind: string; color?: string; stops?: Array<{ pos: number; color: string }>; angleDeg?: number; radial?: boolean; center?: { x: number; y: number }; dataUrl?: string; mode?: string; alpha?: number }
interface RStroke { color: string; widthPx: number; dash?: number[]; cap?: string }
interface RShadow { color: string; blurPx: number; offsetX: number; offsetY: number }
interface Arrow { type: string; widthPx: number; lengthPx: number }
interface RNode {
  id: string; type: string;
  box: { x: number; y: number; w: number; h: number; rotationDeg?: number };
  fill?: RFill; fillOverlay?: RFill; stroke?: RStroke; shadow?: RShadow;
  text?: TLayout; txBox?: boolean; presetGeometry?: string; cornerRadiusPx?: number;
  polygonPoints?: number[]; pathData?: string; fillPathData?: string; strokePathData?: string;
  line?: { points: number[]; bezier?: number[]; headEnd?: Arrow; tailEnd?: Arrow };
  dataUrl?: string; bgColor?: string; srcRect?: { l: number; t: number; r: number; b: number };
  opacity?: number; clip?: { cornerRadiusPx?: number; polygonPoints?: number[]; pathData?: string };
  children?: RNode[]; placeholder?: string;
  cells?: Array<{ x: number; y: number; w: number; h: number; fill: RFill; borders?: { l?: RStroke; r?: RStroke; t?: RStroke; b?: RStroke }; text?: TLayout }>;
  bgFill?: RFill;
  gridLines?: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; dash?: number[]; widthPx?: number }>;
  axisLines?: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; widthPx: number }>;
  labels?: Array<{ text: string; x: number; y: number; fontSizePx: number; color: string; bold?: boolean; rotationDeg?: number }>;
  bars?: Array<{ x: number; y: number; w: number; h: number; color: string }>;
  polylines?: Array<{ points: number[]; color: string; widthPx: number; smooth?: boolean; closed?: boolean; fill?: string; dash?: number[] }>;
  markers?: Array<{ x: number; y: number; r: number; color: string }>;
  swatches?: Array<{ x: number; y: number; w: number; h: number; color: string }>;
  wedges?: Array<{ cx: number; cy: number; outerR: number; innerR: number; startDeg: number; sweepDeg: number; color: string }>;
  paths?: Array<{ d: string; fill: string; stroke?: string }>;
  plotRect?: { x: number; y: number; w: number; h: number; fill?: RFill; borderColor?: string; borderWidthPx?: number };
  border?: { color: string; widthPx: number };
}

let gradId = 0;

function fillDef(fill: RFill | undefined, box: { x: number; y: number; w: number; h: number }): string {
  if (!fill || fill.kind === 'none') return 'none';
  if (fill.kind === 'solid') return fill.color ?? 'none';
  if (fill.kind === 'gradient' && fill.stops?.length) {
    const id = `g${++gradId}`;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    // 线性角度:OOXML 0°=向右,顺时针;SVG gradientTransform 旋转
    const rad = ((fill.angleDeg ?? 0) * Math.PI) / 180;
    const dx = Math.cos(rad) / 2;
    const dy = Math.sin(rad) / 2;
    const defs = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${cx - dx * box.w}" y1="${cy - dy * box.h}" x2="${cx + dx * box.w}" y2="${cy + dy * box.h}">` +
      fill.stops.map((s) => `<stop offset="${Math.round(s.pos * 100)}%" stop-color="${s.color}"/>`).join('') +
      `</linearGradient>`;
    pendingDefs.push(defs);
    return `url(#${id})`;
  }
  if (fill.kind === 'image' && fill.dataUrl) {
    const id = `p${++gradId}`;
    pendingDefs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${box.w}" height="${box.h}"><image href="${fill.dataUrl}" width="${box.w}" height="${box.h}" preserveAspectRatio="${fill.mode === 'tile' ? 'none' : 'xMidYMid slice'}"${fill.alpha ? ` opacity="${fill.alpha}"` : ''}/></pattern>`);
    return `url(#${id})`;
  }
  return 'rgba(127,127,127,.15)';
}

const pendingDefs: string[] = [];

function strokeAttrs(stroke: RStroke | undefined): string {
  if (!stroke) return '';
  return ` stroke="${stroke.color}" stroke-width="${stroke.widthPx ?? 1}"${stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.join(' ')}"` : ''}${stroke.cap === 'round' ? ' stroke-linecap="round"' : ''}`;
}

function shadowFilter(shadow: RShadow | undefined): string {
  if (!shadow) return '';
  const id = `s${++gradId}`;
  pendingDefs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${shadow.offsetX}" dy="${shadow.offsetY}" stdDeviation="${shadow.blurPx / 2}" flood-color="${shadow.color}"/></filter>`);
  return ` filter="url(#${id})"`;
}

/** 文本布局(px 级 GlyphRun 坐标 → SVG text,含高亮/下划线/删除线) */
function textSvg(node: RNode): string {
  const parts: string[] = [];
  if (!node.text?.lines) return '';
  for (const line of node.text.lines) {
    for (const run of line.runs) {
      if (!run.text) continue;
      const x = node.box.x + run.x;
      const y = node.box.y + run.baselineY;
      const attrs = [
        `x="${x.toFixed(1)}"`, `y="${y.toFixed(1)}"`,
        `font-family="${run.fontFamily}"`,
        `font-size="${run.fontSizePx.toFixed(1)}px"`,
        run.bold ? 'font-weight="bold"' : '',
        run.italic ? 'font-style="italic"' : '',
        `fill="${run.color}"`,
      ].filter(Boolean).join(' ');
      let el = `<text ${attrs}>${escapeHtml(run.text)}</text>`;
      // 下划线/删除线(基线偏移近似)
      if (run.underline) {
        el += `<line x1="${x.toFixed(1)}" y1="${(y + 2).toFixed(1)}" x2="${(x + run.text.length * run.fontSizePx * 0.5).toFixed(1)}" y2="${(y + 2).toFixed(1)}" stroke="${run.color}" stroke-width="1"/>`;
      }
      if (run.strike) {
        el += `<line x1="${x.toFixed(1)}" y1="${(y - run.fontSizePx * 0.3).toFixed(1)}" x2="${(x + run.text.length * run.fontSizePx * 0.5).toFixed(1)}" y2="${(y - run.fontSizePx * 0.3).toFixed(1)}" stroke="${run.color}" stroke-width="1"/>`;
      }
      // 高亮(文本底层色块)
      if (run.highlight) {
        el = `<rect x="${x.toFixed(1)}" y="${(y - run.fontSizePx * 0.85).toFixed(1)}" width="${(run.text.length * run.fontSizePx * 0.5).toFixed(1)}" height="${(run.fontSizePx * 1.15).toFixed(1)}" fill="${run.highlight}"/>` + el;
      }
      parts.push(el);
    }
  }
  return parts.join('');
}

/** 箭头端点(path) */
function arrowHead(p: { x: number; y: number }, angle: number, a: Arrow | undefined): string {
  if (!a) return '';
  const len = a.lengthPx || 8;
  const wid = a.widthPx || 6;
  const back = { x: p.x - len * Math.cos(angle), y: p.y - len * Math.sin(angle) };
  const perp = { x: -Math.sin(angle), y: Math.cos(angle) };
  const pts = [
    `${p.x.toFixed(1)},${p.y.toFixed(1)}`,
    `${(back.x + perp.x * wid / 2).toFixed(1)},${(back.y + perp.y * wid / 2).toFixed(1)}`,
    `${(back.x - perp.x * wid / 2).toFixed(1)},${(back.y - perp.y * wid / 2).toFixed(1)}`,
  ];
  return `<polygon points="${pts.join(' ')}" fill="${'currentColor'}"/>`;
}

function nodeSvg(n: RNode, parentBox?: { x: number; y: number }): string {
  const parts: string[] = [];
  // group/picture/shape 的坐标可能相对父(group children 是组内局部坐标)
  const ox = parentBox ? parentBox.x : 0;
  const oy = parentBox ? parentBox.y : 0;
  const x = n.box.x - (parentBox ? ox : 0) + (parentBox ? ox : 0); // group children 已是局部坐标:直接用 n.box 相对偏移
  const bx = parentBox ? n.box.x : n.box.x;
  const by = parentBox ? n.box.y : n.box.y;
  const { w, h } = n.box;
  const rot = n.box.rotationDeg ? ` transform="rotate(${n.box.rotationDeg} ${(bx + w / 2).toFixed(1)} ${(by + h / 2).toFixed(1)})"` : '';

  switch (n.type) {
    case 'picture': {
      if (!n.dataUrl) break;
      let clipAttr = '';
      if (n.clip) {
        const cid = `c${++gradId}`;
        if (n.clip.cornerRadiusPx) pendingDefs.push(`<clipPath id="${cid}"><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="${n.clip.cornerRadiusPx}"/></clipPath>`);
        else if (n.clip.polygonPoints) {
          const pts = n.clip.polygonPoints.map((v, i) => (i % 2 === 0 ? bx + v : by + v));
          const poly = pts.reduce((acc: string[], v, i) => (i % 2 === 0 ? [...acc, `${v.toFixed(1)}`] : [...acc.slice(0, -1), `${acc[acc.length - 1]},${v.toFixed(1)}`]), []);
          pendingDefs.push(`<clipPath id="${cid}"><polygon points="${poly.join(' ')}"/></clipPath>`);
        } else if (n.clip.pathData) pendingDefs.push(`<clipPath id="${cid}"><path d="${n.clip.pathData}" transform="translate(${bx} ${by})"/></clipPath>`);
        clipAttr = ` clip-path="url(#${cid})"`;
      }
      parts.push(`<image href="${n.dataUrl}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"${n.opacity !== undefined ? ` opacity="${n.opacity}"` : ''}${clipAttr}${rot} preserveAspectRatio="xMidYMid meet"${n.bgColor ? ` style="background:${n.bgColor}"` : ''}/>`);
      break;
    }
    case 'group': {
      // group children 的 box 是组内局部坐标 — 用 <g transform> 平移
      const inner = (n.children ?? []).map((c) => nodeSvg(c, { x: bx, y: by })).join('');
      parts.push(`<g transform="translate(${bx.toFixed(1)} ${by.toFixed(1)})">${inner}</g>`);
      return parts.join('');
    }
    case 'table': {
      if (n.bgFill) parts.push(`<rect x="${bx}" y="${by}" width="${w}" height="${h}" fill="${fillDef(n.bgFill, n.box)}"/>`);
      // 默认网格:任一 cell 无 borders 时画浅灰网格线(PowerPoint 默认表格样式视觉)
      const anyBorders = (n.cells ?? []).some((c) => c.borders && (c.borders.t || c.borders.l));
      if (!anyBorders && (n.cells ?? []).length) {
        const gridColor = 'rgba(127,127,127,.35)';
        // 用 cell 几何推网格:每个 cell 画上边+左边,最后一行/列补下边/右边
        for (const cell of n.cells ?? []) {
          const cb0 = { x: bx + cell.x, y: by + cell.y };
          parts.push(`<line x1="${cb0.x.toFixed(1)}" y1="${cb0.y.toFixed(1)}" x2="${(cb0.x + cell.w).toFixed(1)}" y2="${cb0.y.toFixed(1)}" stroke="${gridColor}" stroke-width="1"/>`);
          parts.push(`<line x1="${cb0.x.toFixed(1)}" y1="${cb0.y.toFixed(1)}" x2="${cb0.x.toFixed(1)}" y2="${(cb0.y + cell.h).toFixed(1)}" stroke="${gridColor}" stroke-width="1"/>`);
        }
        // 外框
        parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${gridColor}" stroke-width="1"/>`);
      }
      for (const cell of n.cells ?? []) {
        const cb = { x: bx + cell.x, y: by + cell.y, w: cell.w, h: cell.h };
        parts.push(`<rect x="${cb.x.toFixed(1)}" y="${cb.y.toFixed(1)}" width="${cb.w.toFixed(1)}" height="${cb.h.toFixed(1)}" fill="${fillDef(cell.fill, cb)}"/>`);
        // 四边边框
        const b = cell.borders;
        if (b?.t) parts.push(`<line x1="${cb.x}" y1="${cb.y}" x2="${cb.x + cb.w}" y2="${cb.y}"${strokeAttrs(b.t)}/>`);
        if (b?.b) parts.push(`<line x1="${cb.x}" y1="${cb.y + cb.h}" x2="${cb.x + cb.w}" y2="${cb.y + cb.h}"${strokeAttrs(b.b)}/>`);
        if (b?.l) parts.push(`<line x1="${cb.x}" y1="${cb.y}" x2="${cb.x}" y2="${cb.y + cb.h}"${strokeAttrs(b.l)}/>`);
        if (b?.r) parts.push(`<line x1="${cb.x + cb.w}" y1="${cb.y}" x2="${cb.x + cb.w}" y2="${cb.y + cb.h}"${strokeAttrs(b.r)}/>`);
        // 单元格文本(cells 的 text 坐标相对 cell)
        if (cell.text?.lines) {
          for (const line of cell.text.lines) {
            for (const run of line.runs) {
              parts.push(`<text x="${(cb.x + run.x).toFixed(1)}" y="${(cb.y + run.baselineY).toFixed(1)}" font-family="${run.fontFamily}" font-size="${run.fontSizePx.toFixed(1)}px"${run.bold ? ' font-weight="bold"' : ''} fill="${run.color}">${escapeHtml(run.text)}</text>`);
            }
          }
        }
      }
      break;
    }
    case 'chart': {
      const g: string[] = [];
      if (n.bgFill) g.push(`<rect x="${bx}" y="${by}" width="${w}" height="${h}" fill="${fillDef(n.bgFill, n.box)}"/>`);
      if (n.plotRect) {
        const pr = n.plotRect;
        g.push(`<rect x="${bx + pr.x}" y="${by + pr.y}" width="${pr.w}" height="${pr.h}"${pr.fill ? ` fill="${fillDef(pr.fill, { x: bx + pr.x, y: by + pr.y, w: pr.w, h: pr.h })}"` : ' fill="none"'}${pr.borderColor ? ` stroke="${pr.borderColor}" stroke-width="${pr.borderWidthPx ?? 1}"` : ''}/>`);
      }
      for (const gl of n.gridLines ?? []) g.push(`<line x1="${(bx + gl.x1).toFixed(1)}" y1="${(by + gl.y1).toFixed(1)}" x2="${(bx + gl.x2).toFixed(1)}" y2="${(by + gl.y2).toFixed(1)}" stroke="${gl.color}" stroke-width="${gl.widthPx ?? 1}"${gl.dash ? ` stroke-dasharray="${gl.dash.join(' ')}"` : ''}/>`);
      for (const al of n.axisLines ?? []) g.push(`<line x1="${(bx + al.x1).toFixed(1)}" y1="${(by + al.y1).toFixed(1)}" x2="${(bx + al.x2).toFixed(1)}" y2="${(by + al.y2).toFixed(1)}" stroke="${al.color}" stroke-width="${al.widthPx}"/>`);
      for (const bar of n.bars ?? []) g.push(`<rect x="${(bx + bar.x).toFixed(1)}" y="${(by + bar.y).toFixed(1)}" width="${bar.w.toFixed(1)}" height="${bar.h.toFixed(1)}" fill="${bar.color}"/>`);
      for (const pl of n.polylines ?? []) {
        const pts = pl.points.map((v, i) => (i % 2 === 0 ? bx + v : by + v));
        const ptStr = pts.map((v) => v.toFixed(1)).reduce((acc: string[], v, i) => (i % 2 === 0 ? [...acc, v] : [...acc.slice(0, -1), `${acc[acc.length - 1]},${v}`]), []).join(' ');
        g.push(`<polyline points="${ptStr}" fill="${pl.closed ? pl.fill ?? 'none' : 'none'}" stroke="${pl.color}" stroke-width="${pl.widthPx}"${pl.dash ? ` stroke-dasharray="${pl.dash.join(' ')}"` : ''}${pl.closed ? ' z' : ''}/>`);
      }
      for (const mk of n.markers ?? []) g.push(`<circle cx="${(bx + mk.x).toFixed(1)}" cy="${(by + mk.y).toFixed(1)}" r="${mk.r.toFixed(1)}" fill="${mk.color}"/>`);
      for (const sw of n.swatches ?? []) g.push(`<rect x="${(bx + sw.x).toFixed(1)}" y="${(by + sw.y).toFixed(1)}" width="${sw.w.toFixed(1)}" height="${sw.h.toFixed(1)}" fill="${sw.color}"/>`);
      for (const wg of n.wedges ?? []) {
        const cx = bx + wg.cx; const cy = by + wg.cy;
        const start = (wg.startDeg * Math.PI) / 180;
        const end = ((wg.startDeg + wg.sweepDeg) * Math.PI) / 180;
        const large = wg.sweepDeg > 180 ? 1 : 0;
        const p = (ang: number, r: number) => `${(cx + r * Math.cos(ang)).toFixed(1)} ${(cy + r * Math.sin(ang)).toFixed(1)}`;
        const d = wg.innerR > 0
          ? `M ${p(start, wg.outerR)} A ${wg.outerR} ${wg.outerR} 0 ${large} 1 ${p(end, wg.outerR)} L ${p(end, wg.innerR)} A ${wg.innerR} ${wg.innerR} 0 ${large} 0 ${p(start, wg.innerR)} Z`
          : `M ${cx} ${cy} L ${p(start, wg.outerR)} A ${wg.outerR} ${wg.outerR} 0 ${large} 1 ${p(end, wg.outerR)} Z`;
        g.push(`<path d="${d}" fill="${wg.color}"/>`);
      }
      for (const pth of n.paths ?? []) g.push(`<path d="${pth.d}" fill="${pth.fill}"${pth.stroke ? ` stroke="${pth.stroke}"` : ''} transform="translate(${bx} ${by})"/>`);
      for (const lb of n.labels ?? []) {
        g.push(`<text x="${(bx + lb.x).toFixed(1)}" y="${(by + lb.y).toFixed(1)}" font-size="${lb.fontSizePx.toFixed(1)}px"${lb.bold ? ' font-weight="bold"' : ''} fill="${lb.color}"${lb.rotationDeg ? ` transform="rotate(${lb.rotationDeg} ${(bx + lb.x).toFixed(1)} ${(by + lb.y).toFixed(1)})"` : ''}>${escapeHtml(lb.text)}</text>`);
      }
      if (n.border) g.push(`<rect x="${bx}" y="${by}" width="${w}" height="${h}" fill="none" stroke="${n.border.color}" stroke-width="${n.border.widthPx}"/>`);
      parts.push(`<g>${g.join('')}</g>`);
      break;
    }
    case 'placeholder-chip':
      parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="rgba(127,127,127,.1)" stroke="rgba(127,127,127,.3)" stroke-dasharray="3 3"/>`);
      break;
    default: {
      // shape / text
      const fill = fillDef(n.fill, { x: bx, y: by, w, h });
      const stroke = strokeAttrs(n.stroke);
      const shadow = shadowFilter(n.shadow);
      let body = '';
      if (n.line) {
        // 连接线:points 是相对 box 的局部坐标
        const pts = n.line.points;
        const abs: number[] = pts.map((v, i) => (i % 2 === 0 ? bx + v : by + v));
        const ptStr = abs.map((v) => v.toFixed(1)).reduce((acc: string[], v, i) => (i % 2 === 0 ? [...acc, v] : [...acc.slice(0, -1), `${acc[acc.length - 1]},${v}`]), []).join(' ');
        body = `<polyline points="${ptStr}" fill="none"${stroke}/>`;
        if (pts.length >= 4) {
          const x2 = abs[abs.length - 2]; const y2 = abs[abs.length - 1];
          const x1 = abs[abs.length - 4]; const y1 = abs[abs.length - 3];
          const ang = Math.atan2(y2 - y1, x2 - x1);
          parts.push(body);
          parts.push(arrowHead({ x: x2, y: y2 }, ang, n.line.tailEnd));
          parts.push(arrowHead({ x: x1, y: y1 }, ang + Math.PI, n.line.headEnd));
          parts.push(textSvg({ ...n, box: { ...n.box, x: bx, y: by } }));
          return parts.join('');
        }
      } else if (n.pathData) {
        // 自定义几何(custGeom)
        body = `<path d="${n.pathData}" transform="translate(${bx.toFixed(1)} ${by.toFixed(1)})" fill="${fill}"${stroke}/>`;
        if (n.fillPathData) body += `<path d="${n.fillPathData}" transform="translate(${bx.toFixed(1)} ${by.toFixed(1)})" fill="${fill}"/>`;
        if (n.strokePathData) body += `<path d="${n.strokePathData}" transform="translate(${bx.toFixed(1)} ${by.toFixed(1)})" fill="none"${stroke}/>`;
      } else if (n.polygonPoints?.length) {
        // 预设多边形(triangle/diamond/arrow)
        const pts = n.polygonPoints.map((v, i) => (i % 2 === 0 ? bx + v : by + v));
        const ptStr = pts.map((v) => v.toFixed(1)).reduce((acc: string[], v, i) => (i % 2 === 0 ? [...acc, v] : [...acc.slice(0, -1), `${acc[acc.length - 1]},${v}`]), []).join(' ');
        body = `<polygon points="${ptStr}" fill="${fill}"${stroke}/>`;
      } else {
        // 矩形类(roundRect 用精确 cornerRadiusPx)
        const rx = n.cornerRadiusPx ?? (n.presetGeometry === 'roundRect' ? Math.min(w, h) * 0.12 : n.presetGeometry === 'ellipse' ? Math.max(w, h) / 2 : 0);
        if (n.presetGeometry === 'ellipse') {
          body = `<ellipse cx="${(bx + w / 2).toFixed(1)}" cy="${(by + h / 2).toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${fill}"${stroke}/>`;
        } else {
          body = `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${fill}"${stroke}/>`;
        }
      }
      parts.push(`<g${rot}${shadow}>${body}</g>`);
      // fillOverlay(multiply 混合近似)
      if (n.fillOverlay && n.fillOverlay.kind !== 'none') {
        parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fillDef(n.fillOverlay, n.box)}" style="mix-blend-mode:multiply"/>`);
      }
      break;
    }
  }
  // 文本(所有带 text 的节点类型)
  if (n.type !== 'table' && n.type !== 'chart' && n.type !== 'group') {
    parts.push(textSvg({ ...n, box: { ...n.box, x: bx, y: by } }));
  }
  return parts.join('');
}

function renderPptxSvg(slide: { nodes: RNode[]; widthPx: number; heightPx: number; background?: RFill }): string {
  gradId = 0;
  pendingDefs.length = 0;
  const parts: string[] = [];
  const bg = slide.background?.kind === 'solid' ? slide.background.color ?? '#ffffff' : '#ffffff';
  parts.push(`<rect x="0" y="0" width="${slide.widthPx}" height="${slide.heightPx}" fill="${bg}"/>`);
  for (const n of slide.nodes) parts.push(nodeSvg(n));
  const defs = pendingDefs.length ? `<defs>${pendingDefs.join('')}</defs>` : '';
  return `<svg viewBox="0 0 ${slide.widthPx} ${slide.heightPx}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${defs}${parts.join('\n')}</svg>`;
}

async function previewPptx(url: string, fileName: string, sizeKb: number, wsFile: (p: string) => string): Promise<void> {
  const buf = await (await fetch(url)).arrayBuffer();
  const { deck } = await openPptx(new Uint8Array(buf));
  const svgs: string[] = [];
  for (let i = 0; i < deck.slides.length; i++) {
    const rendered = buildRenderSlide(deck.slides[i], deck.size, { fitWidthPx: 960 });
    svgs.push(renderPptxSvg(rendered as unknown as { nodes: RNode[]; widthPx: number; heightPx: number; background?: RFill }));
  }
  setText('fName', fileName);
  setText('fMeta', `genoffice 引擎 · ${deck.slides.length} 页`);
  const __c = $('content'); if (__c) __c.innerHTML = svgs
    .map((sv, i) => `<div class="slide" data-slide="${i + 1}">${sv}<div class="pageno">${i + 1} / ${svgs.length}</div></div>`)
    .join('');
}

// ── pdf:pdf.js 逐页 canvas ──

async function previewPdf(url: string, fileName: string): Promise<void> {
  // worker 与面板同源
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';
  const doc = await (pdfjsLib as any).getDocument({ url, isEvalSupported: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    parts.push(`<div class="slide" data-page="${i}">${canvas.toDataURL('image/png') ? `<img src="${canvas.toDataURL('image/png')}" alt="page ${i}" />` : ''}<div class="pageno">${i} / ${doc.numPages}</div></div>`);
  }
  setText('fName', fileName);
  setText('fMeta', `pdf.js · ${doc.numPages} 页`);
  const c = $('content');
  if (c) c.innerHTML = parts.join('');
}

// ── xlsx:SheetJS 解析 → HTML 表格(预览;编辑走 Phase 3 Univer)──

async function previewXlsx(url: string, fileName: string): Promise<void> {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const wb = XLSX.read(buf, { type: 'array' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows: string[][] = [];
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref'] as string) : null;
    if (range) {
      for (let r = range.s.r; r <= Math.min(range.e.r, 99); r++) {
        const row: string[] = [];
        for (let c = range.s.c; c <= Math.min(range.e.c, 25); c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          row.push(cell ? String((cell as any).v ?? '') : '');
        }
        rows.push(row);
      }
    }
    const trs = rows.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('');
    parts.push(`<div class="sheet"><div class="sheet-name">${escapeHtml(name)}</div><table>${trs}</table></div>`);
  }
  setText('fName', fileName);
  setText('fMeta', `SheetJS · ${wb.SheetNames.length} 个工作表`);
  const c = $('content');
  if (c) c.innerHTML = parts.join('');
}

// ── 主入口:panel.mounted(file)→ 引擎分发 ──

function wsFile(absPath: string): string {
  return `pi-plugin://com.pi.files/ws-file?path=${encodeURIComponent(absPath)}`;
}

let lastPath = '';
let lastMtime = 0;

async function loadFile(data: { path?: string; kind?: string; text?: string; error?: string; mtime?: number }): Promise<void> {
  const path = data.path ?? '';
  const fileName = path.split('/').pop() ?? path;
  lastPath = path;
  lastMtime = data.mtime ?? 0;
  if (!path) { showEmpty(); return; }

  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const url = wsFile(path);

  if (ext === 'docx') {
    setLoading(fileName);
    try { await previewDocx(url, fileName, lastMtime); } catch (e) { showError(String((e as Error).message ?? e)); }
    return;
  }
  if (ext === 'pptx') {
    setLoading(fileName);
    try { await previewPptx(url, fileName, 0, wsFile); } catch (e) { showError(String((e as Error).message ?? e)); }
    return;
  }
  if (ext === 'pdf') {
    setLoading(fileName);
    try { await previewPdf(url, fileName); } catch (e) { showError(String((e as Error).message ?? e)); }
    return;
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    setLoading(fileName);
    try { await previewXlsx(url, fileName); } catch (e) { showError(String((e as Error).message ?? e)); }
    return;
  }

  // 图片/文本兜底
  const head = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  const magic = new Uint8Array(await (head).arrayBuffer());
  const isImage = [0x89, 0x50].includes(magic[0]);
  if (isImage) {
    setText('fName', fileName);
    setText('fMeta', '图片');
    const __c = $('content'); if (__c) __c.innerHTML = `<img class="page" src="${url}" alt="${escapeHtml(fileName)}" />`;
    return;
  }
  // 文本
  const res = await fetch(`pi-plugin://com.pi.files/ws-file?path=${encodeURIComponent(path)}`);
  const text = await res.text();
  setText('fName', fileName);
  setText('fMeta', `文本 · ${(text.length / 1024).toFixed(1)} KB`);
  const __c = $('content'); if (__c) __c.innerHTML = `<pre class="text">${escapeHtml(text.slice(0, 100_000))}</pre>`;
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.__piPlugin !== true || d.direction !== 'backend') return;
  const p = d.payload;
  if (p?.event !== 'ui.render') return;
  const data = p.data ?? {};
  if (data.saved) {
    // 保存回执:更新 mtime(下次保存的冲突检测基准)
    if (docxState && typeof data.mtime === 'number') docxState.mtime = data.mtime;
    return;
  }
  if (data.path) { void loadFile(data); return; }
  if (data.error) { showError(data.error); return; }
  if (data.text) {
    setText('fName', data.fileName ?? '');
    setText('fMeta', '文本');
    const __c = $('content'); if (__c) __c.innerHTML = `<pre class="text">${escapeHtml(data.text)}</pre>`;
    return;
  }
  showEmpty();
});

