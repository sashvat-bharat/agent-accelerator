/**
 * Agent Accelerator - Interactive Chat CLI
 *
 * Persistent multi-turn chat using SDK session helpers:
 * `loadSessionDir` / `saveSessionDir` / `SessionTelemetry` +
 * `agent.importSession` / `agent.exportSession`.
 * Sessions live in `sessions/<sessionId>/{session.json, media/*}`.
 *
 * Run: bun run examples/05-chat.ts
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Agent,
  resolveModel,
  getModelThinkingInfo,
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
// 1. Session storage: sessions/<sessionId>/{session.json, media/*}
// ---------------------------------------------------------------------------
// Explicit single file still works: SESSION_FILE=... or --session-file=...
// (legacy `.session.jsonl` included). Otherwise the CLI stores each session
// in its own folder under SESSION_DIR and resumes the most recent one.
const EXPLICIT_FILE =
  process.env.SESSION_FILE ??
  process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1];
const SESSION_ROOT =
  process.env.SESSION_DIR ??
  process.argv.find((a) => a.startsWith("--session-dir="))?.split("=")[1] ??
  path.join(process.cwd(), "sessions");
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
// 2. Agent setup (restores history + totals in 3 calls)
// ---------------------------------------------------------------------------
const initialModel = saved?.model ?? process.env.MODEL ?? "google/gemini-3.5-flash-lite";
const initialThinking = (saved?.thinkingLevel as any) ?? (process.env.THINKING_LEVEL as any) ?? "medium";

const agent = new Agent({
  name: "Chat Agent",
  instructions: loadPrompt(),
  model: initialModel,
  dynamicSubagents: {
    enabled: true,
    model: saved?.subagentModel ?? process.env.SUB_AGENT_MODEL,
    maxSpawn: 4,
    timeout: 60000,
  },
  thinkingLevel: initialThinking as any,
  cache: (saved?.cache as any) ?? { retention: "implicit" as const },
  sessionId: saved?.sessionId,
  maxTurns: 10,
});

// Restores messages, system prompt, model/thinking/session when present.
if (saved) agent.importSession(saved);

// ---------------------------------------------------------------------------
// 3. Interactive CLI loop
// ---------------------------------------------------------------------------
const activeThinking = (agent as any).thinkingConfig?.level ?? initialThinking;
console.log(`\n\x1b[1;36mAgent Accelerator — Interactive CLI\x1b[0m`);
console.log(formatSessionBanner(saved, telemetry, sessionLocation));
console.log(`Model: \x1b[32m"${agent.modelStringOrSpec}"\x1b[0m • Thinking: \x1b[33m${activeThinking}\x1b[0m • Context: \x1b[34m${formatSessionTokens(getSessionContextWindow(agent.modelStringOrSpec as string))}\x1b[0m`);
console.log(`Session: \x1b[90m${agent.sessionId.slice(0, 16)}… (${sessionLocation})\x1b[0m`);
console.log(`Commands: \x1b[90m/model "provider/model-id"  /level <lvl>  /help  /exit\x1b[0m\n`);

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
      const currentLevel = (agent as any).thinkingConfig?.level;
      if (currentLevel && currentLevel !== "none") {
        validateModelThinking(resolved.provider.id, resolved.modelId, currentLevel);
      }
    } catch (e: any) {
      console.log(`\x1b[33m⚠ Thinking level notice:\x1b[0m \x1b[90m${e.message}\x1b[0m`);
    }

    (agent as any).modelStringOrSpec = nextModel;
    persistSession();
    console.log(`\x1b[32m✔ Switched model to: "${nextModel}"\x1b[0m`);
    continue;
  }

  if (q.startsWith("/level") || q.startsWith("/thinking")) {
    const nextLevel = q.split(" ")[1]?.trim() as any;
    const resolvedCurrent = resolveModel(agent.modelStringOrSpec as string);
    if (nextLevel) {
      try {
        validateModelThinking(resolvedCurrent.provider.id, resolvedCurrent.modelId, nextLevel);
        (agent as any).thinkingConfig = {
          enabled: nextLevel !== "none",
          level: nextLevel,
          budgetTokens: nextLevel === "dynamic" ? -1 : nextLevel === "none" ? 0 : undefined,
        };
        persistSession();
        console.log(`\x1b[32m✔ Switched thinking level to: ${nextLevel}\x1b[0m`);
      } catch (err: any) {
        console.log(`\x1b[31m✖ ${err.message}\x1b[0m`);
      }
    } else {
      const info = getModelThinkingInfo(resolvedCurrent.provider.id, resolvedCurrent.modelId);
      console.log(`Current thinking level: ${(agent as any).thinkingConfig?.level ?? "none"}`);
      console.log(`\x1b[90m${info.description}\x1b[0m`);
    }
    continue;
  }

  if (q === "/help") {
    console.log(`\x1b[33mAvailable Commands:\x1b[0m`);
    console.log(`  /model "provider/model-id"  Switch active model in quotes (e.g. /model "google/gemini-3.5-flash-lite")`);
    console.log(`  /level <lvl>               Set thinking level (none, minimal, low, medium, high, xhigh, dynamic)`);
    console.log(`  /exit, /quit               Exit chat session\n`);
    continue;
  }

  try {
    const res = await agent.run(q, {
      stream: true,
      wrapThinking: true,
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

    const level = (agent as any).thinkingConfig?.level ?? "none";
    console.log(`\n${telemetry.formatBar(res, { model: agent.modelStringOrSpec as string, thinkingLevel: level })}`);
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
