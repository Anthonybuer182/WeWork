/**
 * Minimal semver range checker for plugin `engines` negotiation.
 * Supports: exact, ^, ~, >, >=, <, <=, x-ranges ("1.x", "1.2.x"), "*" and "||".
 */

type Ver = [number, number, number];

function parseVersion(v: string): Ver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(v: Ver, comp: string): boolean {
  if (comp === '' || comp === '*' || comp === 'x' || comp === 'X') return true;

  const m = /^([\^~><=]*)v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][\w.-]+)?$/.exec(comp);
  if (!m) return false;

  const op = m[1] || '=';
  const majorRaw = m[2];
  const minorRaw = m[3];
  const patchRaw = m[4];

  const isWildcard = (s: string | undefined) => s === undefined || s === 'x' || s === '*';

  // Missing parts act as ranges: "1" / "1.x" → [1.0.0, 2.0.0), "1.2" / "1.2.x" → [1.2.0, 1.3.0)
  if (isWildcard(majorRaw)) return true;
  const major = Number(majorRaw);

  if (isWildcard(minorRaw)) {
    switch (op) {
      case '=': case '': case '^': case '~':
        return cmp(v, [major, 0, 0]) >= 0 && cmp(v, [major + 1, 0, 0]) < 0;
      case '>=': return cmp(v, [major, 0, 0]) >= 0;
      case '>': return cmp(v, [major, 0, 0]) >= 0; // ">1" ≈ >=2.0.0, treat pragmatically
      case '<=': return cmp(v, [major + 1, 0, 0]) < 0;
      case '<': return cmp(v, [major, 0, 0]) < 0;
      default: return false;
    }
  }
  const minor = Number(minorRaw);

  if (isWildcard(patchRaw)) {
    switch (op) {
      case '=': case '': case '^': case '~':
        return cmp(v, [major, minor, 0]) >= 0 && cmp(v, [major, minor + 1, 0]) < 0;
      case '>=': return cmp(v, [major, minor, 0]) >= 0;
      case '>': return cmp(v, [major, minor, 0]) >= 0;
      case '<=': return cmp(v, [major, minor + 1, 0]) < 0;
      case '<': return cmp(v, [major, minor, 0]) < 0;
      default: return false;
    }
  }
  const patch = Number(patchRaw);
  const target: Ver = [major, minor, patch];

  // ^0.x and ^0.0.x tighten the upper bound per semver spec
  if (op === '^') {
    const upper: Ver = major > 0 ? [major + 1, 0, 0]
      : minor > 0 ? [0, minor + 1, 0]
        : [0, 0, patch + 1];
    return cmp(v, target) >= 0 && cmp(v, upper) < 0;
  }
  if (op === '~') {
    const upper: Ver = minor > 0 || major > 0 ? [major, minor + 1, 0] : [0, 0, patch + 1];
    return cmp(v, target) >= 0 && cmp(v, upper) < 0;
  }

  switch (op) {
    case '=': case '': return cmp(v, target) === 0;
    case '>=': return cmp(v, target) >= 0;
    case '>': return cmp(v, target) > 0;
    case '<=': return cmp(v, target) <= 0;
    case '<': return cmp(v, target) < 0;
    default: return false;
  }
}

export function satisfiesVersion(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const alternatives = range.split('||').map((s) => s.trim()).filter(Boolean);
  if (alternatives.length === 0) return true;
  return alternatives.some((alt) => alt.split(/\s+/).filter(Boolean).every((c) => satisfiesComparator(v, c)));
}
