/**
 * Resolution hooks used by `register.mjs`. Runs on Node's loader thread, so it
 * must stay dependency-free and synchronous.
 */

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Stand-in for the `electron` module — see electron-stub.mjs. */
const electronStub = new URL('./electron-stub.mjs', import.meta.url).href;

/** Order matters: a bare `./todos` is a directory, and directories are not
 *  importable, so index files are checked after sibling files. */
const SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

const HAS_EXTENSION = /\.(?:[cm]?[jt]s|json)$/;
const RELATIVE = /^\.\.?\//;

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStub, shortCircuit: true };
  }

  if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    for (const suffix of SUFFIXES) {
      const candidate = new URL(`${base.href}${suffix}`);
      if (isFile(candidate)) return { url: candidate.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
