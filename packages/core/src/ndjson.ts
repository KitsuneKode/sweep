/** Bound each UTF-8 line before buffering it, including newline-free output. */
export class NdjsonDecoder {
  private pending = "";
  private pendingBytes = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxBytes: number,
  ) {}

  push(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      this.pendingBytes += Buffer.byteLength(part, "utf8");
      if (this.pendingBytes > this.maxBytes) {
        throw new Error(`rust engine event exceeded ${this.maxBytes} bytes`);
      }
      this.pending += part;
      if (newline === -1) return;
      this.emit();
      start = newline + 1;
    }
  }

  finish(): void {
    if (this.pending.length > 0) this.emit();
  }

  private emit(): void {
    const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    this.pendingBytes = 0;
    if (line.length > 0) this.onLine(line);
  }
}
