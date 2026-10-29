/**
 * Loader hooks for tests that import main-process TypeScript directly.
 *
 * Node runs `.ts` through type stripping, but it will not guess file
 * extensions: the app's sources import `./todos` and expect a bundler to find
 * `./todos/index.ts`. The hooks below restore that resolution for tests and
 * swap `electron` for a stub, without asking the app sources to change.
 */

import { register } from 'node:module';

register(new URL('./hooks.mjs', import.meta.url).href);
