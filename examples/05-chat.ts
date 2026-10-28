/**
 * Agent Accelerator - Interactive Chat CLI
 *
 * Persistent multi-turn chat using SDK session helpers:
 * `loadSessionDir` / `saveSessionDir` / `SessionTelemetry` +
 * `agent.importSession` / `agent.exportSession`.
 * Everything lives under the Agent Accelerator home (`.agent-accel/`):
 * `sessions/<sessionId>/{session.json, media/*}` and, with `telemetry.persist`,
 * `telemetry/<date>.ndjson` (tool calls, warnings). Move it with `setHome(dir)` or AGENT_ACCEL_HOME.
 *
 * Run: bun run examples/05-chat.ts
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Agent,
  resolveHome,
  resolveModel,
  validateModelThinking,
  loadSessionFile,
  saveSessionFile,
  loadSessionDir,
  saveSessionDir,
  findLatestSessionDir,
  SessionTelemetry,
  getSessionContextWindow,
  formatSessionTokens,
  formatSessionCost,
  formatSessionBanner,
} from "agent-accelerator";

// ---------------------------------------------------------------------------
// 1. Storage: <home>/sessions/<sessionId>/{session.json, media/*}
// ---------------------------------------------------------------------------
const EXPLICIT_FILE =
  process.env.SESSION_FILE ??
  process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1];
const SESSION_ROOT =
  process.env.SESSION_DIR ??
  process.argv.find((a) => a.startsWith("--session-dir="))?.split("=")[1] ??
  path.join(resolveHome(), "sessions");
const RESUMED_DIR = !EXPLICIT_FILE ? findLatestSessionDir(SESSION_ROOT) : null;
const RESUMED = RESUMED_DIR ? loadSessionDir(RESUMED_DIR) : null;
const saved = EXPLICIT_FILE ? loadSessionFile(EXPLICIT_FILE) : (RESUMED?.session ?? null);
const telemetry = SessionTelemetry.fromSaved(saved);
let sessionLocation = EXPLICIT_FILE ?? RESUMED_DIR ?? SESSION_ROOT;

function persistSession() {
  if (EXPLICIT_FILE) {
    saveSessionFile(EXPLICIT_FILE, agent, telemetry);
    sessionLocation = EXPLICIT_FILE;
  } else {
    sessionLocation = saveSessionDir(SESSION_ROOT, agent, telemetry);
  }
}

function loadPrompt(): string {
  const candidates = [
    path.join(process.cwd(), "examples/prompts/SYSTEM_PROMPT_AGENT.md"),
    path.join(import.meta.dir, "prompts/SYSTEM_PROMPT_AGENT.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  return "You are a concise, helpful engineering assistant.";
}

// ---------------------------------------------------------------------------
// 2. Agent setup (strictly hardcoded to "high" thinking)
// ---------------------------------------------------------------------------
const THINKING_LEVEL = "high" as const;
const initialModel = saved?.model ?? process.env.MODEL ?? "google/gemini-3.5-flash-lite";

const agent = new Agent({
  name: "Chat Agent",
  telemetry: { persist: true }, // opt in: tool calls and warnings go to <home>/telemetry/<date>.ndjson
  instructions: loadPrompt(),
  model: initialModel,
  dynamicSubagents: {
    enabled: true,
    model: saved?.subagentModel ?? process.env.SUB_AGENT_MODEL,
    maxSpawn: 4,
    workerTimeoutMs: 60000,
  },
  thinking: THINKING_LEVEL,
  cache: (saved?.cache as any) ?? { retention: "implicit" as const },
  sessionId: saved?.sessionId,
  maxTurns: 10,
  captureRaw: "redacted",
  persist: undefined,
});

if (saved) {
  agent.importSession(saved);
}

// Force "high" across all internal properties after session import
(agent as any).thinking = THINKING_LEVEL;
(agent as any).thinkingLevel = THINKING_LEVEL;
(agent as any).thinkingConfig = {
  enabled: true,
  level: THINKING_LEVEL,
  budgetTokens: undefined,
};

// ---------------------------------------------------------------------------
// 3. Interactive CLI loop
// ---------------------------------------------------------------------------
console.log(`\n\x1b[1;36mAgent Accelerator — Interactive CLI\x1b[0m`);
console.log(formatSessionBanner(saved, telemetry, sessionLocation));
console.log(`Model: \x1b[32m"${agent.modelStringOrSpec}"\x1b[0m • Thinking: \x1b[33m${THINKING_LEVEL}\x1b[0m • Context: \x1b[34m${formatSessionTokens(getSessionContextWindow(agent.modelStringOrSpec as string))}\x1b[0m`);
console.log(`Session: \x1b[90m${agent.sessionId.slice(0, 16)}… (${sessionLocation})\x1b[0m`);
console.log(`Commands: \x1b[90m/model "provider/model-id"  /help  /exit\x1b[0m\n`);

const rl = readline.createInterface({ input: stdin, output: stdout });

while (true) {
  let rawQ: string;
  try {
    rawQ = await rl.question("\x1b[36mYou>\x1b[0m ");
  } catch {
    break;
  }
  if (rawQ === undefined || rawQ === null) break;
  const q = rawQ.trim();
  if (!q) continue;
  if (["/exit", "/quit", "/q"].includes(q)) break;

  if (q.startsWith("/model")) {
    const rawArg = q.slice(6).trim();
    if (!rawArg) {
      console.log(`Current model: "${agent.modelStringOrSpec}"`);
      console.log(`\x1b[90mUsage: /model "provider/model-id"\x1b[0m`);
      continue;
    }

    const match = rawArg.match(/^"([^"]+)"$/);
    if (!match) {
      console.log(`\x1b[31m✖ Invalid format. You must specify the model in quotes: /model "provider/model-id"\x1b[0m`);
      console.log(`\x1b[90mExample: /model "openrouter/z-ai/glm-5.3-flash" or /model "google/gemini-3.5-flash-lite"\x1b[0m`);
      continue;
    }

    const nextModel = match[1]!.trim();
    if (!nextModel.includes("/")) {
      console.log(`\x1b[31m✖ Invalid model format "${nextModel}". Must be "provider/model-id" (e.g. /model "openrouter/z-ai/glm-5.3-flash").\x1b[0m`);
      continue;
    }

    try {
      const resolved = resolveModel(nextModel);
      validateModelThinking(resolved.provider.id, resolved.modelId, THINKING_LEVEL);
    } catch (e: any) {
      console.log(`\x1b[33m⚠ Thinking level notice:\x1b[0m \x1b[90m${e.message}\x1b[0m`);
    }

    (agent as any).modelStringOrSpec = nextModel;
    persistSession();
    console.log(`\x1b[32m✔ Switched model to: "${nextModel}"\x1b[0m`);
    continue;
  }

  if (q === "/help") {
    console.log(`\x1b[33mAvailable Commands:\x1b[0m`);
    console.log(`  /model "provider/model-id"  Switch active model in quotes (e.g. /model "google/gemini-3.5-flash-lite")`);
    console.log(`  /exit, /quit                Exit chat session\n`);
    continue;
  }

  try {
    const res = await agent.run(q, {
      stream: true,
      wrapThinking: true,
      thinking: THINKING_LEVEL,
      onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
      onDelta: (d) => process.stdout.write(d),
      onEvent: (e) => {
        if (e.type === "subagent_complete") {
          const sCost = e.subagent!.usage?.cost?.totalCost ?? 0;
          const sCostLabel = sCost > 0 ? ` • ${formatSessionCost(sCost)}` : "";
          console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${formatSessionTokens(e.subagent!.usage.totalTokens)} tok${sCostLabel})\x1b[0m`);
        }
      },
    });

    telemetry.add(res.usage, agent.modelStringOrSpec as string);
    persistSession();

    console.log(`\n${telemetry.formatBar(res, { model: agent.modelStringOrSpec as string, thinkingLevel: THINKING_LEVEL })}`);
    if (res.subagents?.length) {
      console.log(
        `\x1b[90m  ↳ subagents: ${res.subagents
          .map((s: any) => `${s.name}:${s.isError ? "ERR" : "ok"} (${formatSessionCost(s.usage?.cost?.totalCost ?? 0)})`)
          .join(", ")}\x1b[0m`
      );
    }
    console.log("");
  } catch (e: any) {
    console.log(`\n\x1b[31m✖ ${e.message}\x1b[0m\n`);
  }
}

rl.close();
persistSession();