// esbuild inject — real Buffer polyfill (jszip/engines depend on Buffer
// semantics beyond the hand-rolled shim).
import { Buffer as _Buffer } from 'buffer';
if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = _Buffer;
}
