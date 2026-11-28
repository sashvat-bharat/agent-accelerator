# Provider notes

> What the SDK sends to each provider and how it reads the answer. You never need this to use the SDK. Read it when a provider behaves in a way that surprises you.

The SDK talks to every provider with plain `fetch`. Your code is the same for all of them. These notes list what the adapters do underneath. How a model string is routed is in [Models and providers](models-and-providers.md). The cache and thinking options are in [Reasoning and caching](reasoning-and-caching.md).

## Google

The adapter uses the Interactions API (`POST {baseUrl}/interactions`, streaming with `?alt=sse`).

- **History** is chained on Google's side with `previous_interaction_id`. If the conversation switches to another provider or model, or the chain has expired, the SDK sends the full history again. Each assistant turn keeps Google's raw output steps, so a resent history is identical to what Google produced, thought signatures included. That keeps the reasoning and the cache prefix intact.
- **Thinking** is sent as `thinking_level` (`minimal`, `low`, `medium` or `high`). `xhigh` and `max` become `high`, `none` and `dynamic` are left out. Reasoning summaries are switched on whenever thinking is on.
- **Stream endings.** Only `interaction.completed` ends a stream. A stream that stops before it with nothing in it, or while a tool call is still being written (its `step.stop` never came), fails as a retryable `incomplete_stream`, and its tool calls never run. A cut text answer keeps its text, but the next turn sends the full history instead of continuing the unfinished interaction. A call cut off by the output limit never runs, and its saved step holds `{}`.
- **Errors in a stream or a failed interaction** are retryable when their code names a temporary failure: `gateway_timeout`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`, `INTERNAL` or `DEADLINE_EXCEEDED`. Other codes, such as `INVALID_ARGUMENT`, fail for good.
- **Caching** is implicit only. Another `cache` value warns and falls back.
- **Tool schemas** are converted to the OpenAPI 3.0 subset that Google accepts.
- **Long answers on Gemini 4.** Google allows 65,536 output tokens per request. A `gemini-4*` model with a higher `maxOutputTokens` runs as a background interaction, with no extra option. `run()` polls (after 2 seconds, then every 5 seconds). `stream()` reconnects with `last_event_id` after a dropped connection, and 15 minutes of silence counts as dropped. Cancelling cancels the interaction on Google's side, so billing stops. `limits.requestTimeoutMs` times each HTTP request, not the whole run. Any other Google model above 65,536 fails with a `ConfigError` before the network.

## OpenAI

The adapter uses the Responses API (`POST {baseUrl}/responses`).

- **Every turn is stateless.** The full history is sent with `store: false`. `previous_response_id`, `background` and conversations are never used.
- **Thinking** is sent as `reasoning.effort`, with the level as you wrote it. `dynamic` is left out.
- **Reasoning is kept across a tool loop.** A reasoning model returns encrypted reasoning items. The SDK asks for them (`reasoning.encrypted_content`), saves them with the turn and sends them back, unchanged, with the tool results of the same run. Reasoning of finished turns is not sent again.
- **Cache.** `prompt_cache_key` (at most 64 characters) pins requests to one cache. Cache reads and, from GPT-5.6, cache writes are reported in `usage`. A write is priced at the catalog's `cache_write` price, which is the `30m` rate, so a `12h` write costs about twice as much and the estimate is low.
- **Service tier** `flex` or `priority` is passed as `service_tier`.
- **Stream endings** are read as they come: `response.incomplete` (finish reason `length`, or `refusal` when the content filter cut it), `response.failed` and `error`. The codes `server_error` and `rate_limit_exceeded` are retryable and the others are not. Reasoning summaries arrive as `thinking`.
- **Tool call ids** from other providers are made valid (letters, digits, `_` and `-`, at most 64 characters, a hash when cut), the same way on the call and on its result.
- **Not sent:** `temperature`, `top_p`, and anything that chains conversations. `max_output_tokens` is sent when you set it. A `video` part is rejected before the network.

## Anthropic

The adapter uses the Messages API (`POST {baseUrl}/messages`) for the Claude 5 family. The API version is `2026-10-21`. A `headers` entry named `anthropic-version` overrides it. No `anthropic-beta` header is ever sent.

- **Every turn is stateless.** Roles alternate, and the tool results of a turn travel together in one user message, before any text.
- **Thinking.** Claude 5 models think adaptively. A level other than `dynamic` sends `output_config.effort` (`minimal` becomes `low`) and a summarized thinking display, so `thinking_delta` events carry readable text. `none` uses the model's own off switch where it has one (`between_tools` on Sonnet 5.5, `disabled` on Haiku 5.5, Opus 5 and Sonnet 5). Otherwise it warns and uses effort `low`. The signed thinking blocks of the **current tool loop** are saved as `providerSteps` and sent back unchanged, because the API rejects an edited block. Blocks of finished turns are not sent again.
- **Caching.** `implicit` (and unset) puts an automatic `cache_control` mark on the last block. `5m` and `1h` set its lifetime. `30m` and `12h` warn and fall back. Anthropic reports cache reads and writes outside `input_tokens`. The SDK adds them back, so `cacheReadTokens` and `cacheWriteTokens` are parts of `inputTokens`, as everywhere else. A write is priced at the catalog's single cache-write price (the 5 minute rate), so a `1h` write is under-estimated.
- **Tool choice.** `required` and a pinned tool map to `any` and `tool`. Opus 5.5, Sonnet 5.5 and the Fable and Mythos 5.1 and 5.2 models answer forced tool use with a 400. For them the SDK warns once and lets the model decide. `validated` is Google only.
- **Structured output** uses `output_config.format`. The schema is cleaned to the subset Anthropic accepts (closed objects, numeric and length limits moved into the description). The answer is still checked against your own schema. Strict tools get the same cleaning.
- **Input.** Text, images (JPEG, PNG, GIF, WebP) and PDF or plain-text documents. See [Media input](media-input.md#anthropic).
- **Output limits.** `max_tokens` is required, so it defaults to the model's output limit, capped at 64,000. Set `maxOutputTokens` to change it. `temperature`, `top_p` and `top_k` are never sent, because this API version answers them with a 400. `serviceTier: "priority"` sends `service_tier: "auto"`, and `flex` warns.
- **Errors** are one line with the status, Anthropic's error type and the `request_id`. 429, 5xx, 504 and 529 (overloaded) are retryable, and so is an `error` event inside a stream. The monthly spend-limit 429 (`enforced_spend_limit_reached`) is never retried. A stream that ends without `message_stop` fails as a retryable `incomplete_stream`. A call cut off by `max_tokens` never runs its tool calls.
- **Not supported:** server tools (web search, web fetch, code execution), the Batches, Files and token-counting endpoints, citations and prefill.

## OpenRouter

The adapter uses Chat Completions (`POST {baseUrl}/chat/completions`).

- **Every turn is stateless.** The whole `messages` list is sent.
- **Session affinity** is the body field `session_id`, plus the `x-session-id` header. The body wins.
- **Thinking** is sent as `reasoning.effort`, like OpenAI. `dynamic` is left out. The thinking text you get comes from the `reasoning_details` blocks (a block's `text`, or the `summary` of a summary block, which is how OpenAI models arrive), else from `reasoning`. Encrypted blocks have no text, so they never hide `reasoning`.
- **Tool choice.** `auto` is left out. `none`, `required` and a pinned tool are sent. `validated` is Google only and is dropped with one warning.
- **Errors inside a stream.** OpenRouter can send an error chunk in a stream that answered 200. The SDK reads it like an HTTP error. The status comes from the chunk's numeric `code`, else from its `error_type` (`rate_limit_exceeded` is 429, `provider_overloaded` 503, `provider_unavailable` 502, `timeout` 504 and `server` 500), else from the name in `code` (as in [Retries](limits-and-retries.md#retries)). `finish_reason: "error"` is a retryable 502. `runRetries` retries the retryable ones.
- **Reasoning and PDFs.** A turn's `reasoning_details` blocks and parsed-PDF annotations are saved and sent back exactly as OpenRouter returned them.
- **Cost.** The provider's own `cost` is used when it is reported. A reported `0` (a free model, a cache hit) stays a known zero.
- **Cache.** `anthropic/...` and `~anthropic/...` models accept the `5m` and `1h` settings.
- **Files, audio and video** are described in [Media input](media-input.md#openrouter). No plugin is ever added. OpenRouter reads a file natively or with its own parser.
- **Routing options** (`order`, `only`, `sort`, `data_collection` and the rest) come from the `openrouter` setting, never from `AgentConfig`. Nothing is sent for a key you did not set. See [Settings](settings.md).

## OpenAI-compatible services

Groq, Together, Ollama, vLLM and any other service with Chat Completions use one adapter. Name them with a prefix: `groq/llama-3.3-70b-versatile`.

```ts
import { ensureCustomProvider, getProvider } from "agent-accelerator";

const groq = ensureCustomProvider("groq", {
  baseUrl: "https://api.groq.com/openai/v1",
});
console.log(groq.id, getProvider("groq") === groq);
```

- The adapter is created once per prefix. A second `ensureCustomProvider` with another `baseUrl` throws a `ConfigError`.
- It sends no `session_id` or `prompt_cache_key`, because strict services reject unknown fields. Affinity goes in headers only.
- Thinking text is read from `reasoning_details` blocks (`text` or `summary`), else `reasoning_content` (DeepSeek, vLLM, Qwen), else `reasoning`, the same way on `run()` and `stream()`. It is shown only, never sent back.
- Streamed tool calls are placed by their `index`. A piece without one continues the current call, unless it carries a new id: then it is the next call, so parallel calls from a server that sends no index stay apart.
- An error sent with HTTP 200 or inside a stream is retried when its `code` is a status number (`429`) or names a temporary failure (`overloaded`, `rate_limit_exceeded` ...). `finish_reason: "error"` is a retryable 502, in a stream and in a whole reply.
- Its price and abilities are unknown unless you describe the model with `registerModel`. See [Models and providers](models-and-providers.md#the-model-catalog).
- `ensureCustomProvider` throws a `ConfigError` if you pass a `baseUrl` or `apiKey` for a first-class prefix (`google`, `openai`, `anthropic`, `openrouter`). Pass those to the `Agent` instead.

## Tips

- Pin one provider per agent with `ModelProvider.*` when several run in one process.
- When an answer surprises you, check `res.provider`, `res.finishReason` and `res.raw`. See [Errors and telemetry](errors-and-telemetry.md).
