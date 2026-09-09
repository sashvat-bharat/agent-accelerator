import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { createOpenAI, type OpenAIProvider as VercelOpenAIProvider } from "@ai-sdk/openai";
import { createOpenAICompatible, type OpenAICompatibleProvider as VercelOpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { getApiKey, getEnv } from "../utils/env.ts";

export interface AiSdkModelOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  env?: Record<string, string>;
}

export type AnyAiSdkProvider =
  | GoogleGenerativeAIProvider
  | VercelOpenAIProvider
  | VercelOpenAICompatibleProvider;

export const streamThoughtSignatures = new Map<string, string>();

function isBrowserFetchRuntime(): boolean {
  try {
    return typeof (globalThis as any).window !== "undefined" && typeof (globalThis as any).window.document !== "undefined";
  } catch {
    return false;
  }
}

function requestUrlOf(input: any): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
  } catch {}
  return "";
}

function createAiSdkFetch(customFetch?: typeof fetch): typeof fetch {
  const fetchFn = async (input: any, init?: any) => {
    const baseFetch = customFetch || globalThis.fetch;
    if (init && init.headers) {
      const h: any = init.headers;
      if (h instanceof Headers) {
        h.delete("x-multimodal-user-content");
        h.delete("x-thought-signature-map");
        h.delete("x-cached-content-id");
        if (isBrowserFetchRuntime()) {
          for (const k of ["user-agent", "x-session-id", "x-client-request-id", "session_id", "x-opencode-session", "x-opencode-client", "x-goog-api-client"]) {
            try { h.delete(k); } catch {}
          }
        }
      } else if (typeof h === "object" && !Array.isArray(h)) {
        if (h.authorization && !h.Authorization) {
          const token = h.authorization;
          delete h.authorization;
          h.Authorization = token;
          Object.defineProperty(h, "authorization", {
            get() {
              return this.Authorization;
            },
            set(v) {
              this.Authorization = v;
            },
            enumerable: false,
            configurable: true,
          });
        }

        // Drop legacy multimodal header (Vercel serializes image/file parts natively)
        if ((h as any)["x-multimodal-user-content"]) delete (h as any)["x-multimodal-user-content"];

        // Browser: drop SDK-internal / session headers that force a CORS
        // preflight the provider never allow-lists (surfaces as bare
        // `TypeError: Failed to fetch`). Session affinity still flows via
        // providerOptions.promptCacheKey, never via headers.
        if (isBrowserFetchRuntime()) {
          for (const k of ["User-Agent", "user-agent", "x-session-id", "x-client-request-id", "session_id", "x-opencode-session", "x-opencode-client", "x-goog-api-client"]) {
            try { delete (h as any)[k]; } catch {}
          }
        }

        // Replay Google thought_signature on OpenAI-compat Turn 2
        const sigMapHeader = h["x-thought-signature-map"];
        if (sigMapHeader) {
          delete h["x-thought-signature-map"];
          if (init.body && typeof init.body === "string") {
            try {
              const sigMap = JSON.parse(sigMapHeader);
              const bodyObj = JSON.parse(init.body);
              if (Array.isArray(bodyObj.messages)) {
                for (const msg of bodyObj.messages) {
                  if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
                    for (const tc of msg.tool_calls) {
                      const sig = sigMap[tc.id] || sigMap["default"];
                      if (sig) {
                        tc.extra_content = { google: { thought_signature: sig } };
                      }
                    }
                  }
                }
                init.body = JSON.stringify(bodyObj);
              }
            } catch {}
          }
        }

        // Add extra_body cached_content if specified
        const cacheId = h["x-cached-content-id"];
        if (cacheId) {
          delete h["x-cached-content-id"];
          if (init.body && typeof init.body === "string") {
            try {
              const bodyObj = JSON.parse(init.body);
              bodyObj.extra_body = {
                ...(bodyObj.extra_body || {}),
                google: { cached_content: cacheId },
              };
              init.body = JSON.stringify(bodyObj);
            } catch {}
          }
        }
      }
    }

    let res: Response;
    try {
      res = await baseFetch(input, init);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (e?.name === "AbortError" || msg.includes("aborted") || msg.includes("abort")) throw e;
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("Load failed") || e instanceof TypeError) {
        const url = requestUrlOf(input);
        const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
        throw new Error(
          `Network request failed (browser could not reach ${host || url || "provider"}). ` +
          `URL: ${url || "(unknown)"}. ` +
          `Usual browser causes: CORS preflight blocked (custom header not allow-listed), ad-blocker, offline, wrong Base URL, or page not on http://localhost. ` +
          `Check F12 Network tab for the failed OPTIONS/POST request. Original: ${msg}`
        );
      }
      throw e;
    }
    const contentType = res.headers.get("content-type") || "";

    // 1. JSON normalization: ensure choices[i].index exists (strict Zod schema tolerance)
    if (contentType.includes("application/json")) {
      try {
        const text = await res.text();
        const data = JSON.parse(text);
        let mutated = false;
        if (data && Array.isArray(data.choices)) {
          for (let i = 0; i < data.choices.length; i++) {
            if (data.choices[i] && data.choices[i].index === undefined) {
              data.choices[i].index = i;
              mutated = true;
            }
          }
        }
        if (mutated) {
          return new Response(JSON.stringify(data), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
        return new Response(text, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch {
        return res;
      }
    }

    // 2. SSE stream normalization: ensure choices[i].index, finish_reason, and extract thought signatures
    if (contentType.includes("text/event-stream") && res.body) {
      let hasSeenFinishReason = false;
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          const lines = text.split("\n");
          const modifiedLines: string[] = [];

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataPayload = line.slice(6).trim();
              if (dataPayload === "[DONE]") {
                if (!hasSeenFinishReason) {
                  hasSeenFinishReason = true;
                  modifiedLines.push(`data: ${JSON.stringify({
                    id: "finish-synth",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  })}`);
                }
                modifiedLines.push(line);
                continue;
              }

              try {
                const json = JSON.parse(dataPayload);
                let lineMutated = false;
                if (json && Array.isArray(json.choices)) {
                  for (let i = 0; i < json.choices.length; i++) {
                    const c = json.choices[i];
                    if (c) {
                      if (c.index === undefined) {
                        c.index = i;
                        lineMutated = true;
                      }
                      if (c.finish_reason) {
                        hasSeenFinishReason = true;
                      } else if (json.finish_reason) {
                        c.finish_reason = json.finish_reason;
                        hasSeenFinishReason = true;
                        lineMutated = true;
                      }
                      if (c.delta?.tool_calls && Array.isArray(c.delta.tool_calls)) {
                        for (let j = 0; j < c.delta.tool_calls.length; j++) {
                          const tc = c.delta.tool_calls[j];
                          if (tc) {
                            if (tc.index === undefined) {
                              tc.index = j;
                              lineMutated = true;
                            }
                            const sig = tc.extra_content?.google?.thought_signature;
                            if (sig) {
                              if (tc.id) streamThoughtSignatures.set(tc.id, sig);
                              streamThoughtSignatures.set("latest", sig);
                            }
                          }
                        }
                      }
                    }
                  }
                  if (lineMutated) {
                    modifiedLines.push(`data: ${JSON.stringify(json)}`);
                    continue;
                  }
                }
              } catch {}
            }
            modifiedLines.push(line);
          }
          controller.enqueue(new TextEncoder().encode(modifiedLines.join("\n")));
        },
      });

      return new Response(res.body.pipeThrough(transformStream), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    return res;
  };
  return fetchFn as typeof fetch;
}

/**
 * Creates or retrieves a Vercel AI SDK provider instance for any given provider ID.
 */
export function getAiSdkProvider(
  providerId: string,
  options?: AiSdkModelOptions
): AnyAiSdkProvider {
  const normId = providerId.toLowerCase().trim().replace(/\/.*$/, "");
  const effectiveFetch = createAiSdkFetch(options?.fetch);

  if (normId === "google") {
    const apiKey = options?.apiKey || getApiKey("google", undefined, options?.env);
    const baseURL = options?.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    return createGoogleGenerativeAI({
      apiKey,
      baseURL,
      headers: options?.headers,
      fetch: effectiveFetch,
    });
  }

  if (normId === "openai") {
    const apiKey =
      options?.apiKey ||
      options?.env?.["OPENAI_BASE_API_KEY"] ||
      options?.env?.["OPENAI_API_KEY"] ||
      getEnv("OPENAI_BASE_API_KEY") ||
      getEnv("OPENAI_API_KEY") ||
      getApiKey("openai", undefined, options?.env);

    const baseURL =
      options?.baseUrl ||
      options?.env?.["OPENAI_BASE_URL"] ||
      getEnv("OPENAI_BASE_URL") ||
      getEnv("OPENAI_API_BASE") ||
      "https://api.openai.com/v1";

    if (baseURL && !baseURL.includes("api.openai.com")) {
      return createOpenAICompatible({
        name: "openai",
        baseURL,
        apiKey: apiKey || "dummy-key",
        headers: options?.headers,
        fetch: effectiveFetch,
      });
    }

    return createOpenAI({
      apiKey: apiKey || "dummy-key",
      baseURL,
      headers: options?.headers,
      fetch: effectiveFetch,
    });
  }

  if (normId === "opencode") {
    const apiKey = options?.apiKey || getApiKey("opencode", undefined, options?.env);
    const baseURL =
      options?.baseUrl ||
      options?.env?.["OPENCODE_BASE_URL"] ||
      getEnv("OPENCODE_BASE_URL") ||
      "https://opencode.ai/zen/v1";

    return createOpenAICompatible({
      name: "opencode",
      baseURL,
      apiKey: apiKey || "dummy-key",
      headers: options?.headers,
      fetch: effectiveFetch,
    });
  }

  if (normId === "openrouter") {
    const apiKey = options?.apiKey || getApiKey("openrouter", undefined, options?.env);
    const baseURL =
      options?.baseUrl ||
      options?.env?.["OPENROUTER_BASE_URL"] ||
      getEnv("OPENROUTER_BASE_URL") ||
      "https://openrouter.ai/api/v1";

    return createOpenAICompatible({
      name: "openrouter",
      baseURL,
      apiKey: apiKey || "dummy-key",
      headers: options?.headers,
      fetch: effectiveFetch,
    });
  }

  // Custom / OpenAI-compatible provider (groq, cerebras, together, fireworks, ollama, etc.)
  const envPrefix = normId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const apiKey =
    options?.apiKey ||
    options?.env?.[`${envPrefix}_API_KEY`] ||
    options?.env?.[`${envPrefix}_BASE_API_KEY`] ||
    options?.env?.["OPENAI_BASE_API_KEY"] ||
    options?.env?.["OPENAI_API_KEY"] ||
    getEnv(`${envPrefix}_API_KEY`) ||
    getEnv(`${envPrefix}_BASE_API_KEY`) ||
    getEnv("OPENAI_BASE_API_KEY") ||
    getEnv("OPENAI_API_KEY") ||
    getApiKey(normId, undefined, options?.env) ||
    "dummy-key";

  const baseURL =
    options?.baseUrl ||
    options?.env?.[`${envPrefix}_BASE_URL`] ||
    options?.env?.[`${envPrefix}_BASEURL`] ||
    options?.env?.[`${envPrefix}_API_BASE`] ||
    getEnv(`${envPrefix}_BASE_URL`) ||
    getEnv(`${envPrefix}_BASEURL`) ||
    getEnv(`${envPrefix}_API_BASE`) ||
    getEnv("OPENAI_BASE_URL") ||
    getEnv("OPENAI_API_BASE") ||
    "https://api.openai.com/v1";

  return createOpenAICompatible({
    name: normId,
    baseURL,
    apiKey,
    headers: options?.headers,
    fetch: effectiveFetch,
  });
}

/**
 * Returns a Vercel AI SDK LanguageModel instance for any provider and model.
 */
export function getAiSdkModel(
  providerId: string,
  modelId: string,
  options?: AiSdkModelOptions
): LanguageModelV4 {
  const cleanId = modelId.replace(new RegExp(`^(${providerId}|google|openai|opencode|openrouter|models?)/`, "i"), "");
  const provider = getAiSdkProvider(providerId, options);

  if ("chat" in provider && typeof (provider as any).chat === "function") {
    return (provider as any).chat(cleanId);
  }

  if (typeof provider === "function") {
    return (provider as any)(cleanId);
  }

  if ("chatModel" in provider && typeof (provider as any).chatModel === "function") {
    return (provider as any).chatModel(cleanId);
  }

  if ("languageModel" in provider && typeof (provider as any).languageModel === "function") {
    return (provider as any).languageModel(cleanId);
  }

  throw new Error(`Unsupported Vercel AI SDK provider instance for ${providerId}`);
}
