/**
 * Make a filesystem-derived or config-derived string safe to render in a
 * terminal. POSIX filenames can legally contain ESC, other C0/C1 controls,
 * DEL, and Unicode bidi/zero-width characters - printing one raw lets a
 * hostile directory name inject ANSI sequences (clear the screen, move the
 * cursor, spoof a confirmation dialog) into scan output or the TUI.
 *
 * Unsafe codepoints are escaped `ls -b`-style (`\xNN`, `\uNNNN`, `\u{NNNNN}`)
 * so the real name stays legible for diagnostics instead of being stripped.
 */
export function sanitizeTerminalText(value: string): string {
  return escapeUnsafe(value, false);
}

/**
 * Same escaping as sanitizeTerminalText but keeps `\n` and `\t` - for
 * composed error/log text where the message itself uses whitespace for
 * layout. A hostile newline embedded in a path can still fake a second
 * message line (cosmetic), but escape injection stays impossible.
 */
export function sanitizeMultilineTerminalText(value: string): string {
  return escapeUnsafe(value, true);
}

function escapeUnsafe(value: string, keepWhitespace: boolean): string {
  let result = "";
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    if (keepWhitespace && (cp === 0x0a || cp === 0x09)) {
      result += char;
      continue;
    }
    if (!isUnsafeCodepoint(cp)) {
      result += char;
      continue;
    }
    result +=
      cp <= 0xff
        ? `\\x${cp.toString(16).padStart(2, "0")}`
        : cp <= 0xffff
          ? `\\u${cp.toString(16).padStart(4, "0")}`
          : `\\u{${cp.toString(16)}}`;
  }
  return result;
}

/**
 * Codepoints that must never reach a terminal raw:
 * - C0 controls (incl. ESC - the ANSI introducer) and DEL
 * - C1 controls (0x80–0x9F), the less famous escape-capable range
 * - Unicode Cf spoofers: zero-width chars + joiners, LRM/RLM, bidi
 *   embeddings/overrides/isolates (can reorder displayed text or hide it)
 * - U+FEFF (BOM / zero-width no-break space)
 */
function isUnsafeCodepoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}
