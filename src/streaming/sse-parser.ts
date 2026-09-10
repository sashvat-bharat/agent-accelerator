/** Parsed Server-Sent Events message. */
export interface SSEMessage {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser that preserves events split across network chunks.
 *
 * @example
 * ```ts
 * const parser = new SSEParser();
 * const events = parser.feed("event: message\\ndata: hello\\n\\n");
 * ```
 */
export class SSEParser {
  private buffer = "";
  // Persist across feed() calls — otherwise split SSE messages lose state (S1 fix)
  private currentEvent: string | undefined = undefined;
  private currentData: string[] = [];
  private currentId: string | undefined = undefined;

  /** Feeds a chunk and returns all complete messages found in it. */
  feed(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const messages: SSEMessage[] = [];

    let start = 0;
    while (start < this.buffer.length) {
      const newlineIdx = this.buffer.indexOf("\n", start);
      if (newlineIdx === -1) {
        break;
      }

      let lineEnd = newlineIdx;
      if (lineEnd > start && this.buffer.charCodeAt(lineEnd - 1) === 13) {
        lineEnd--;
      }

      const line = this.buffer.slice(start, lineEnd);
      start = newlineIdx + 1;

      if (line.length === 0) {
        if (this.currentData.length > 0) {
          messages.push({
            id: this.currentId,
            event: this.currentEvent,
            data: this.currentData.join("\n"),
          });
          this.currentEvent = undefined;
          this.currentData = [];
          this.currentId = undefined;
        }
      } else if (line.charCodeAt(0) === 58) {
        // Comment / ping
        continue;
      } else if (line.startsWith("data:")) {
        const val = line.slice(5);
        this.currentData.push(val.startsWith(" ") ? val.slice(1) : val.trimStart());
      } else if (line.startsWith("event:")) {
        const val = line.slice(6);
        this.currentEvent = (val.startsWith(" ") ? val.slice(1) : val).trim();
      } else if (line.startsWith("id:")) {
        const val = line.slice(3);
        this.currentId = (val.startsWith(" ") ? val.slice(1) : val).trim();
      }
    }

    this.buffer = this.buffer.slice(start);
    return messages;
  }

  /** Flushes any unterminated final event. */
  flush(): SSEMessage[] {
    const messages: SSEMessage[] = [];
    // S7: flush pending currentData first, then treat remaining buffer as final lines (avoid duplication)
    if (this.buffer.trim() !== "") {
      // Feed remaining buffer as if terminated
      const pending = this.feed(this.buffer + "\n\n");
      messages.push(...pending);
      this.buffer = "";
    }
    if (this.currentData.length > 0) {
      messages.push({
        id: this.currentId,
        event: this.currentEvent,
        data: this.currentData.join("\n"),
      });
      this.currentEvent = undefined;
      this.currentData = [];
      this.currentId = undefined;
    }
    this.buffer = "";
    return messages;
  }
}
