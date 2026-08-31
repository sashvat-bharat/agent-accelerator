import type { Message, ContentPart } from "../types/message.ts";
import type { ProviderContext } from "../types/message.ts";

/**
 * High-speed token estimation utility.
 * For English text, average is ~4 characters per token or ~0.75 words per token.
 * Code and symbols average ~2-3 characters per token.
 */
export function estimateTokensFromText(text: string): number {
  if (!text || text.length === 0) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  // Detect code-heavy text (braces, semicolons, camelCase dense)
  const codeMarkers = (text.match(/[{};=<>/\\]/g) || []).length;
  const isCodeHeavy = codeMarkers > chars * 0.05;
  const charDivisor = isCodeHeavy ? 3.0 : 3.8;
  const wordFactor = isCodeHeavy ? 1.6 : 1.3;
  const tokenEstimate = Math.ceil(Math.max(chars / charDivisor, words * wordFactor));
  return tokenEstimate;
}

export function estimateTokensFromPart(part: ContentPart): number {
  switch (part.type) {
    case "text":
      return estimateTokensFromText(part.text);
    case "thinking":
      return estimateTokensFromText(part.thinking);
    case "image":
      // Standard vision token cost ~258 tokens per low-res / 1000-1600 per high-res tile
      return 258;
    case "audio":
      // ~25 tokens per second of audio
      return 150;
    case "video":
      // ~250 tokens per frame / minute
      return 500;
    case "tool_call":
      return (
        estimateTokensFromText(part.name) +
        estimateTokensFromText(JSON.stringify(part.arguments)) +
        15
      );
    case "tool_result":
      return (
        estimateTokensFromText(part.name) +
        estimateTokensFromText(
          typeof part.result === "string" ? part.result : JSON.stringify(part.result)
        ) +
        10
      );
    default:
      return 0;
  }
}

export function estimateTokensFromMessage(message: Message): number {
  let count = 4; // Message metadata overhead (role, markers)
  if (typeof message.content === "string") {
    count += estimateTokensFromText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      count += estimateTokensFromPart(part);
    }
  }
  return count;
}

export function countTokens(
  input: string | Message[] | ProviderContext
): number {
  if (typeof input === "string") {
    return estimateTokensFromText(input);
  }

  if (Array.isArray(input)) {
    let total = 0;
    for (const msg of input) {
      total += estimateTokensFromMessage(msg);
    }
    return total;
  }

  let total = 0;
  if (input.systemPrompt) {
    total += estimateTokensFromText(input.systemPrompt) + 5;
  }
  if (input.messages) {
    for (const msg of input.messages) {
      total += estimateTokensFromMessage(msg);
    }
  }
  if (input.tools) {
    total += estimateTokensFromText(JSON.stringify(input.tools)) + 20;
  }
  return total;
}
