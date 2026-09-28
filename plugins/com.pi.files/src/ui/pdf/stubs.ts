/**
 * Stubs for GenOffice's `PdfApi` (window.pdfApi).
 *
 * 55 members, of which the renderer calls a scattered handful during bootstrap —
 * none of them guessable from the outside (the first slides run died on
 * `clipboardProbe`). Each returns the SHAPE its declaration promises, so a
 * stubbed call degrades to "feature unavailable" rather than blowing up
 * somewhere far from the cause.
 *
 * Every real implementation lives in the shim next to this file, spread over
 * the top of this object.
 *
 * Generated from apps/pdf/src/shared/ipc.ts by scripts/gen-api-stubs.mjs. Regenerate rather
 * than edit — but do check it in: it is read far more often than written.
 */
export const pdfApiStubs: Record<string, unknown> = {
  consumePending: () => Promise.resolve(null),
  readFile: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
  requestRedactionCopy: () => Promise.resolve(false),
  autoRename: () => Promise.resolve(null),
  isUntitled: () => Promise.resolve(false),
  validateTextEdits: () => Promise.resolve([]),
  listEditFonts: () => Promise.resolve([]),
  canDrawText: () => Promise.resolve(false),
  listPageImages: () => Promise.resolve([]),
  listStaticFormFills: () => Promise.resolve([]),
  ocrPage: () => Promise.resolve([]),
  pageImagePng: () => undefined,
  pagePreviewPng: () => Promise.resolve(null),
  extractPages: () => Promise.resolve(null),
  insertPdf: () => Promise.resolve(null),
  insertBlankPage: () => Promise.resolve(null),
  splitPdf: () => Promise.resolve(null),
  mergePdf: () => Promise.resolve(null),
  mergePages: () => Promise.resolve(null),
  replacePages: () => Promise.resolve(null),
  setPageSize: () => Promise.resolve(null),
  splitPages: () => Promise.resolve(null),
  cropPages: () => Promise.resolve(null),
  exportImages: () => Promise.resolve(null),
  convertOffice: () => Promise.resolve(),
  createDocument: () => Promise.resolve(null),
  imageSearch: () => Promise.resolve(null),
  fetchImage: () => Promise.resolve(null),
  generateImage: () => Promise.resolve(''),
  listSavedSignatures: () => Promise.resolve([]),
  addSavedSignature: () => Promise.resolve([]),
  removeSavedSignature: () => Promise.resolve([]),
  getUsername: () => Promise.resolve(''),
  setDirty: () => undefined,
  onCloseSaveRequest: () => () => undefined,
  sendCloseSaveResult: () => undefined,
  onSaveAsRequest: () => () => undefined,
  sendSaveAsResult: () => undefined,
  onSaveAsFlow: () => () => undefined,
  onPrintRequest: () => () => undefined,
  onFileRenamed: () => () => undefined,
  getLanguage: () => Promise.resolve(null),
  onLanguageChanged: () => () => undefined,
  getTheme: () => Promise.resolve(null),
  onThemeChanged: () => () => undefined,
  getAiPanelPrefs: () => Promise.resolve(null),
  setAiPanelPrefs: () => Promise.resolve(null),
  onAiPanelPrefsChanged: () => () => undefined,
  onChromePressed: () => () => undefined,
  getAiSettings: () => Promise.resolve(null),
  gskStatus: () => Promise.resolve(false),
  aiStream: () => Promise.resolve(),
  aiStreamCancel: () => Promise.resolve(),
  onAiStream: () => () => undefined,
};
