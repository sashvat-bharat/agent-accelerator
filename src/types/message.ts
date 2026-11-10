/**
 * Multimodal input modalities supported: Text, Image, Audio, Video, File
 */

/** Text content within a multimodal message. */
export interface TextPart {
  type: "text";
  text: string;
  thoughtSignature?: string;
}

/** Detail level a provider spends on one image or video (more detail = more input tokens). Google (images and videos) and OpenRouter (images, as `image_url.detail`) honour it; other providers ignore it with a warning. */
export type MediaResolution = "low" | "medium" | "high" | "ultra_high";

/** How a provider reads a video: `"static"` (fixed-rate frames, the default) or `"agentic"` (the model navigates the timeline and loads only what the prompt needs). Only Google honours it, and agentic mode only on some Gemini models; other providers ignore it with a warning. */
export type VideoProcessing = "static" | "agentic";

/** Image content accepted as a URL, data, path, or binary value. */
export interface ImagePart {
  type: "image";
  /**
   * Raw base64 data, data URL (data:image/...;base64,...), remote URL (https://...), or local file path
   */
  image: string | Uint8Array | ArrayBuffer;
  mimeType?: string;
  /** Detail level for this image (Google: `low` 280, `medium` 560, `high` 1120, `ultra_high` 2240 tokens). */
  resolution?: MediaResolution;
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
  /** Detail level per frame (Google: `low`/`medium` 70, `high` 280 tokens). */
  resolution?: MediaResolution;
  /** How the video is read (Google: `"agentic"` lets the model explore a long video instead of loading every frame). */
  processing?: VideoProcessing;
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
  /**
   * Provider pairing identifier (e.g. Responses `call_id`), preserved so
   * history builders can pair results without inventing ids.
   */
  callId?: string;
}

/** Tool execution result returned to the model context. */
export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
  /** This call's log file, relative to the session folder (see `ToolExecutionContext.log`). */
  logFile?: string;
  /** The tool ended the run with `ctx.stop(reason)` (see `ToolExecutionContext.stop`). */
  stopped?: boolean;
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

/** A provider's raw output steps for one assistant turn, kept to replay history byte-exact (only the tagged provider reads them). */
export interface ProviderSteps {
  provider: string;
  steps: unknown[];
}

/** Normalized conversation message. */
export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  thoughtSignature?: string;
  /** Raw provider output steps of an assistant turn (opaque; e.g. Google `steps`). */
  providerSteps?: ProviderSteps;
}

/**
 * Normalized input context passed to AI providers
 */
/** Provider-neutral prompt context passed into generate/stream calls. */
export interface ProviderContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: Record<string, unknown>[];
}
