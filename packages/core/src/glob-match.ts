/**
 * Linear `*`/`?` glob matching shared by pattern and ignore matchers.
 *
 * The old implementation compiled each pattern to `^...$` RegExp with `.*` for
 * `*` and `.` for `?`. Regex engines solve this fine for normal inputs, but a
 * hostile pattern (`*a*a*a*...`) forces backtracking that can stall the scan
 * before the walk even matters. The two-pointer algorithm below is the same
 * `*`-with-backtracking shape libc `glob(3)` uses: `*` retries extend one
 * candidate position at a time, so worst case is O(pattern × name) with tiny
 * constants - and both lengths are already capped at config load.
 *
 * Operates on Unicode scalar values, matching the Rust engine. ASCII stays
 * on the allocation-free string path.
 */

/** `*` matches any run (including empty and `/`); `?` matches one Unicode scalar. */
export function globMatch(pattern: string, name: string): boolean {
  const unicode = /[\uD800-\uDFFF]/.test(pattern) || /[\uD800-\uDFFF]/.test(name);
  const source: string | string[] = unicode ? Array.from(pattern) : pattern;
  const value: string | string[] = unicode ? Array.from(name) : name;
  let p = 0;
  let s = 0;
  // Last `*` position in the pattern and the name offset it has consumed so
  // far - on a mismatch we resume the star one char further.
  let starP = -1;
  let starS = -1;

  while (s < value.length) {
    if (p < source.length && (source[p] === "?" || source[p] === value[s])) {
      p++;
      s++;
    } else if (p < source.length && source[p] === "*") {
      starP = p++;
      starS = s;
    } else if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (p < source.length && source[p] === "*") p++;
  return p === source.length;
}

/**
 * Compile `*`/`?` patterns once: literals go in a `Set` (O(1) lookups dominate
 * - most patterns are plain names), globs stay as source strings matched by
 * `globMatch`. Callers lowercase both patterns and keys when case-insensitive.
 */
export function compileGlobMatchers(
  patterns: string[],
  caseInsensitive: boolean,
): (name: string) => boolean {
  const exact = new Set<string>();
  const globs: string[] = [];
  for (const raw of patterns) {
    const source = caseInsensitive ? raw.toLowerCase() : raw;
    if (source.includes("*") || source.includes("?")) {
      globs.push(source);
    } else {
      exact.add(source);
    }
  }
  if (globs.length === 0) {
    return (name) => exact.has(caseInsensitive ? name.toLowerCase() : name);
  }
  return (name) => {
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (exact.has(key)) return true;
    return globs.some((glob) => globMatch(glob, key));
  };
}
