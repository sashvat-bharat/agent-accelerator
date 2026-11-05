/**
 * Persistent sub-agent workers. A worker is a plain `Agent` with its own instructions, tools and session: it keeps its
 * conversation, can be messaged again until it is closed, and is saved under `<parent session>/workers/<id>/` (its own
 * journal, tool logs and resume, plus `worker.json` with what the registry needs to rebuild it after a restart).
 * `agent.workers` is the programmatic API; the `subagents` tool is a thin wrapper over the same functions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent } from "./agent.ts";
import type { AgentResponse, SubAgentExecutionMetadata } from "../types/response.ts";
import type { Message } from "../types/message.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { sessionDirFor, loadSessionDir } from "../session/store.ts";
import { telemetryBus } from "../telemetry.ts";
import { hashSessionPart, newRunId, newTurnId, nowMs } from "../utils/session.ts";
import { buildDynamicWorkerConfig, grantWorkerTools, sanitizeToolName } from "./worker.ts";
import { createFixedChildSessionId, openWorkerTrace, reserveSpawn, workerMetadata, type WorkerRunResult } from "./delegation.ts";
import { finishedTurns, historyUpTo, type Turn } from "./turns.ts";
import { modelName, readUsage, type UsageNode } from "../session/usage.ts";

/** What `spawn` needs to start a worker. */
export interface WorkerSpec {
  /** Short label; the worker's id is this name plus a short suffix. */
  name: string;
  role?: string;
  /** The worker's own system prompt (the parent's is never copied). */
  instructions?: string;
  /** The first assignment. */
  task: string;
  /** Names from the developer's `dynamicSubagents.tools` pool to grant this worker. Unknown names throw. */
  tools?: string[];
  /** `"none"` (default) or a number N: start from a copy of the parent's first N finished turns (see `workers.turns()`). */
  history?: "none" | number;
}

/** One worker as `list()` shows it. */
export interface WorkerInfo {
  id: string;
  name: string;
  role?: string;
  tools: string[];
  /** A call is running on it right now. */
  busy: boolean;
}

/** The answer to one `spawn` or `message`. A failed call carries `error` and a text that says so; it never throws. */
export interface WorkerReply {
  id: string;
  text: string;
  error?: string;
  metadata: SubAgentExecutionMetadata;
}

/** Options of one `spawn`/`message` call. */
export interface WorkerCallOptions {
  /** Aborts the worker's run. */
  signal?: AbortSignal;
  /** The calling tool call's id: makes the call exactly-once across a crash and replay (the `subagents` tool passes it). */
  callId?: string;
  /** Receives the worker's live text and thinking deltas. */
  onSubagentEvent?: (event: { trackingId: string; delta?: string; thinkingDelta?: string; partialText?: string; partialThinking?: string }) => void;
}

// Saved in `worker.json`: everything needed to rebuild a worker after a restart.
interface WorkerMeta {
  id: string;
  name: string;
  role?: string;
  instructions: string;
  tools: string[];
  sessionId: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  /** The last call delivered: its key, a hash of its text, and how many runs the worker had then. Detects a replayed call. */
  last?: { key: string; text: string; marks: number };
}

interface Entry {
  meta: WorkerMeta;
  /** The worker's session folder (unset when the parent does not persist). */
  dir?: string;
  agent?: Agent;
  /** Its spending, kept when it is closed (so a worker that was never saved to disk still shows in the report). */
  kept?: { model: string; totals: ReturnType<typeof readUsage>; workers: UsageNode[] };
  busy: boolean;
}

const META_FILE = "worker.json";

// Fails with a one-line message when a required text field is missing; in: spawn/message input, out: the caller's ValidationError.
function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field}: required, a non-empty string.`);
  return value.trim();
}

// Joins the text parts of the last assistant message (the reply a worker already gave); in: a worker's history, out: a replayed call's saved answer.
function lastAssistantText(messages: Message[]): string | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

// Reads a worker that is not in memory from its folder: its saved spending, model, and the workers saved inside it; in: a worker's session folder, out: usageNodes.
function readSavedWorker(dir: string | undefined): { model: string; totals: ReturnType<typeof readUsage>; workers: UsageNode[] } {
  if (!dir) return { model: "unknown", totals: readUsage(undefined), workers: [] };
  let session: ReturnType<typeof loadSessionDir>;
  try {
    session = loadSessionDir(dir);
  } catch {
    session = null; // a session over the load limits: its spending is unknown here
  }
  const workers: UsageNode[] = [];
  const root = path.join(dir, "workers");
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // no workers saved inside this one
  }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, d.name, META_FILE), "utf8")) as WorkerMeta;
      const inner = readSavedWorker(path.join(root, d.name));
      workers.push({ id: meta.id, name: meta.name, ...(meta.role ? { role: meta.role } : {}), model: inner.model, status: meta.status, totals: inner.totals, workers: inner.workers });
    } catch {
      // a damaged worker.json is skipped, as in load()
    }
  }
  return { model: session?.session.model || "unknown", totals: readUsage(session?.session.usage), workers };
}

/** The workers of one parent `Agent` (`agent.workers`). */
export class WorkerRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly parent: Agent) {
    this.load();
  }

  // Where this parent's workers live on disk, or undefined when it does not persist to a folder; in: the parent's persist config, out: load, create.
  private root(): string | undefined {
    const dir = this.parent.persistConfig?.dir;
    if (!dir || this.parent.stateless) return undefined;
    try {
      return path.join(sessionDirFor(dir, this.parent.sessionId), "workers");
    } catch {
      return undefined; // not a usable session id for a folder name
    }
  }

  // Reads every saved `worker.json` under the parent's session folder; a damaged one is reported on the bus and skipped; in: the constructor, out: this.entries.
  private load(): void {
    const root = this.root();
    if (!root) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // nothing saved yet
    }
    for (const d of names) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8")) as WorkerMeta;
        if (typeof meta.id !== "string" || typeof meta.sessionId !== "string" || !Array.isArray(meta.tools)) throw new Error("missing fields");
        this.entries.set(meta.id, { meta, dir, busy: false });
      } catch (err) {
        telemetryBus.emitWarning("worker.invalid", `[Agent Accelerator] ${path.join(dir, META_FILE)} is not a valid worker and is skipped: ${err instanceof Error ? err.message : String(err)}`, { dir });
      }
    }
  }

  // Saves a worker's `worker.json` durably (a no-op when the parent does not persist); in: spawn, deliver, close, out: the worker folder.
  private save(entry: Entry): void {
    if (entry.dir) writeFileDurable(path.join(entry.dir, META_FILE), JSON.stringify(entry.meta, null, 2) + "\n");
  }

  // True when this call is the one that last reached the worker (same call key and text): a replay after a crash; in: spawn and deliver, out: exactly-once handling.
  private isReplay(entry: Entry, key: string | undefined, text: string): boolean {
    return !!key && entry.meta.last?.key === key && entry.meta.last.text === hashSessionPart(text);
  }

  // The key that identifies one tool call across a restart: the parent run plus the call id; in: WorkerCallOptions.callId, out: replay detection.
  private callKey(callId: string | undefined): string | undefined {
    return callId ? `${this.parent.runMarks[this.parent.runMarks.length - 1]?.id ?? ""}:${callId}` : undefined;
  }

  /**
   * Starts a worker on `spec.task` and waits for its first reply. With `opts.callId` a replay of the same call (after a
   * crash) finds the worker it already started instead of creating a second one.
   */
  async spawn(spec: WorkerSpec, opts: WorkerCallOptions = {}): Promise<WorkerReply> {
    const name = requireText("name", spec?.name);
    const task = requireText("task", spec?.task);
    const key = this.callKey(opts.callId);
    const slug = sanitizeToolName(name).slice(0, 24).replace(/-+$/, "") || "worker";
    let id = "";
    let entry: Entry | undefined;
    for (let n = 0; ; n++) {
      id = `${slug}-${hashSessionPart(n === 0 ? (key ?? globalThis.crypto.randomUUID()) : `${key ?? globalThis.crypto.randomUUID()}#${n}`)}`;
      entry = this.entries.get(id);
      if (!entry || this.isReplay(entry, key, task)) break;
    }
    entry ??= await this.create(id, name, task, key, spec);
    return this.deliver(entry, task, key, opts);
  }

  /** Sends `text` to an open worker and waits for its reply; the worker remembers the conversation. */
  async message(id: string, text: string, opts: WorkerCallOptions = {}): Promise<WorkerReply> {
    const entry = this.open(id);
    return this.deliver(entry, requireText("text", text), this.callKey(opts.callId), opts);
  }

  /** Closes a worker: it can no longer be messaged, its session stays on disk (and in `usageReport`). */
  close(id: string): WorkerInfo {
    const entry = this.open(id);
    if (entry.busy) throw new ValidationError(`Worker "${id}" is busy with a call; wait for it to finish before closing it.`);
    entry.meta.status = "closed";
    entry.meta.closedAt = Date.now();
    this.save(entry);
    if (entry.agent) entry.kept = { model: modelName(entry.agent.modelStringOrSpec), totals: readUsage(entry.agent.usageTotals), workers: entry.agent.workers.usageNodes() };
    entry.agent?.disposeSession(entry.meta.sessionId); // frees its provider chain; never reset(): that could rewrite the saved history
    entry.agent = undefined;
    return this.info(entry);
  }

  /** The open workers. */
  list(): WorkerInfo[] {
    return [...this.entries.values()].filter((e) => e.meta.status === "open").map((e) => this.info(e));
  }

  /** The parent's finished turns, the numbers `spawn` accepts for `history`. */
  turns(): Turn[] {
    return finishedTurns(this.parent.context.messages, this.parent.runMarks);
  }

  /** Every worker (open and closed) as a usage tree: live ones from memory, the rest from their saved sessions, nested workers included. */
  usageNodes(): UsageNode[] {
    return [...this.entries.values()].map((entry) => {
      const { id, name, role, status } = entry.meta;
      const base = { id, name, ...(role ? { role } : {}), status };
      if (entry.agent) return { ...base, model: modelName(entry.agent.modelStringOrSpec), totals: entry.agent.usageTotals, workers: entry.agent.workers.usageNodes() };
      return { ...base, ...(entry.kept ?? readSavedWorker(entry.dir)) };
    });
  }

  // The open worker with this id, or a ValidationError that says what to do; in: message and close, out: the entry.
  private open(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ValidationError(`No worker with id "${id}". Use list to see the open workers.`);
    if (entry.meta.status === "closed") throw new ValidationError(`Worker "${id}" is closed. Spawn a new worker instead.`);
    return entry;
  }

  // The public view of one worker; in: an entry, out: list and close.
  private info(entry: Entry): WorkerInfo {
    const { id, name, role, tools } = entry.meta;
    return { id, name, ...(role ? { role } : {}), tools: [...tools], busy: entry.busy };
  }

  // Checks a new worker's request, builds its Agent (seeded with the copied history) and saves `worker.json`; in: spawn, out: a new open entry.
  private async create(id: string, name: string, task: string, key: string | undefined, spec: WorkerSpec): Promise<Entry> {
    const parent = this.parent;
    if (!parent.subagentModel) {
      throw new ConfigError(
        "[Agent Accelerator] Cannot spawn workers: no sub-agent model is configured. Set dynamicSubagents.model in Agent config or set the SUB_AGENT_MODEL environment variable."
      );
    }
    const maxOpen = parent.dynamicSubagents?.maxSpawn ?? Infinity;
    if (this.list().length >= maxOpen) {
      throw new ValidationError(`Too many open workers (${maxOpen} is the limit). Close one first; open workers: ${this.list().map((w) => w.id).join(", ")}.`);
    }
    const pool = parent.dynamicSubagents?.tools ?? {};
    const requested = spec.tools ?? [];
    const unknown = requested.filter((n) => Object.keys(grantWorkerTools(pool, [n])).length === 0);
    if (unknown.length > 0) {
      const names = Object.keys(pool);
      throw new ValidationError(
        `tools: unknown worker tool(s) ${unknown.map((n) => `"${n}"`).join(", ")}; ` + (names.length > 0 ? `the pool is [${names.join(", ")}].` : "no worker tools are available, omit tools.")
      );
    }
    const history = spec.history ?? "none";
    const messages = history === "none" ? [] : historyUpTo(parent.context.messages, parent.runMarks, history);
    reserveSpawn(parent, 1);

    const sessionId = createFixedChildSessionId(parent.sessionId, id);
    const root = this.root();
    const meta: WorkerMeta = {
      id,
      name,
      ...(spec.role?.trim() ? { role: spec.role.trim() } : {}),
      instructions: spec.instructions?.trim() ?? "",
      tools: Object.keys(grantWorkerTools(pool, requested)),
      sessionId,
      status: "open",
      createdAt: Date.now(),
      ...(key ? { last: { key, text: hashSessionPart(task), marks: 0 } } : {}),
    };
    const entry: Entry = { meta, ...(root ? { dir: path.join(root, sessionId) } : {}), busy: false };
    // Registered before the first await: parallel spawns of one model turn must see each other for the open-worker limit.
    this.entries.set(id, entry);
    try {
      entry.agent = await this.build(entry);
      if (messages.length > 0) entry.agent.context.messages = messages;
      this.save(entry);
    } catch (err) {
      this.entries.delete(id);
      throw err;
    }
    return entry;
  }

  // Builds a worker's Agent from its saved meta; a worker reloaded after a restart gets its saved history back; in: create and deliver, out: the worker Agent.
  private async build(entry: Entry): Promise<Agent> {
    const { Agent: AgentClass } = await import("./agent.ts");
    const { meta } = entry;
    const root = this.root();
    const agent = new AgentClass(
      buildDynamicWorkerConfig(this.parent, {
        name: meta.name,
        role: meta.role,
        instructions: meta.instructions,
        sessionId: meta.sessionId,
        tools: grantWorkerTools(this.parent.dynamicSubagents?.tools ?? {}, meta.tools),
        persistent: { dir: root },
      })
    );
    (agent as unknown as { parentSessionId?: string }).parentSessionId = this.parent.sessionId;
    // A cut-off run was already loaded by the constructor; otherwise bring back what the worker said so far.
    const saved = entry.dir && agent.context.messages.length === 0 ? loadSessionDir(entry.dir)?.session : undefined;
    if (saved) agent.importSession(saved);
    return agent;
  }

  // Sends one text to a worker and turns what happens into a reply: runs it, or after a crash continues the cut-off run or returns the answer it had already given; in: spawn and message, out: a WorkerReply.
  private async deliver(entry: Entry, text: string, key: string | undefined, opts: WorkerCallOptions): Promise<WorkerReply> {
    if (entry.busy) throw new ValidationError(`Worker "${entry.meta.id}" is busy with another call; wait for it, or message another worker.`);
    entry.busy = true;
    const { meta } = entry;
    const startTime = nowMs();
    try {
      const agent = (entry.agent ??= await this.build(entry));
      const live = openWorkerTrace({
        name: meta.name,
        sessionId: meta.sessionId,
        parentSessionId: this.parent.sessionId,
        task: text,
        role: meta.role,
        parent: this.parent,
        emit: opts.onSubagentEvent,
      });
      const lineage = { name: meta.name, displayId: live.displayId, sessionId: meta.sessionId, parentSessionId: this.parent.sessionId, role: meta.role, task: text, runId: newRunId(), turnId: newTurnId() };
      const replayed = this.isReplay(entry, key, text) && agent.runMarks.length > meta.last!.marks;
      if (!replayed) {
        if (key) meta.last = { key, text: hashSessionPart(text), marks: agent.runMarks.length };
        else delete meta.last;
        this.save(entry);
      }
      const onAbort = (): void => agent.interrupt(opts.signal?.reason instanceof Error ? opts.signal.reason : undefined);
      try {
        if (opts.signal?.aborted) throw new Error("aborted before the worker started");
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        let result: WorkerRunResult | undefined;
        if (replayed && agent.interrupted().length === 0) {
          // The crash came after the worker answered: that answer is the reply, nothing runs again.
          const saved = lastAssistantText(agent.context.messages);
          if (saved !== undefined) result = { text: saved };
        }
        if (!result) {
          let response: AgentResponse | undefined;
          if (replayed) {
            response = await agent.resume();
          } else {
            const stream = agent.stream(text, { onTurn: live.onWorkerTurn });
            const detach = live.attachToStream(stream as unknown as Parameters<typeof live.attachToStream>[0]);
            try {
              response = await stream.result();
            } finally {
              detach();
            }
          }
          if (!response) throw new Error("the worker had nothing to resume");
          result = response;
        }
        const reply = result.text.trim() ? result.text : `(the worker produced no text${result.finishReason ? `; finish reason: ${result.finishReason}` : ""})`;
        live.finish(result);
        return { id: meta.id, text: reply, metadata: workerMetadata({ ...lineage, durationMs: Math.max(0, nowMs() - startTime), result, steps: live.steps() }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        live.fail(message);
        const errorText = `Error in worker ${meta.id}: ${message}`;
        return { id: meta.id, text: errorText, error: message, metadata: workerMetadata({ ...lineage, durationMs: Math.max(0, nowMs() - startTime), error: message, errorText, steps: live.steps() }) };
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      entry.busy = false;
    }
  }
}
