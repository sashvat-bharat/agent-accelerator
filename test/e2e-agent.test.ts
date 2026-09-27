import { describe, it, expect } from "bun:test";
import {
  Agent,
  tool,
  z,
  type ProviderGenerateResult,
  type ProviderRequestOptions,
  type ProviderContext,
} from "../src/index.ts";
import { getProvider } from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/streaming/event-stream.ts";

describe("End-to-End Agent Execution", () => {
  it("should run multi-turn tool calling and return complete response", async () => {
    const googleProvider = getProvider("google") as any;
    const originalGenerate = googleProvider.generate.bind(googleProvider);
    const originalStream = googleProvider.stream.bind(googleProvider);
    let callCount = 0;

    googleProvider.generate = async (
      model: any,
      context: ProviderContext,
      options?: ProviderRequestOptions
    ): Promise<ProviderGenerateResult> => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call_auth_1",
              name: "get_status",
              arguments: { username: "Akshat Dwivedi" },
            },
          ],
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, cachedTokens: 30 },
          finishReason: "tool_calls",
          responseId: "mock_turn_1",
          model: "mock-gemini",
          provider: "google" as any,
          raw: { request: {} as any },
          durationMs: 25,
        };
      }
      return {
        text: "Valid username. Welcome to Home, Sir!",
        usage: { inputTokens: 80, outputTokens: 15, totalTokens: 95, cachedTokens: 40 },
        finishReason: "STOP",
        responseId: "mock_turn_2",
        model: "mock-gemini",
        provider: "google" as any,
        raw: { request: {} as any },
        durationMs: 20,
      };
    };

    googleProvider.stream = (
      model: any,
      context: ProviderContext,
      options?: ProviderRequestOptions
    ): AssistantMessageEventStream => {
      const stream = new AssistantMessageEventStream();
      callCount++;
      setTimeout(() => {
        if (callCount === 1) {
          stream.push({
            type: "tool_call_complete",
            toolCall: {
              id: "call_stream_1",
              name: "get_status",
              arguments: { username: "Akshat Dwivedi" },
            },
          });
          stream.end(
            new (require("../src/types/response.ts").AgentResponse)({
              text: "",
              toolCalls: [
                {
                  id: "call_stream_1",
                  name: "get_status",
                  arguments: { username: "Akshat Dwivedi" },
                },
              ],
              usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedTokens: 0 },
              model: "mock-gemini",
              provider: "google" as any,
              durationMs: 15,
              raw: { request: {} as any },
            })
          );
        } else {
          stream.push({ type: "text_delta", delta: "Valid username. Welcome to Home, Sir!" });
          stream.end(
            new (require("../src/types/response.ts").AgentResponse)({
              text: "Valid username. Welcome to Home, Sir!",
              usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135, cachedTokens: 100 },
              model: "mock-gemini",
              provider: "google" as any,
              durationMs: 15,
              raw: { request: {} as any },
            })
          );
        }
      }, 10);
      return stream;
    };

    try {
      const agent = new Agent({
        model: "google/gemini-3.5-flash-lite",
        apiKey: "mock-key",
        tools: {
          get_status: tool({
            description: "Checks user authentication.",
            input: z.object({
              username: z.string(),
            }),
            execute: async ({ username }) =>
              username === "Akshat Dwivedi"
                ? "Valid username. Welcome to Home, Sir!"
                : "Invalid username",
          }),
        },
      });

      const result = await agent.run("Check status for Akshat Dwivedi");

      expect(result.text).toBe("Valid username. Welcome to Home, Sir!");
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0]!.name).toBe("get_status");
      expect(result.toolResults.length).toBe(1);
      expect(result.toolResults[0]!.result).toBe("Valid username. Welcome to Home, Sir!");
      expect(result.turns).toBe(2);
      expect(result.usage.totalTokens).toBe(165);
      expect(result.usage.cachedTokens).toBe(70);
    } finally {
      googleProvider.generate = originalGenerate;
      googleProvider.stream = originalStream;
    }
  });

  it("should block an identical tool call in the immediately following turn", async () => {
    const googleProvider = getProvider("google") as any;
    const originalGenerate = googleProvider.generate.bind(googleProvider);
    let modelTurns = 0;
    let executions = 0;

    googleProvider.generate = async (): Promise<ProviderGenerateResult> => {
      modelTurns++;
      if (modelTurns <= 2) {
        return {
          text: "",
          toolCalls: [{ id: `repeat_${modelTurns}`, name: "get_status", arguments: { username: "Akshat Dwivedi" } }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          model: "mock-gemini",
          provider: "google" as any,
          raw: { request: {} as any },
          durationMs: 1,
        };
      }
      return {
        text: "Done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: "mock-gemini",
        provider: "google" as any,
        raw: { request: {} as any },
        durationMs: 1,
      };
    };

    try {
      const agent = new Agent({
        model: "google/gemini-3.5-flash-lite",
        apiKey: "mock-key",
        tools: {
          get_status: tool({
            description: "Checks status.",
            execute: async () => {
              executions++;
              return "Valid";
            },
          }),
        },
      });
      const result = await agent.run("Check status");

      expect(executions).toBe(1);
      expect(result.toolResults.length).toBe(2);
      expect(result.toolResults[1]!.isError).toBe(true);
      expect(String(result.toolResults[1]!.result)).toContain("called again immediately");
      expect(result.text).toBe("Done");
    } finally {
      googleProvider.generate = originalGenerate;
    }
  });
});
