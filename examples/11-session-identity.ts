/**
 * Agent Accelerator - Session Identity and Lineage (real run)
 *
 * Real scenario for the reported issue: once a few agents run at once,
 * identity gets harder than orchestration. Every worker gets a
 * system-generated 32-char TrackingID, displayed as
 * SUBAGENT-NAME-{TrackingID}, and every step it takes is logged into the
 * same session file — so agent.track(TrackingID) replays that worker live.
 *
 * What this runs for real:
 *  1. One main Agent with dynamic sub-agents spawns 2 workers concurrently.
 *  2. Lineage helpers run against the REAL parent session id and the REAL
 *     worker TrackingIDs returned in `res.subagents`.
 *  3. The REAL session is persisted with saveSessionDir, reloaded with
 *     loadSessionDir, and resumed with sub-agent traces intact.
 *
 * Run: bun examples/11-session-identity.ts
 * Needs: MODEL, SUB_AGENT_MODEL + provider keys (see .env.example).
 */

import {
  Agent,
  SessionTelemetry,
  saveSessionDir,
  loadSessionDir,
  isSessionDescendant,
  formatSessionCost,
} from "agent-accelerator";
import { fail } from "./_shared.ts";

const MODEL = process.env.MODEL;
const SUB_AGENT_MODEL = process.env.SUB_AGENT_MODEL;
if (!MODEL) fail(new Error("Missing MODEL env (see .env.example)."));
if (!SUB_AGENT_MODEL) fail(new Error("Missing SUB_AGENT_MODEL env (see .env.example)."));

// Colors: white is reserved for model answer text only. Thinking is grey,
// everything else uses vibrant colors so streams are easy to tell apart.
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const GREY = "\x1b[90m";
const BLUE = "\x1b[34m";

// ---------------------------------------------------------------------------
// Worker boxes: bordered regions, one per sub-agent, rendered whole from
// the finished trace (final-output mode — no live streaming here).
// ---------------------------------------------------------------------------
const BOX_WIDTH = 64;
const BOX_COLORS = [CYAN, GREEN, YELLOW, MAGENTA, BLUE];
let boxColorIdx = 0;
function nextBoxColor(): string {
  const c = BOX_COLORS[boxColorIdx % BOX_COLORS.length]!;
  boxColorIdx++;
  return c;
}
interface WorkerBox {
  label: string;
  color: string;
}
function shortLabel(trackingId: string): string {
  const name = trackingId.split("-").slice(0, -1).join("-") || trackingId;
  return name.slice(0, 28);
}
/** Strips control chars that break terminal layout (`\r` repaints over the box border). */
function sanitizeBoxText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function printBoxHeader(box: WorkerBox): void {
  const title = ` ${box.label} `;
  const fill = Math.max(0, BOX_WIDTH - title.length - 1);
  process.stdout.write(box.color + "┌" + title + "─".repeat(fill) + RESET + "\n");
}
function flushBoxLines(box: WorkerBox, text: string, grey: boolean): void {
  for (const rawLine of sanitizeBoxText(text).split("\n")) {
    // Wrap (never cut): every visual row keeps its border.
    let line = rawLine;
    if (!line) {
      process.stdout.write(box.color + "│ " + RESET + "\n");
      continue;
    }
    while (line.length > 0) {
      const body = line.slice(0, BOX_WIDTH - 2);
      line = line.slice(BOX_WIDTH - 2);
      process.stdout.write(box.color + "│ " + RESET + (grey ? GREY + body + RESET : box.color + body + RESET) + "\n");
    }
  }
}
function printBoxFooter(box: WorkerBox, note: string): void {
  const tail = ` done ${note} `;
  const fill = Math.max(2, Math.min(16, BOX_WIDTH - tail.length - 1));
  process.stdout.write(box.color + "└" + tail + "─".repeat(fill) + RESET + "\n");
}

// ---------------------------------------------------------------------------
// 1. Real main agent with 2 concurrent dynamic workers
// ---------------------------------------------------------------------------
const agent = new Agent({
  name: "Identity Lead",
  instructions: "You coordinate parallel research. Always delegate via spawn_subagents, then synthesize. Name workers with UPPER-KEBAB tags (e.g. RESEARCH-ANALYST).",
  model: MODEL,
  dynamicSubagents: {
    enabled: true,
    model: SUB_AGENT_MODEL,
    maxSpawn: 2,
    thinkingLevel: "medium",
    workerTimeoutMs: 60000,
  },
  thinking: "medium",
  // Durable persistence: the session file is rewritten after every step,
  // so a crash loses at most the in-flight step.
  persist: { dir: "sessions" },
  captureRaw: "redacted",
});

console.log(CYAN + "parent session: " + agent.sessionId + RESET);
console.log(GREY + "(working — output prints when the final response lands)" + RESET + "\n");

const res = await agent
  .run(
    "Spawn 2 sub-agents in ONE spawn_subagents call: one researches battery pricing in one sentence, the other researches AI power demand in one sentence. Then merge both into a 3-line report."
  )
  .catch(fail);

if (res.thinking) {
  console.log(GREY + "<think>" + RESET);
  for (const line of res.thinking.split("\n")) console.log(GREY + line + RESET);
  console.log(GREY + "</think>" + RESET + "\n");
}
process.stdout.write(res.text + "\n");

// Worker boxes, rendered whole from finished traces (no live streaming here;
// realtime consumers use `subagent_delta` events or track() subscriptions).
for (const s of res.subagents) {
  const id = (s as any).trackingId as string | undefined;
  const trace = id ? agent.track(id) : undefined;
  const box: WorkerBox = { label: shortLabel(id ?? s.name), color: nextBoxColor() };
  printBoxHeader(box);
  const thinking = trace?.steps.map((st) => st.thinking).find((t) => t) ?? (trace as any)?.thinking ?? s.thinking;
  if (thinking) {
    for (const line of String(thinking).split("\n")) flushBoxLines(box, "~ " + line, true);
  }
  const answer = trace?.text ?? s.text;
  if (answer) flushBoxLines(box, answer, false);
  printBoxFooter(box, `${s.usage.totalTokens}tok`);
}

console.log(MAGENTA + "\n\n--- workers (session id + TrackingID) ---" + RESET);
for (const s of res.subagents) {
  const ok = !s.isError ? GREEN + "ok" + RESET : YELLOW + "ERROR" + RESET;
  console.log(
    MAGENTA + "- " + s.name + RESET + " " + ok + " model=" + CYAN + s.model + RESET + " turns=" + s.turns +
    " tokens=" + s.usage.totalTokens + " cost=" + GREEN + formatSessionCost(s.usage?.cost?.totalCost ?? 0) + RESET
  );
  console.log("  session: " + (s.sessionId ?? "(none)") + " TrackingID: " + ((s as any).trackingId ?? "(none)"));
}

// ---------------------------------------------------------------------------
// 2. Lineage binding against the REAL ids
// ---------------------------------------------------------------------------
console.log(CYAN + "\n--- lineage (real worker sessions) ---" + RESET);
for (const s of res.subagents) {
  const realChild = s.sessionId ?? "(none)";
  const descendant = realChild !== "(none)" && isSessionDescendant(realChild, agent.sessionId);
  console.log(CYAN + "- " + s.name + RESET);
  console.log("  session:    " + realChild + " (" + realChild.length + " chars)");
  console.log("  TrackingID: " + ((s as any).trackingId ?? "(none)"));
  console.log("  descendant of this parent: " + (descendant ? GREEN + "true" + RESET : YELLOW + "false" + RESET));
}
console.log(MAGENTA + "parent session total usage: " + res.usage.totalTokens + " tokens, cost " + formatSessionCost(res.usage?.cost?.totalCost ?? 0) + RESET);

// ---------------------------------------------------------------------------
// 2b. Realtime tracking: agent.track(TrackingID) replays everything one worker did
// ---------------------------------------------------------------------------
console.log(CYAN + "\n--- track() (per-worker traces) ---" + RESET);
console.log("tracked workers: " + agent.listTrackedSubAgents().join(", "));
for (const s of res.subagents) {
  const id = (s as any).trackingId as string | undefined;
  if (!id) continue;
  const trace = agent.track(id);
  console.log(GREEN + "- " + id + RESET + " status=" + trace?.status + " steps=" + (trace?.steps.length ?? 0));
  for (const step of trace?.steps.slice(0, 6) ?? []) {
    console.log("    turn " + step.turn + " " + step.type + (step.name ? " " + step.name : ""));
  }
}

// ---------------------------------------------------------------------------
// 3. Real persistence: save, reload, resume with sub-agent traces intact
// ---------------------------------------------------------------------------
const telemetry = new SessionTelemetry();
telemetry.add(res.usage, MODEL!);
const dir = saveSessionDir("sessions", agent, telemetry);
console.log(GREEN + "\nsaved: " + dir + RESET);

const loaded = loadSessionDir(dir);
if (!loaded) fail(new Error("Could not reload session dir " + dir));
console.log(CYAN + "reloaded session: " + loaded!.session.sessionId + RESET);
console.log(CYAN + "sub-agent traces: " + Object.keys(loaded!.session.subagents ?? {}).join(", ") + RESET);

const resumer = new Agent({ name: "Resumer", model: MODEL! });
resumer.importSession(loaded!.session);
console.log(GREEN + "resumed messages: " + resumer.context.messages.length + RESET);
console.log(GREEN + "resumed worker traces: " + resumer.listTrackedSubAgents().join(", ") + RESET);

console.log(GREEN + "\nDone - real workers, real lineage, realtime track()." + RESET);
