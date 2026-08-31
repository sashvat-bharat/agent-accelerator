export interface SSEMessage {
  id?: string;
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = "";
  // Persist across feed() calls — otherwise split SSE messages lose state (S1 fix)
  private currentEvent: string | undefined = undefined;
  private currentData: string[] = [];
  private currentId: string | undefined = undefined;

  feed(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const messages: SSEMessage[] = [];

    const lines = this.buffer.split(/\r?\n/);
    // Keep the last partial line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
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
      } else if (line.startsWith(":")) {
        // Comment / ping
        continue;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).trimStart();
        this.currentData.push(value);
      } else if (line.startsWith("event:")) {
        this.currentEvent = line.slice(6).trim();
      } else if (line.startsWith("id:")) {
        this.currentId = line.slice(3).trim();
      }
    }

    return messages;
  }

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
