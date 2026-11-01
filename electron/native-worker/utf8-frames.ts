/** Strict, bounded JSON-lines transport decoding. Retain partial UTF-8 code
 * points across reads; malformed/truncated input must never change an action.
 */
export class Utf8Frames {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private text = '';
  private bytes = 0;
  push(chunk: Uint8Array): string[] {
    // Bound raw bytes of each incomplete frame, independently of UTF-16 size.
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      this.append(chunk.subarray(start, i + 1));
      lines.push(this.text.slice(0, -1)); this.text = ''; this.bytes = 0; start = i + 1;
    }
    this.append(chunk.subarray(start)); return lines;
  }
  private append(bytes: Uint8Array) {
    this.bytes += bytes.length;
    if (this.bytes > 2 * 1024 * 1024) throw new Error('guard-frame-too-large');
    this.text += this.decoder.decode(bytes, { stream: true });
  }
  end(): void {
    this.text += this.decoder.decode();
    if (this.text || this.bytes) throw new Error('guard-frame-truncated');
  }
}
