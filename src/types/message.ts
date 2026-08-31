/**
 * Multimodal input modalities supported: Text, Image, Audio, Video
 */

export interface TextPart {
  type: "text";
  text: string;
  thoughtSignature?: string;
}

export interface ImagePart {
  type: "image";
  /**
   * Raw base64 data, data URL (data:image/...;base64,...), remote URL (https://...), or local file path
   */
  image: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

export interface AudioPart {
  type: "audio";
  /**
   * Raw base64 data, data URL (data:audio/...;base64,...), remote URL, or local file path
   */
  audio: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

export interface VideoPart {
  type: "video";
  /**
   * Raw base64 data, data URL (data:video/...;base64,...), remote URL, or local file path
   */
  video: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Raw stringified arguments if available
   */
  rawArguments?: string;
  /**
   * Optional Gemini thought signature associated with this tool call
   */
  thoughtSignature?: string;
}

export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  thoughtSignature?: string;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  thoughtSignature?: string;
}

/**
 * Normalized input context passed to AI providers
 */
export interface ProviderContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: Record<string, unknown>[];
  cachedContentId?: string;
}
