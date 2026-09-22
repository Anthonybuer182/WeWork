/** R1 spike: the lazily-imported chunk. Its only job is to prove it loaded. */
export function hello(): string {
  return 'chunk loaded ✓ (esm + splitting works under pi-plugin://)';
}
