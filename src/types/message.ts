/**
 * Multimodal input modalities supported: Text, Image, Audio, Video, File
 */

/** Text content within a multimodal message. */
export interface TextPart {
  type: "text";
  text: string;
  thoughtSignature?: string;
}

/** Image content accepted as a URL, data, path, or binary value. */
export interface ImagePart {
  type: "image";
  /**
   * Raw base64 data, data URL (data:image/...;base64,...), remote URL (https://...), or local file path
   */
  image: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

/** Audio content accepted as a URL, data, path, or binary value. */
export interface AudioPart {
  type: "audio";
  /**
   * Raw base64 data, data URL (data:audio/...;base64,...), remote URL, or local file path
   */
  audio: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

/** File/document content (PDF, text, etc.) accepted as a URL, data, path, or binary value. */
export interface FilePart {
  type: "file";
  /**
   * Raw base64 data, data URL (data:...;base64,...), remote URL (https://...), or local file path
   */
  file: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
  filename?: string;
}

/** Video content accepted as a URL, data, path, or binary value. */
export interface VideoPart {
  type: "video";
  /**
   * Raw base64 data, data URL (data:video/...;base64,...), remote URL, or local file path
   */
  video: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
}

/** Assistant-generated structured tool invocation. */
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

/** Tool execution result returned to the model context. */
export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

/** Provider reasoning/thinking content. */
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  thoughtSignature?: string;
}

/** Any supported text, media, reasoning, tool-call, or tool-result part. */
export type ContentPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | FilePart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Normalized conversation message. */
export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  thoughtSignature?: string;
}

/**
 * Normalized input context passed to AI providers
 */
/** Provider-neutral prompt context passed into generate/stream calls. */
export interface ProviderContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: Record<string, unknown>[];
  cachedContentId?: string;
}
