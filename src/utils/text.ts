/** Small string helpers shared across the SDK. */

/** The text before the first `separator`, or all of it when there is none (`beforeFirst("audio/mp3; q=1", ";")` is `"audio/mp3"`). */
export function beforeFirst(text: string, separator: string): string {
  const at = text.indexOf(separator);
  return at < 0 ? text : text.slice(0, at);
}
