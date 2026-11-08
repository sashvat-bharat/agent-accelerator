import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ScheduledActionRecord } from "../src/types/scheduler.ts";
import * as path from "node:path";
import {
  Agent,
  SubAgentModelError,
  ConfigError,
  ValidationError,
  tool,
  telemetryBus,
  executeToolCalls,
  createScheduledAction,
  listScheduledActions,
  updateScheduledAction,
  runScheduledAction,
  skipScheduledAction,
  deleteScheduledAction,
  getDatetimeTool,
  type AgentConfig,
  type ScheduledActionInput,
  type TelemetryEvent,
} from "../src/index.ts";
import { z } from "zod";
import { getScheduler, resetSchedulers, type Scheduler } from "../src/scheduler/scheduler.ts";
import { createScheduledActionsTool } from "../src/scheduler/tool.ts";
import { scheduledRunTimeoutMs } from "../src/agent/worker.ts";
import {
  readDeliveries,
  readRun,
  readTasks,
  removeTaskFolder,
  resolveHome,
  updateDeliveries,
  updateTask,
  validateDelivery,
  validateRecord,
  writeRunFile,
  type RunHeader,
} from "../src/scheduler/store.ts";
import {
  assertCookShorterThanRepeat,
  cookTime,
  durationMs,
  formatDatetime,
  nextAfter,
  nextOccurrence,
  parseDDHHMM,
  parseLocalIso,
  resolveDelivery,
  runFileName,
  toLocalIso,
} from "../src/scheduler/time.ts";

// Monday 26 October 2026, local clock.
const at = (h: number, m = 0, s = 0): Date => new Date(2026, 9, 26, h, m, s);
const iso = (h: number, m = 0, s = 0, day = 26): string => toLocalIso(new Date(2026, 9, day, h, m, s));

// Changes the first action's record on disk the way an outside editor would; in: a test, out: the rewritten task.json.
function editTask(home: string, fn: (rec: ScheduledActionRecord) => void): void {
  updateTask(home, readTasks(home)[0]!.id, (t) => fn(t!));
}
// The task.json of an action; in: a test, out: its path.
const taskFileOf = (home: string, id: string): string => path.join(home, "scheduled", id, "task.json");

// ---------------------------------------------------------------------------
// Time (pure)
// ---------------------------------------------------------------------------
describe("scheduler time maths", () => {
  it("parses DD:HH:MM and rejects malformed values with the field and an example", () => {
    expect(parseDDHHMM("00:07:00", "f")).toEqual({ dd: 0, hh: 7, mm: 0 });
    expect(parseDDHHMM("120:01:59", "f")).toEqual({ dd: 120, hh: 1, mm: 59 });
    for (const bad of ["1:00:00", "00:10:75", "00:10", "abc", 5, undefined]) {
      expect(() => parseDDHHMM(bad, "scheduled_action.timeToDeliver")).toThrow(/scheduled_action\.timeToDeliver.*DD:HH:MM.*e\.g\./);
    }
    expect(() => durationMs("00:24:00", "f")).toThrow(/HH must be 00-23/);
    expect(durationMs("00:00:10", "f")).toBe(10 * 60_000);
    expect(durationMs("01:00:00", "f")).toBe(24 * 3_600_000);
  });

  it("resolves delivery for today, tomorrow and 55 days ahead", () => {
    const now = at(8, 0);
    expect(resolveDelivery(now, "00:07:00", "PM")).toEqual(at(19, 0));
    expect(resolveDelivery(now, "01:07:00", "AM")).toEqual(new Date(2026, 9, 27, 7, 0, 0));
    expect(resolveDelivery(now, "55:09:30", "AM")).toEqual(new Date(2026, 9, 26 + 55, 9, 30, 0));
  });

  it("handles 12 AM and 12 PM", () => {
    const now = at(8, 0);
    expect(resolveDelivery(now, "01:12:00", "AM")).toEqual(new Date(2026, 9, 27, 0, 0, 0));
    expect(resolveDelivery(now, "00:12:00", "PM")).toEqual(at(12, 0));
  });

  it("rejects a past time (suggesting 01 for tomorrow), a 24h HH and a bad meridiem, all in one message", () => {
    expect(() => resolveDelivery(at(15, 0), "00:07:00", "AM")).toThrow(/already in the past.*"01"/);
    expect(() => resolveDelivery(at(15, 0), "00:15:00", "PM")).toThrow(/01-12/);
    expect(() => resolveDelivery(at(8, 0), "00:13:99", "pm")).toThrow(/timeToDeliver.*meridiem/);
  });

  it("nextOccurrence keeps the wall-clock time (calendar maths, never +86_400_000 ms)", () => {
    let d = new Date(2026, 9, 29, 7, 0, 0);
    for (let i = 0; i < 6; i++) d = nextOccurrence(d, "01:00:00");
    expect(d).toEqual(new Date(2026, 10, 4, 7, 0, 0));
    expect(nextOccurrence(at(9, 0), "07:00:00")).toEqual(new Date(2026, 10, 2, 9, 0, 0));
    expect(nextOccurrence(at(9, 0), "00:01:30")).toEqual(at(10, 30));
  });

  it("nextAfter returns the first occurrence strictly after now", () => {
    expect(nextAfter(at(9, 0), "01:00:00", at(9, 0))).toEqual(new Date(2026, 9, 27, 9, 0, 0));
    expect(nextAfter(at(9, 0), "01:00:00", at(8, 0))).toEqual(at(9, 0));
    expect(nextAfter(at(9, 0), "00:01:00", at(12, 30))).toEqual(at(13, 0));
  });

  it("formats local datetimes without a timezone, and run file names", () => {
    expect(formatDatetime(new Date(2026, 9, 26, 15, 55, 31))).toBe("Monday, 26 October, 03:55:31 PM, 2026");
    expect(formatDatetime(new Date(2026, 9, 26, 0, 5, 9))).toBe("Monday, 26 October, 12:05:09 AM, 2026");
    expect(runFileName(new Date(2026, 9, 27, 7, 0))).toBe("27-october-2026");
    expect(runFileName(new Date(2026, 0, 5))).toBe("05-january-2026");
  });

  it("round-trips local ISO strings and rejects other shapes", () => {
    const d = at(6, 50, 5);
    expect(toLocalIso(d)).toBe("2026-10-26T06:50:05");
    expect(parseLocalIso(toLocalIso(d))).toEqual(d);
    expect(() => parseLocalIso("2026-10-26 06:50")).toThrow(ValidationError);
  });

  it("requires the cook lead to be shorter than the repeat gap", () => {
    expect(() => assertCookShorterThanRepeat(60_000, 60_000)).toThrow(/shorter than repeatEvery/);
    expect(() => assertCookShorterThanRepeat(60_000, 120_000)).not.toThrow();
    expect(cookTime(at(19, 0), 10 * 60_000)).toEqual(at(18, 50));
  });
});

// ---------------------------------------------------------------------------
// Harness: fake clock, mock provider, temp home
// ---------------------------------------------------------------------------
const homes: string[] = [];
const offs: Array<() => void> = [];
/** The scheduler holds agents weakly, so tests keep every Agent they build referenced. */
const alive: Agent[] = [];

afterEach(() => {
  resetSchedulers();
  alive.length = 0;
  for (const off of offs.splice(0)) off();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const chatReply = (text = "Brief done.") =>
  new Response(
    JSON.stringify({
      id: "c",
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200 }
  );
const badReply = () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 });

function mockFetch(handler: (n: number, body: any) => Response | Promise<Response>) {
  const calls: any[] = [];
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5);
};

function gate() {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return { open, release };
}

function capture() {
  const events: TelemetryEvent[] = [];
  offs.push(telemetryBus.onEvent((e) => e.code.startsWith("scheduled_action.") && events.push(e)));
  return { events, codes: () => events.map((e) => e.code), of: (code: string) => events.filter((e) => e.code === code) };
}

interface Harness {
  home: string;
  clock: Date;
  s: Scheduler;
  set(h: number, m?: number, sec?: number): void;
  /** Simulates a process restart: stops the clock and starts a fresh scheduler on the same home. */
  boot(): Scheduler;
  settle(): Promise<unknown>;
  agent(fn: typeof fetch, extra?: Partial<AgentConfig>): Agent;
}

function harness(): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  homes.push(home);
  const h: Harness = {
    home,
    clock: at(15, 0),
    s: undefined as unknown as Scheduler,
    set(hh, mm = 0, sec = 0) {
      h.clock = at(hh, mm, sec);
    },
    boot() {
      resetSchedulers();
      h.s = getScheduler(home);
      h.s.tickMs = 3_600_000; // the real timer never fires during a test; ticks are manual
      h.s.now = () => new Date(h.clock);
      return h.s;
    },
    settle: () => Promise.all([...h.s.running.values()].map((r) => r.done)),
    agent: (fn, extra = {}) => {
      const agent = new Agent({
        name: "Main",
        model: "groq/test-model",
        apiKey: "k",
        baseUrl: "https://example.test/v1",
        fetch: fn,
        retry: { maxRetries: 0 },
        home,
        dynamicSubagents: {
          enabled: false,
          model: "groq/test-model",
          allowScheduledActions: true,
          tools: { recent_news: tool({ description: "news", input: z.object({}), execute: () => "n" }) },
        },
        ...extra,
      });
      alive.push(agent);
      return agent;
    },
  };
  h.boot();
  return h;
}

const input = (sa: Partial<ScheduledActionInput["scheduled_action"]> = {}, over: Partial<ScheduledActionInput> = {}): ScheduledActionInput => ({
  instructions: "You write briefs.",
  task: "Write the brief.",
  tools: ["recent_news"],
  ...over,
  scheduled_action: {
    name: "Check Portfolio",
    id: "check-portfolio",
    timeToDeliver: "00:07:00",
    meridiem: "PM",
    startCookingInAdvance: "00:00:10",
    ...sa,
  },
});

const runDir = (h: Harness, id: string) => path.join(h.home, "scheduled", id);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
describe("scheduled actions config", () => {
  it("is off by default: no tools, no timer, nothing on disk", () => {
    const h = harness();
    const agent = new Agent({
      name: "Main", model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", home: h.home,
      dynamicSubagents: { model: "groq/test-model" },
    });
    expect(agent.tools["scheduled_actions"]).toBeUndefined();
    expect(agent.tools["get_datetime"]).toBeUndefined();
    expect((h.s as any).timer).toBeUndefined();
    expect(fs.existsSync(path.join(h.home, "scheduled"))).toBe(false);
    expect(() => createScheduledAction(agent, input())).toThrow(ConfigError);
  });

  it("throws SubAgentModelError when enabled without a worker model", () => {
    const prev = process.env.SUB_AGENT_MODEL;
    delete process.env.SUB_AGENT_MODEL;
    try {
      expect(
        () => new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", dynamicSubagents: { enabled: false, allowScheduledActions: true } })
      ).toThrow(SubAgentModelError);
    } finally {
      if (prev) process.env.SUB_AGENT_MODEL = prev;
    }
  });

  it("adds scheduled_actions + get_datetime when on, and keeps a user-defined get_datetime", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    expect(Object.keys(agent.tools)).toEqual(expect.arrayContaining(["scheduled_actions", "get_datetime"]));
    const mine = tool({ name: "get_datetime", description: "mine", input: z.object({}), execute: () => "mine" });
    const custom = h.agent(mockFetch(() => chatReply()).fn, { name: "Other", tools: { get_datetime: mine } });
    expect(custom.tools["get_datetime"]!.description).toBe("mine");
  });

  it("fork() copies cannot schedule and never replace the real agent", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const copy = agent.fork("accel-fork-1");
    expect(copy.dynamicSubagents?.allowScheduledActions).toBe(false);
    expect(copy.tools["scheduled_actions"]).toBeUndefined();
    expect(copy.tools["get_datetime"]).toBeUndefined();
    expect(h.s.agents.get("Main")?.deref()).toBe(agent);
  });

  it("`home` defaults to .agent-accel in the working directory and `persist: {}` uses <home>/sessions", () => {
    expect(resolveHome()).toBe(path.resolve(".agent-accel"));
    const h = harness();
    const a = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", home: h.home, persist: {} });
    expect(a.persistConfig?.dir).toBe(path.join(h.home, "sessions"));
    const explicit = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", home: h.home, persist: { file: path.join(h.home, "x.json") } });
    expect(explicit.persistConfig).toEqual({ file: path.join(h.home, "x.json") });
    expect(new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1" }).persistConfig).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
describe("scheduled actions store", () => {
  it("an external edit survives the next write (writes re-read first)", () => {
    const h = harness();
    createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    const file = taskFileOf(h.home, readTasks(h.home)[0]!.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.task.instructions = "EDITED BY HAND";
    raw.task.someFutureField = { keep: true };
    fs.writeFileSync(file, JSON.stringify(raw));
    editTask(h.home, (t) => {
      t.name = "Renamed";
    });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.task.instructions).toBe("EDITED BY HAND");
    expect(after.task.name).toBe("Renamed");
    expect(after.task.someFutureField).toEqual({ keep: true });
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("quarantines a corrupt task.json and ignores that action", () => {
    const h = harness();
    const { codes } = capture();
    const dir = path.join(h.home, "scheduled", "damaged-abc123");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), "{not json");
    expect(readTasks(h.home)).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("task.json.corrupt-"))).toBe(true);
    expect(codes()).toContain("scheduled_action.store_corrupt");
  });

  it("flags an invalid record instead of throwing, and the clock skips it", () => {
    const h = harness();
    const { of } = capture();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const good = createScheduledAction(agent, input());
    const badDir = path.join(h.home, "scheduled", "bad-abc123");
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, "task.json"), JSON.stringify({ version: 2, task: { id: "bad-abc123", name: "x" } }));
    expect(validateRecord(readTasks(h.home).find((t) => t.id === "bad-abc123"))).toMatch(/instructions/);
    h.set(18, 50);
    h.s.tick();
    h.s.tick();
    expect(of("scheduled_action.invalid")).toHaveLength(1); // reported once, not every tick
    expect(readTasks(h.home).map((t) => t.id)).toContain("bad-abc123"); // left untouched on disk
    expect(h.s.running.has(good.id)).toBe(true); // the valid one still runs
  });

  it("names same-day run files -2, -3 on a clash", () => {
    const h = harness();
    const header = (n: number): RunHeader => ({ id: "x", name: "x", status: "ok", startedAt: "a", finishedAt: "b", deliverAt: "c", late: false, tokens: n });
    const d = at(7, 0);
    expect(writeRunFile(h.home, "job-abc123", d, header(1), "one")).toBe("job-abc123/26-october-2026.md");
    expect(writeRunFile(h.home, "job-abc123", d, header(2), "two")).toBe("job-abc123/26-october-2026-2.md");
    expect(writeRunFile(h.home, "job-abc123", d, header(3), "three")).toBe("job-abc123/26-october-2026-3.md");
  });

  it("purge refuses anything that is not an action id inside scheduled/", () => {
    const h = harness();
    const outside = path.join(h.home, "keep");
    fs.mkdirSync(outside, { recursive: true });
    for (const bad of ["../keep", "..", "a/b", "/etc", "UPPER", ""]) expect(() => removeTaskFolder(h.home, bad)).toThrow(ValidationError);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Create / validation
// ---------------------------------------------------------------------------
describe("createScheduledAction", () => {
  it("saves a waiting action with the right times and a 6-char id suffix", () => {
    const h = harness();
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    expect(rec.id).toMatch(/^check-portfolio-[a-z0-9]{6}$/);
    expect(rec).toMatchObject({
      name: "Check Portfolio",
      agent: "Main",
      state: "waiting",
      tools: ["recent_news"],
      nextDeliverAt: iso(19, 0),
      nextCookAt: iso(18, 50),
    });
    expect(readTasks(h.home)).toHaveLength(1);
    const again = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    expect(again.id).not.toBe(rec.id);
  });

  it("defaults the cook lead to 10 minutes for the developer API", () => {
    const h = harness();
    const sa = input().scheduled_action;
    delete (sa as any).startCookingInAdvance;
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), { ...input(), scheduled_action: sa });
    expect(rec.schedule.startCookingInAdvance).toBe("00:00:10");
    expect(rec.nextCookAt).toBe(iso(18, 50));
  });

  it("reports every problem in one message", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const bad = { instructions: "", task: "t", tools: ["nope"], scheduled_action: { name: "", id: "Not Kebab", timeToDeliver: "7:00", meridiem: "xm", startCookingInAdvance: "soon" } };
    let message = "";
    try {
      createScheduledAction(agent, bad as any);
    } catch (e) {
      message = (e as Error).message;
      expect(e).toBeInstanceOf(ValidationError);
      expect(message.includes("\n")).toBe(false);
    }
    for (const field of ["instructions", "tools", "scheduled_action.name", "scheduled_action.id", "timeToDeliver", "meridiem", "startCookingInAdvance"]) {
      expect(message).toContain(field);
    }
    expect(message).toContain("recent_news"); // unknown tool names list the pool
    expect(readTasks(h.home)).toEqual([]);
  });

  it("rejects a past delivery (suggesting tomorrow) and a lead time that is not shorter than the gap", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    expect(() => createScheduledAction(agent, input({ timeToDeliver: "00:07:00", meridiem: "AM" }))).toThrow(/already in the past.*"01"/);
    expect(() => createScheduledAction(agent, input({ repeatEvery: "00:00:10", startCookingInAdvance: "00:00:10" }))).toThrow(/shorter than repeatEvery/);
    expect(() => createScheduledAction(agent, input({ repeatEvery: "00:00:00" }))).toThrow(/greater than 00:00:00/);
    expect(() => createScheduledAction(agent, input({ retries: -1 }))).toThrow(/retries/);
  });
});

// ---------------------------------------------------------------------------
// Clock + run lifecycle
// ---------------------------------------------------------------------------
describe("scheduler lifecycle (fake clock, manual ticks)", () => {
  it("cooks at the cook time, saves before the delivery time, delivers exactly once at the delivery time", async () => {
    const h = harness();
    const { codes, of } = capture();
    const { fn, calls } = mockFetch(() => chatReply("Portfolio is up 2%."));
    const rec = createScheduledAction(h.agent(fn), input());

    h.set(18, 49, 59);
    h.s.tick();
    expect(calls).toHaveLength(0);
    expect(readTasks(h.home)[0]!.state).toBe("waiting");

    h.set(18, 50);
    h.s.tick();
    let t = readTasks(h.home)[0]!;
    expect(t.state).toBe("cooking");
    expect(t.current).toEqual({ cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) });
    expect(t.nextCookAt).toBeNull(); // one-shot: next times are cleared BEFORE the run starts
    await h.settle();

    // Result is saved under its final name and listed before it is due.
    const file = `${rec.id}/26-october-2026.md`;
    const text = fs.readFileSync(path.join(h.home, "scheduled", file), "utf8");
    expect(text).toContain("status: ok");
    expect(text).toContain(`startedAt: ${iso(18, 50)}`);
    expect(text).toContain("costUsd: unknown");
    expect(text).toContain("Portfolio is up 2%.");
    expect(readDeliveries(h.home)).toEqual([{ id: rec.id, file, status: "ok", readyAt: iso(18, 50), deliverAt: iso(19, 0) }]);
    t = readTasks(h.home)[0]!;
    expect(t.state).toBe("done");
    expect(t.current).toBeUndefined();
    expect(of("scheduled_action.delivered")).toHaveLength(0);
    expect(codes()).toEqual(["scheduled_action.created", "scheduled_action.started", "scheduled_action.ready"]);

    h.set(19, 0);
    h.s.tick();
    h.s.tick();
    const delivered = of("scheduled_action.delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ id: rec.id, name: "Check Portfolio", status: "ok", late: false, deliverAt: iso(19, 0), file: path.join(h.home, "scheduled", file) });
    expect(readDeliveries(h.home)).toEqual([]);
    expect(readTasks(h.home)[0]!.lastRun).toEqual({ status: "ok", file, deliverAt: iso(19, 0), deliveredAt: iso(19, 0), late: false });
  });

  it("a repeating action goes back to waiting with the next occurrence already set", async () => {
    const h = harness();
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input({ repeatEvery: "01:00:00" }));
    h.set(18, 50);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "cooking", nextCookAt: iso(18, 50, 0, 27), nextDeliverAt: iso(19, 0, 0, 27) });
    await h.settle();
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "waiting", nextDeliverAt: iso(19, 0, 0, 27) });
  });

  it("skips (never stacks) a run that is still cooking when the next one is due", async () => {
    const h = harness();
    const { codes } = capture();
    const g = gate();
    const { fn, calls } = mockFetch(async () => {
      await g.open;
      return chatReply();
    });
    createScheduledAction(h.agent(fn), input({ repeatEvery: "00:01:00", startCookingInAdvance: "00:00:30" }));
    h.set(18, 30);
    h.s.tick();
    await until(() => calls.length === 1); // the worker reaches the provider a few microtasks after the tick
    h.set(19, 30); // the 20:00 delivery wants to start cooking, but the 19:00 run is still going
    h.s.tick();
    expect(codes()).toContain("scheduled_action.skipped");
    expect(calls).toHaveLength(1);
    expect(h.s.running.size).toBe(1);
    expect(readTasks(h.home)[0]).toMatchObject({ state: "cooking", nextDeliverAt: iso(21, 0), nextCookAt: iso(20, 30) });
    g.release();
    await h.settle();
    const t = readTasks(h.home)[0]!;
    expect(t.state).toBe("waiting");
    expect(readDeliveries(h.home)[0]).toMatchObject({ deliverAt: iso(19, 0), readyAt: iso(19, 30) });
  });

  it("retries a failed run while there is still time before delivery", async () => {
    const h = harness();
    const { fn, calls } = mockFetch((n) => (n === 1 ? badReply() : chatReply("second try")));
    createScheduledAction(h.agent(fn), input({ retries: 1 }));
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    expect(calls).toHaveLength(2);
    expect(readDeliveries(h.home)[0]!.status).toBe("ok");
  });

  it("the run header records the run's exact spending, like usageReport does for workers", async () => {
    const h = harness();
    createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input()); // 10 in + 5 out, no known price for the test model
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const header = readRun(h.home, readDeliveries(h.home)[0]!.file)!.header;
    expect(header).toMatchObject({
      status: "ok",
      model: "groq/test-model",
      turns: "1",
      tokens: "15",
      inputTokens: "10",
      freshInputTokens: "10",
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      outputTokens: "5",
      thinkingTokens: "0",
      cacheHitRate: "0",
      costUsd: "unknown",
      costSource: "unknown",
      unpricedTurns: "1",
    });
  });

  it("the run header splits cache reads from fresh input and uses the provider's reported cost", async () => {
    const h = harness();
    const cached = () =>
      new Response(
        JSON.stringify({
          id: "c",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 7 }, cost: 0.0005 },
        }),
        { status: 200 }
      );
    createScheduledAction(h.agent(mockFetch(cached).fn), input());
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const header = readRun(h.home, readDeliveries(h.home)[0]!.file)!.header;
    expect(header).toMatchObject({ tokens: "120", inputTokens: "100", freshInputTokens: "20", cacheReadTokens: "80", outputTokens: "20", thinkingTokens: "7", cacheHitRate: "0.8", costUsd: "0.0005", costSource: "provider" });
    expect(header["unpricedTurns"]).toBeUndefined(); // every turn had a price
  });

  it("a failed run still records what it spent, over all attempts", async () => {
    const h = harness();
    const toolTurn = () =>
      new Response(
        JSON.stringify({
          id: "c",
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "recent_news", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 }
      );
    // Attempt 1: a tool turn (15 tokens), then the provider rejects the next call. Attempt 2: a plain answer (15 tokens).
    const { fn } = mockFetch((n) => (n === 1 ? toolTurn() : n === 2 ? badReply() : chatReply()));
    createScheduledAction(h.agent(fn), input({ retries: 1 }));
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const ok = readRun(h.home, readDeliveries(h.home)[0]!.file)!.header;
    expect(ok).toMatchObject({ status: "ok", turns: "2", tokens: "30" }); // the response alone would say 15

    const h2 = harness();
    createScheduledAction(h2.agent(mockFetch((n) => (n === 1 ? toolTurn() : badReply())).fn), input());
    h2.set(18, 50);
    h2.s.tick();
    await h2.settle();
    const failed = readRun(h2.home, readDeliveries(h2.home)[0]!.file)!.header;
    expect(failed).toMatchObject({ status: "failed", turns: "1", tokens: "15", inputTokens: "10", outputTokens: "5" });
    expect(failed["error"]).toBeTruthy();
    expect(failed["model"]).toBeUndefined();
  });

  it("records a failed run (file + delivery) when no time is left to retry", async () => {
    const h = harness();
    const { codes, of } = capture();
    const { fn, calls } = mockFetch(() => {
      h.set(19, 1); // delivery time passes while the first attempt fails
      return badReply();
    });
    const rec = createScheduledAction(h.agent(fn), input({ retries: 2 }));
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    expect(calls).toHaveLength(1);
    expect(codes()).toContain("scheduled_action.failed"); // at once, not at delivery
    const file = `${rec.id}/26-october-2026.md`;
    const text = fs.readFileSync(path.join(h.home, "scheduled", file), "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("The run failed:");
    h.s.tick();
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ status: "failed", late: true });
  });

  it("scheduledRunTimeoutMs: the action's timeoutMs, never above the developer's ceiling, which is also the default", () => {
    expect(scheduledRunTimeoutMs(Infinity, undefined)).toBe(0); // nothing set anywhere: no timeout
    expect(scheduledRunTimeoutMs(Infinity, 5000)).toBe(5000); // the action's own limit is honored without a ceiling
    expect(scheduledRunTimeoutMs(1000, undefined)).toBe(1000); // the ceiling is the default
    expect(scheduledRunTimeoutMs(1000, 5000)).toBe(1000); // ...and a cap
    expect(scheduledRunTimeoutMs(1000, 300)).toBe(300); // a shorter action limit stays
    expect(scheduledRunTimeoutMs(Infinity, 0)).toBe(0);
  });

  it("an action's own timeoutMs times its run out even when the developer set no worker timeout", async () => {
    const h = harness();
    const g = gate();
    const { fn } = mockFetch(async () => {
      await g.open;
      return chatReply();
    });
    createScheduledAction(h.agent(fn), input({}, { timeoutMs: 20 })); // the harness agent has no workerTimeoutMs
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const [pending] = readDeliveries(h.home);
    expect(pending!.status).toBe("failed");
    expect(fs.readFileSync(path.join(h.home, "scheduled", pending!.file), "utf8")).toContain("timed out after 20ms");
    g.release();
  });

  it("the developer's workerTimeoutMs caps an action that asks for longer", async () => {
    const h = harness();
    const g = gate();
    const { fn } = mockFetch(async () => {
      await g.open;
      return chatReply();
    });
    createScheduledAction(
      h.agent(fn, { dynamicSubagents: { enabled: false, model: "groq/test-model", allowScheduledActions: true, tools: {}, workerTimeoutMs: 20 } }),
      input({}, { tools: [], timeoutMs: 600_000 })
    );
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const [pending] = readDeliveries(h.home);
    expect(fs.readFileSync(path.join(h.home, "scheduled", pending!.file), "utf8")).toContain("timed out after 20ms");
    g.release();
  });

  it("times a run out with the developer's worker timeout and records the failure", async () => {
    const h = harness();
    const g = gate();
    const { fn } = mockFetch(async () => {
      await g.open;
      return chatReply();
    });
    createScheduledAction(
      h.agent(fn, { dynamicSubagents: { enabled: false, model: "groq/test-model", allowScheduledActions: true, tools: {}, workerTimeoutMs: 20 } }),
      input({}, { tools: [] })
    );
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const [pending] = readDeliveries(h.home);
    expect(pending!.status).toBe("failed");
    expect(fs.readFileSync(path.join(h.home, "scheduled", pending!.file), "utf8")).toContain("timed out after 20ms");
    g.release();
  });

  it("re-reads the file before each run: an external edit of the instructions is used", async () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    createScheduledAction(h.agent(fn), input());
    editTask(h.home, (t) => {
      t.instructions = "REWRITTEN BY THE MAIN AGENT";
    });
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    expect(calls[0].messages[0].content).toContain("REWRITTEN BY THE MAIN AGENT");
  });

  it("fails a run whose saved tool is no longer in the pool, with a clear error", async () => {
    const h = harness();
    createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    editTask(h.home, (t) => {
      t.tools = ["gone_tool"];
    });
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    const [pending] = readDeliveries(h.home);
    expect(fs.readFileSync(path.join(h.home, "scheduled", pending!.file), "utf8")).toMatch(/no longer in the pool: gone_tool/);
  });

  // A parent whose scheduled runs use `extra` (budget / workerBudget); the pool and worker model are the harness defaults.
  const withBudgets = (h: Harness, fn: typeof fetch, extra: { budget?: AgentConfig["budget"]; workerBudget?: { maxCostUsd?: number; maxTotalTokens?: number } }) =>
    h.agent(fn, {
      ...(extra.budget ? { budget: extra.budget } : {}),
      dynamicSubagents: {
        enabled: false,
        model: "groq/test-model",
        allowScheduledActions: true,
        ...(extra.workerBudget ? { workerBudget: extra.workerBudget } : {}),
        tools: { recent_news: tool({ description: "news", input: z.object({}), execute: () => "n" }) },
      },
    });
  const runText = async (h: Harness): Promise<string> => {
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    return fs.readFileSync(path.join(h.home, "scheduled", readDeliveries(h.home)[0]!.file), "utf8");
  };

  it("a scheduled run is capped by workerBudget: going over records a failed run", async () => {
    const h = harness();
    createScheduledAction(withBudgets(h, mockFetch(() => chatReply()).fn, { workerBudget: { maxTotalTokens: 3 } }), input()); // one model turn = 15 tokens
    const text = await runText(h);
    expect(text).toContain("status: failed");
    expect(text).toContain("Token budget exceeded");
  });

  it("without workerBudget a scheduled run has no cap, and the agent's own budget is not borrowed", async () => {
    const h = harness();
    createScheduledAction(withBudgets(h, mockFetch(() => chatReply("fine")).fn, { budget: { maxTotalTokens: 1, maxCostUsd: 0.0000001 } }), input());
    const text = await runText(h);
    expect(text).toContain("status: ok");
    expect(text).toContain("fine");
  });

  it("counts a run as missed (never runs it) when the creating Agent is no longer alive", () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    const { of } = capture();
    const rec = createScheduledAction(h.agent(fn), input());
    h.s.agents.clear(); // what happens once the Agent is garbage collected
    h.set(18, 50);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "waiting" }); // another process may own it: not missed at cook time
    h.set(19, 0);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "missed" }); // its delivery time passed with no run
    expect(of("scheduled_action.missed")[0]!.data).toMatchObject({ reason: "no_agent" });
    expect(calls).toHaveLength(0);
  });

  it("a delivery entry's late flag must be a boolean when present", () => {
    const entry = { id: "a-b12345", file: "a-b12345/26-october-2026.md", status: "ok", readyAt: iso(19, 0), deliverAt: iso(19, 0) };
    expect(validateDelivery(entry)).toBeUndefined();
    expect(validateDelivery({ ...entry, late: true })).toBeUndefined();
    expect(validateDelivery({ ...entry, late: "yes" })).toMatch(/late/);
  });

  it("skips a damaged delivery.json entry (warns once) instead of stalling the scheduler", async () => {
    const h = harness();
    const { of } = capture();
    const { fn, calls } = mockFetch(() => chatReply());
    createScheduledAction(h.agent(fn), input());
    updateDeliveries(h.home, "x", (p) => void p.push({ id: "x", file: "x/y.md", status: "ok", readyAt: "garbage", deliverAt: "garbage" } as any));
    h.set(18, 50);
    h.s.tick();
    h.s.tick();
    await h.settle();
    expect(calls).toHaveLength(1); // the healthy action still ran
    expect(of("scheduled_action.invalid")).toHaveLength(1); // reported once, not every tick
    expect(of("scheduled_action.error")).toHaveLength(0);
    expect(readDeliveries(h.home).some((p) => p.id === "x")).toBe(true); // left untouched in the file
  });

  it("stops its timer when nothing is pending, and never keeps the process alive", async () => {
    const h = harness();
    h.s.tickMs = 5_000; // real interval, but it will not fire during this test
    createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    const timer = (h.s as any).timer;
    expect(timer).toBeDefined();
    expect(timer.hasRef()).toBe(false);
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.set(19, 0);
    h.s.tick(); // delivers; the one-shot is done and nothing is pending
    expect((h.s as any).timer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Startup (a restarted process)
// ---------------------------------------------------------------------------
describe("scheduler startup sweep", () => {
  it("marks a due waiting action missed and runs nothing by itself", () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    const rec = createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00" }));
    h.boot();
    h.set(20, 0);
    const { of } = capture();
    h.agent(fn); // the restarted program constructs its Agent again
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "missed" });
    expect(of("scheduled_action.missed")).toHaveLength(1);
    h.s.tick();
    expect(of("scheduled_action.missed")).toHaveLength(1); // one event per action
    expect(calls).toHaveLength(0);
  });

  it("marks a stale cooking action missed when no run file exists", () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    const rec = createScheduledAction(h.agent(fn), input());
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
    });
    h.boot();
    h.set(18, 55);
    const { of } = capture();
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "missed" });
    expect(of("scheduled_action.missed")[0]!.data).toMatchObject({ reason: "interrupted" });
  });

  it("onMissed skip: a missed repeating run moves on to the next time without running", () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00", onMissed: "skip" }));
    h.boot();
    h.set(20, 0);
    const { codes, of } = capture();
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "waiting", nextDeliverAt: iso(19, 0, 0, 27), nextCookAt: iso(18, 50, 0, 27) });
    expect(codes().filter((c) => c === "scheduled_action.missed" || c === "scheduled_action.skipped")).toEqual(["scheduled_action.missed", "scheduled_action.skipped"]);
    expect(of("scheduled_action.missed")[0]!.data).toMatchObject({ reason: "process_down", onMissed: "skip" });
    expect(calls).toHaveLength(0);
  });

  it("onMissed skip: a missed one-shot is done", () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    createScheduledAction(h.agent(fn), input({ onMissed: "skip" }));
    h.boot();
    h.set(20, 0);
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "done", nextCookAt: null, nextDeliverAt: null });
  });

  it("onMissed run: a missed run starts at once and the schedule moves to the next time", async () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply("late brief"));
    const rec = createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00", onMissed: "run" }));
    h.boot();
    h.set(20, 0);
    const { codes, of } = capture();
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "cooking", nextDeliverAt: iso(19, 0, 0, 27) });
    await h.settle();
    h.s.tick();
    expect(calls).toHaveLength(1);
    expect(codes()).toEqual(expect.arrayContaining(["scheduled_action.missed", "scheduled_action.started", "scheduled_action.ready", "scheduled_action.delivered"]));
    expect(of("scheduled_action.missed")[0]!.data).toMatchObject({ onMissed: "run" });
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: true }); // it ran after its time
    expect(readTasks(h.home)[0]).toMatchObject({ id: rec.id, state: "waiting", nextDeliverAt: iso(19, 0, 0, 27), lastRun: { status: "ok", late: true } });
    h.s.tick();
    expect(calls).toHaveLength(1); // the missed occurrence ran once, not again
  });

  it("onMissed applies to a run a crash cut off (stale cooking, no run file)", () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00", onMissed: "skip" }));
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
      t.nextCookAt = iso(18, 50, 0, 27); // advanced before the run, as the scheduler does
      t.nextDeliverAt = iso(19, 0, 0, 27);
    });
    h.boot();
    h.set(18, 55);
    const { of } = capture();
    h.agent(fn);
    h.s.tick();
    expect(of("scheduled_action.missed")[0]!.data).toMatchObject({ reason: "interrupted", onMissed: "skip" });
    expect(readTasks(h.home)[0]).toMatchObject({ state: "waiting", nextDeliverAt: iso(19, 0, 0, 27) });
    expect(calls).toHaveLength(0);
  });

  it("without onMissed a missed run still waits for run_now or skip", () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00" }));
    h.boot();
    h.set(20, 0);
    const { codes } = capture();
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "missed" });
    expect(codes()).not.toContain("scheduled_action.skipped");
    expect(calls).toHaveLength(0);
  });

  it("rebuilds the delivery when a crash left the run file but no entry", async () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    const rec = createScheduledAction(h.agent(fn), input());
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    // Crash simulation: run file written, delivery entry and task update lost.
    updateDeliveries(h.home, rec.id, (p) => void p.splice(0));
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
    });
    h.boot();
    h.set(18, 55);
    h.agent(fn);
    h.s.tick();
    expect(readDeliveries(h.home)).toEqual([{ id: rec.id, file: `${rec.id}/26-october-2026.md`, status: "ok", readyAt: iso(18, 50), deliverAt: iso(19, 0) }]);
    expect(readTasks(h.home)[0]).toMatchObject({ state: "done" });
    expect(readTasks(h.home)[0]!.current).toBeUndefined();
  });

  it("a crash after the run file was written keeps the late flag of a replaced missed run", async () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00", onMissed: "run" }));
    h.boot();
    h.set(20, 0);
    h.agent(fn);
    h.s.tick();
    await h.settle(); // the missed run ran and wrote its file with `late: true`
    updateDeliveries(h.home, readTasks(h.home)[0]!.id, (p) => void p.splice(0)); // crash: the delivery entry and the task update are lost
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(20, 0), deliverAt: iso(20, 0) };
    });
    h.boot();
    h.set(20, 0, 30); // 30 s later: on time by the clock, so only the saved flag can make it late
    const { of } = capture();
    h.agent(fn);
    h.s.tick(); // the startup sweep rebuilds the entry, and the same tick delivers it
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: true });
  });

  it("delivers a saved result that is past due on the first tick, marked late", async () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    createScheduledAction(h.agent(fn), input());
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.boot(); // the process exited before the delivery time
    h.set(19, 30);
    const { of } = capture();
    h.agent(fn);
    expect(of("scheduled_action.delivered")).toHaveLength(0); // nothing inside the constructor
    h.s.tickMs = 1000; // the real tick length: 30 minutes past due is far more than two ticks
    h.s.tick();
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: true });
  });
});

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------
describe("list / update / run_now / skip / delete", () => {
  it("lists every action with a running flag", async () => {
    const h = harness();
    const g = gate();
    createScheduledAction(h.agent(mockFetch(async () => (await g.open, chatReply())).fn), input());
    expect(listScheduledActions({ home: h.home })).toMatchObject([{ state: "waiting", running: false }]);
    h.set(18, 50);
    h.s.tick();
    expect(listScheduledActions({ home: h.home })).toMatchObject([{ state: "cooking", running: true }]);
    g.release();
    await h.settle();
  });

  it("update changes content and recomputes the schedule; refuses schedule changes while cooking", async () => {
    const h = harness();
    const g = gate();
    const { fn } = mockFetch(async () => (await g.open, chatReply()));
    const rec = createScheduledAction(h.agent(fn), input());
    const edited = updateScheduledAction(rec.id, { task: "A new assignment.", scheduled_action: { name: "Renamed" } }, { home: h.home });
    expect(edited).toMatchObject({ task: "A new assignment.", name: "Renamed", nextDeliverAt: iso(19, 0) });
    expect(updateScheduledAction(rec.id, { scheduled_action: { startCookingInAdvance: "00:01:00" } }, { home: h.home }).nextCookAt).toBe(iso(18, 0));
    expect(updateScheduledAction(rec.id, { scheduled_action: { timeToDeliver: "00:09:00", meridiem: "PM" } }, { home: h.home })).toMatchObject({
      nextDeliverAt: iso(21, 0),
      nextCookAt: iso(20, 0),
    });
    expect(() => updateScheduledAction(rec.id, { tools: ["nope"] }, { home: h.home })).toThrow(/recent_news/);
    expect(() => updateScheduledAction(rec.id, { scheduled_action: { repeatEvery: "00:00:30" } }, { home: h.home })).toThrow(/shorter than repeatEvery/);
    expect(() => updateScheduledAction("missing-abc123", { task: "x" }, { home: h.home })).toThrow(/No scheduled action/);
    expect(readTasks(h.home)[0]!.nextDeliverAt).toBe(iso(21, 0)); // failed updates changed nothing

    h.set(20, 0);
    h.s.tick();
    expect(() => updateScheduledAction(rec.id, { scheduled_action: { timeToDeliver: "00:10:00", meridiem: "PM" } }, { home: h.home })).toThrow(/cooking right now/);
    expect(updateScheduledAction(rec.id, { task: "Allowed while cooking." }, { home: h.home }).task).toBe("Allowed while cooking.");
    g.release();
    await h.settle();
  });

  it("onMissed is validated, stored, and changeable with update", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    expect(() => createScheduledAction(agent, input({ onMissed: "later" as never }))).toThrow(/onMissed.*"skip" or "run"/);
    expect(readTasks(h.home)).toEqual([]);
    const rec = createScheduledAction(agent, input({ onMissed: "run" }));
    expect(readTasks(h.home)[0]!.schedule.onMissed).toBe("run");
    expect(updateScheduledAction(rec.id, { scheduled_action: { onMissed: "skip" } }, { home: h.home }).schedule.onMissed).toBe("skip");
    expect(() => updateScheduledAction(rec.id, { scheduled_action: { onMissed: "never" as never } }, { home: h.home })).toThrow(/onMissed/);
    expect(readTasks(h.home)[0]!.schedule.onMissed).toBe("skip");
  });

  it("run_now runs immediately without shifting the schedule, and is delivered on the next tick", async () => {
    const h = harness();
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply("manual")).fn), input());
    const started = runScheduledAction(rec.id, { home: h.home });
    expect(started).toMatchObject({ state: "cooking", nextDeliverAt: iso(19, 0), nextCookAt: iso(18, 50), current: { deliverAt: iso(15, 0) } });
    expect(() => runScheduledAction(rec.id, { home: h.home })).toThrow(/already cooking/);
    await h.settle();
    h.s.tick();
    expect(readTasks(h.home)[0]).toMatchObject({ state: "waiting", nextDeliverAt: iso(19, 0), lastRun: { status: "ok", deliverAt: iso(15, 0) } });
    expect(readDeliveries(h.home)).toEqual([]);
  });

  it("run_now that takes seconds is delivered when it finishes and is not late", async () => {
    const h = harness();
    const { of } = capture();
    const rec = createScheduledAction(h.agent(mockFetch(() => { h.set(15, 0, 5); return chatReply("manual"); }).fn), input());
    runScheduledAction(rec.id, { home: h.home });
    await h.settle();
    h.s.tick();
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: false, readyAt: iso(15, 0, 5), deliverAt: iso(15, 0, 5) });
    expect(readTasks(h.home)[0]!.lastRun).toMatchObject({ late: false, deliverAt: iso(15, 0, 5) });
    expect(fs.readFileSync(path.join(h.home, "scheduled", `${rec.id}/26-october-2026.md`), "utf8")).toContain("late: false");
  });

  it("a scheduled run that finishes inside its delivery second is not late", async () => {
    const h = harness();
    const { of } = capture();
    const rec = createScheduledAction(h.agent(mockFetch(() => { h.clock = new Date(at(19, 0).getTime() + 400); return chatReply(); }).fn), input());
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    expect(fs.readFileSync(path.join(h.home, "scheduled", `${rec.id}/26-october-2026.md`), "utf8")).toContain("late: false");
    h.s.tick();
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: false });
  });

  it("run_now needs a live agent; list/get/delete/skip do not", async () => {
    const h = harness();
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    h.boot(); // restarted, Agent not constructed yet
    expect(() => runScheduledAction(rec.id, { home: h.home })).toThrow(ConfigError);
    expect(listScheduledActions({ home: h.home })).toHaveLength(1);
    expect(() => skipScheduledAction(rec.id, { home: h.home })).toThrow(/nothing to skip/);
    expect(await deleteScheduledAction(rec.id, { home: h.home })).toEqual({ ok: true });
  });

  it("run_now resolves a missed repeating action by moving to the next occurrence after now", async () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    const rec = createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00" }));
    h.boot();
    h.set(20, 0);
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]!.state).toBe("missed");
    expect(runScheduledAction(rec.id, { home: h.home })).toMatchObject({ state: "cooking", nextDeliverAt: iso(19, 0, 0, 27), nextCookAt: iso(18, 50, 0, 27) });
    await h.settle();
    expect(readTasks(h.home)[0]!.state).toBe("waiting");
  });

  it("a run_now that replaces a missed occurrence is late; a plain run_now is not", async () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    const missedRec = createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00" }));
    h.boot();
    h.set(20, 0);
    h.agent(fn);
    h.s.tick();
    expect(readTasks(h.home)[0]!.state).toBe("missed");
    runScheduledAction(missedRec.id, { home: h.home });
    await h.settle();
    expect(readDeliveries(h.home)[0]).toMatchObject({ id: missedRec.id, late: true }); // the flag is on the saved entry
    expect(fs.readFileSync(path.join(h.home, "scheduled", readDeliveries(h.home)[0]!.file), "utf8")).toContain("late: true");
    const { of } = capture();
    h.s.tick();
    expect(of("scheduled_action.delivered")[0]!.data).toMatchObject({ late: true });
    expect(readTasks(h.home)[0]!.lastRun).toMatchObject({ late: true });

    // The same action run early (it is waiting again) is a plain run_now: on time.
    runScheduledAction(missedRec.id, { home: h.home });
    await h.settle();
    h.s.tick();
    expect(of("scheduled_action.delivered")[1]!.data).toMatchObject({ late: false });
  });

  it("skip ignores a missed run: next occurrence for a repeat, done for a one-shot", () => {
    const h = harness();
    const fn = mockFetch(() => chatReply()).fn;
    const daily = createScheduledAction(h.agent(fn), input({ repeatEvery: "01:00:00" }));
    const once = createScheduledAction(h.agent(fn), input({ id: "once-only" }));
    h.boot();
    h.set(20, 0);
    h.agent(fn);
    h.s.tick();
    expect(skipScheduledAction(daily.id, { home: h.home })).toMatchObject({ state: "waiting", nextDeliverAt: iso(19, 0, 0, 27), nextCookAt: iso(18, 50, 0, 27) });
    expect(skipScheduledAction(once.id, { home: h.home })).toMatchObject({ state: "done", nextDeliverAt: null, nextCookAt: null });
  });

  it("the old kill names are gone from the public API (no alias)", async () => {
    const mod = (await import("../src/index.ts")) as Record<string, unknown>;
    expect(typeof mod.deleteScheduledAction).toBe("function");
    expect(mod.killScheduledAction).toBeUndefined();
  });

  it("delete: not found, idle, running (needs force), force aborts without a run file, purge removes the folder", async () => {
    const h = harness();
    const { of } = capture();
    const g = gate();
    const { fn } = mockFetch(async () => (await g.open, chatReply()));
    expect(await deleteScheduledAction("nope-abc123", { home: h.home })).toEqual({ ok: false, reason: "not_found" });

    const idle = createScheduledAction(h.agent(fn), input({ id: "idle-one" }));
    expect(await deleteScheduledAction(idle.id, { home: h.home })).toEqual({ ok: true });
    expect(readTasks(h.home)).toEqual([]);

    const rec = createScheduledAction(h.agent(fn), input());
    h.set(18, 50);
    h.s.tick();
    const refused = await deleteScheduledAction(rec.id, { home: h.home });
    expect(refused).toMatchObject({ ok: false, reason: "running" });
    expect((refused as { message: string }).message).toContain("force: true");
    expect(readTasks(h.home)).toHaveLength(1);

    expect(await deleteScheduledAction(rec.id, { home: h.home, force: true })).toEqual({ ok: true });
    expect(readTasks(h.home)).toEqual([]);
    expect(readDeliveries(h.home)).toEqual([]);
    expect(fs.existsSync(runDir(h, rec.id))).toBe(false); // an aborted run writes no file
    expect(of("scheduled_action.deleted").map((e) => (e.data as any).forced)).toEqual([false, true]);
    g.release();

    // purge: a finished action's run files are kept unless asked.
    const kept = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input({ id: "kept-one" }));
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    expect(fs.existsSync(runDir(h, kept.id))).toBe(true);
    await deleteScheduledAction(kept.id, { home: h.home });
    expect(fs.existsSync(runDir(h, kept.id))).toBe(true);
    const purged = createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input({ id: "purged-one" }));
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    await deleteScheduledAction(purged.id, { home: h.home, purge: true });
    expect(fs.existsSync(runDir(h, purged.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The model-facing tools
// ---------------------------------------------------------------------------
describe("scheduled_actions and get_datetime tools", () => {
  const call = async (agent: Agent, args: Record<string, unknown>) => {
    const [r] = await executeToolCalls({ tools: agent.tools, toolCalls: [{ id: "t1", name: "scheduled_actions", arguments: args }] });
    return r!;
  };

  it("create accepts onMissed and the manual explains it", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    expect(agent.tools["scheduled_actions"]!.description).toContain("onMissed");
    const ok = await call(agent, { command: "create", instructions: "i", task: "t", scheduled_action: { name: "N", id: "n-job", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10", onMissed: "run" } });
    expect(ok.isError).toBe(false);
    expect(readTasks(h.home)[0]!.schedule.onMissed).toBe("run");
    const bad = await call(agent, { command: "create", instructions: "i", task: "t", scheduled_action: { name: "N", id: "n-two", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10", onMissed: "maybe" } });
    expect(bad.isError).toBe(true);
    expect(readTasks(h.home)).toHaveLength(1);
  });

  it("the description is the manual with the worker pool filled in", () => {
    const h = harness();
    const t = h.agent(mockFetch(() => chatReply()).fn).tools["scheduled_actions"]!;
    expect(t.description).toContain("get_datetime");
    expect(t.description).toContain("startCookingInAdvance");
    expect(t.description).toContain("recent_news");
    expect(t.description).not.toContain("{{TOOLS}}");
  });

  it("create names every missing field in one message and ends with a valid example", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const r = await call(agent, { command: "create", scheduled_action: { timeToDeliver: "00:07:00" } });
    expect(r.isError).toBe(true);
    const msg = String(r.result);
    for (const field of ["instructions", "task", "scheduled_action.name", "scheduled_action.id", "meridiem", "startCookingInAdvance"]) {
      expect(msg).toContain(field);
    }
    expect(msg).toContain("Valid example:");
    expect(msg).toContain('"command":"create"');
    expect(readTasks(h.home)).toEqual([]);
  });

  it("create works end to end, and the model must state startCookingInAdvance", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const ok = await call(agent, { command: "create", ...{ instructions: "i", task: "t" }, scheduled_action: { name: "N", id: "n-job", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10" } });
    expect(ok.isError).toBe(false);
    expect((ok.result as any).id).toMatch(/^n-job-[a-z0-9]{6}$/);
    const noLead = await call(agent, { command: "create", instructions: "i", task: "t", scheduled_action: { name: "N", id: "n-job", timeToDeliver: "00:07:00", meridiem: "PM" } });
    expect(noLead.isError).toBe(true);
    expect(String(noLead.result)).toContain("startCookingInAdvance");
  });

  it("reports unknown worker tools with the pool, and unknown commands", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const r = await call(agent, { command: "create", instructions: "i", task: "t", tools: ["nope"], scheduled_action: { name: "N", id: "n-job", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10" } });
    expect(String(r.result)).toMatch(/unknown worker tool.*"nope".*recent_news/);
    const scheduledActions = createScheduledActionsTool(agent);
    await expect(scheduledActions.execute({ command: "frobnicate" }, { toolCallId: "t" })).rejects.toThrow(/Unknown command "frobnicate"/);
  });

  it("get/update/delete/run_now/skip need an id; get returns the latest result text", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply("Latest brief text.")).fn);
    for (const command of ["get", "update", "delete", "run_now", "skip"]) {
      const r = await call(agent, { command });
      expect(r.isError).toBe(true);
      expect(String(r.result)).toContain('needs "id"');
    }
    const made = (await call(agent, { command: "create", instructions: "i", task: "t", scheduled_action: { name: "N", id: "n-job", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10" } })).result as any;
    expect(String((await call(agent, { command: "update", id: made.id })).result)).toContain("at least one field");
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.set(19, 0);
    h.s.tick();
    const got = (await call(agent, { command: "get", id: made.id })).result as any;
    expect(got).toMatchObject({ id: made.id, lastRun: { status: "ok" }, latestResult: "Latest brief text." });
    const removed = await call(agent, { command: "delete", id: made.id, purge: true });
    expect(removed.result).toEqual({ ok: true });
    expect(String((await call(agent, { command: "get", id: made.id })).result)).toContain("No scheduled action");
  });

  it("get_datetime returns the local date and time with no timezone", async () => {
    const out = (await getDatetimeTool.execute({}, { toolCallId: "t" })) as string;
    expect(out).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), \d{1,2} [A-Z][a-z]+, \d{2}:\d{2}:\d{2} (AM|PM), \d{4}$/);
    expect(out).not.toMatch(/UTC|GMT|[+-]\d{2}:?\d{2}/);
  });
});

describe("home folder layout", () => {
  it("keeps its files in <home>/scheduled/ and leaves an old scheduled_actions/ or scheduled_tasks/ folder alone", () => {
    const h = harness();
    for (const old of ["scheduled_actions", "scheduled_tasks"]) {
      fs.mkdirSync(path.join(h.home, old), { recursive: true });
      fs.writeFileSync(path.join(h.home, old, "tasks.json"), '{"version":1,"tasks":[{"id":"old"}]}');
    }
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const rec = createScheduledAction(agent, input());
    expect(fs.existsSync(taskFileOf(h.home, rec.id))).toBe(true);
    expect(listScheduledActions({ home: h.home }).map((t) => t.id)).toEqual([rec.id]); // nothing from the old folders
    for (const old of ["scheduled_actions", "scheduled_tasks"]) {
      expect(fs.readFileSync(path.join(h.home, old, "tasks.json"), "utf8")).toContain('"old"'); // untouched, not moved
    }
  });
});

describe("setHome", () => {
  it("moves the default home out of the working directory; an explicit home still wins", async () => {
    const { setHome, resolveHome } = await import("../src/index.ts");
    const dir = path.join(os.tmpdir(), "accel-set-home");
    try {
      setHome(dir);
      expect(resolveHome()).toBe(path.resolve(dir));
      expect(resolveHome("/x/custom")).toBe(path.resolve("/x/custom"));
    } finally {
      setHome();
    }
    expect(resolveHome()).toBe(path.resolve(".agent-accel"));
  });
});

// ---------------------------------------------------------------------------
// The on-disk format is a stable contract: docs/scheduled-action-files.md says what is below.
// ---------------------------------------------------------------------------
describe("scheduled action files (stable contract)", () => {
  const dirOf = (h: Harness): string => path.join(h.home, "scheduled");
  const json = (h: Harness, name: string): any => JSON.parse(fs.readFileSync(path.join(dirOf(h), name), "utf8"));
  const sorted = (o: object): string[] => Object.keys(o).sort();
  const HEADER_ORDER = ["id", "name", "status", "startedAt", "finishedAt", "deliverAt", "late", "model", "turns", "tokens", "inputTokens", "freshInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "thinkingTokens", "cacheHitRate", "costUsd", "costSource", "unpricedTurns"];
  const doc = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "scheduled-action-files.md"), "utf8");

  // The header parser exactly as the page shows it.
  function readRunLikeTheDocs(dir: string, file: string): { header: Record<string, string>; body: string } {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${file} is not a run file`);
    const header = Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
    return { header, body: m[2]!.trimEnd() };
  }

  it("<id>/task.json: the version, the exact fields of a minimal and of a full record, and the states", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const first = createScheduledAction(agent, input());
    const file = json(h, `${first.id}/task.json`);
    expect(Object.keys(file)).toEqual(["version", "task"]);
    expect(file.version).toBe(2);
    expect(sorted(file.task)).toEqual(["agent", "createdAt", "id", "instructions", "name", "nextCookAt", "nextDeliverAt", "schedule", "state", "task", "tools"]);
    expect(sorted(file.task.schedule)).toEqual(["meridiem", "startCookingInAdvance", "timeToDeliver"]);
    expect(file.task.state).toBe("waiting");

    const second = createScheduledAction(agent, input({ id: "full-one", repeatEvery: "01:00:00", retries: 1, onMissed: "run" }, { role: "analyst", timeoutMs: 600_000 }));
    const full = json(h, `${second.id}/task.json`).task;
    expect(sorted(full)).toEqual(["agent", "createdAt", "id", "instructions", "name", "nextCookAt", "nextDeliverAt", "role", "schedule", "state", "task", "timeoutMs", "tools"]);
    expect(sorted(full.schedule)).toEqual(["meridiem", "onMissed", "repeatEvery", "retries", "startCookingInAdvance", "timeToDeliver"]);
    expect(full.id).toMatch(/^full-one-[a-z0-9]{6}$/);
    expect(full.nextDeliverAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/); // local time, no offset
  });

  it("a run's files: current, delivery.json, the run header (keys and order) and lastRun", async () => {
    const h = harness();
    const { of } = capture();
    const rec = createScheduledAction(h.agent(mockFetch(() => chatReply("Result text.")).fn), input());
    h.set(18, 50);
    h.s.tick();
    const taskPath = `${rec.id}/task.json`;
    expect(sorted(json(h, taskPath).task.current)).toEqual(["cookStartedAt", "deliverAt"]); // only while cooking
    await h.settle();
    expect(json(h, taskPath).task.current).toBeUndefined();

    const deliveries = json(h, `${rec.id}/delivery.json`);
    expect(Object.keys(deliveries)).toEqual(["version", "pending"]);
    expect(deliveries.version).toBe(2);
    expect(sorted(deliveries.pending[0])).toEqual(["deliverAt", "file", "id", "readyAt", "status"]);
    expect(deliveries.pending[0].file).toBe(`${rec.id}/26-october-2026.md`);

    const text = fs.readFileSync(path.join(dirOf(h), deliveries.pending[0].file), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    const { header, body } = readRunLikeTheDocs(dirOf(h), deliveries.pending[0].file);
    expect(Object.keys(header)).toEqual(HEADER_ORDER);
    expect(body).toBe("Result text.");
    expect(header).toMatchObject({ status: "ok", late: "false", costUsd: "unknown", costSource: "unknown" });

    h.set(19, 0);
    h.s.tick();
    expect(fs.existsSync(path.join(dirOf(h), rec.id, "delivery.json"))).toBe(false); // nothing waiting: no file
    expect(sorted(json(h, taskPath).task.lastRun)).toEqual(["deliverAt", "deliveredAt", "file", "late", "status"]);
    expect(sorted(of("scheduled_action.delivered")[0]!.data as object)).toEqual(["deliverAt", "file", "id", "late", "name", "readyAt", "status"]);
  });

  it("keeps fields it does not know on rewrite, and keeps the last good copy as .bak", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const rec = createScheduledAction(agent, input());
    editTask(h.home, (t) => void ((t as unknown as Record<string, unknown>)["owner"] = "ops"));
    updateScheduledAction(rec.id, { task: "A new assignment." }, { home: h.home });
    const kept = json(h, `${rec.id}/task.json`).task;
    expect(kept.owner).toBe("ops");
    expect(kept.task).toBe("A new assignment.");
    expect(fs.existsSync(path.join(dirOf(h), rec.id, "task.json.bak"))).toBe(true);
    expect(validateRecord(kept)).toBeUndefined(); // an extra key is not a validation problem
  });

  it("the docs page names every header key, state and event", () => {
    for (const key of HEADER_ORDER) expect(doc).toContain(`\`${key}\``);
    for (const state of ["waiting", "cooking", "missed", "done"]) expect(doc).toContain(`\`${state}\``);
    for (const code of ["created", "updated", "started", "ready", "failed", "delivered", "missed", "skipped", "deleted", "invalid", "store_corrupt", "error"]) {
      expect(doc).toContain(`\`scheduled_action.${code}\``);
    }
    expect(doc).toContain('"version": 2');
  });
});

// ---------------------------------------------------------------------------
// Several schedulers on one home (stand-ins for several processes: all state is in the files)
// ---------------------------------------------------------------------------
describe("several processes on one home", () => {
  // A second scheduler on the same home with its own clock source; in: a test, out: a scheduler that has registered `agent` (or nobody).
  function other(h: Harness, agent?: Agent): Scheduler {
    const { Scheduler: SchedulerClass } = require("../src/scheduler/scheduler.ts") as typeof import("../src/scheduler/scheduler.ts");
    const b = new SchedulerClass(h.home);
    b.tickMs = 3_600_000;
    b.now = () => new Date(h.clock);
    if (agent) b.agents.set(agent.name, new WeakRef(agent));
    return b;
  }
  // Writes the heartbeat a live OTHER process (our parent's pid) would keep; in: a test, out: the .heartbeat file.
  function fakeOwner(h: Harness, id: string, pid = process.ppid): string {
    const file = path.join(h.home, "scheduled", id, ".heartbeat");
    fs.writeFileSync(file, JSON.stringify({ pid, host: os.hostname(), token: "other" }));
    return file;
  }

  it("only a process that owns the Agent starts a run; one that does not leaves it alone until the delivery time has passed", async () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    const agent = h.agent(fn);
    const rec = createScheduledAction(agent, input());
    const stranger = other(h);
    h.set(18, 50);
    stranger.tick();
    expect(readTasks(h.home)[0]!.state).toBe("waiting");
    h.s.tick();
    await h.settle();
    expect(calls).toHaveLength(1);
    expect(readDeliveries(h.home)).toHaveLength(1);
    expect(rec.id).toBeTruthy();
  });

  it("two processes that both own the Agent start the run once", async () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    const agent = h.agent(fn);
    createScheduledAction(agent, input());
    const b = other(h, agent);
    h.set(18, 50);
    h.s.tick();
    b.tick(); // sees it cooking
    await h.settle();
    expect(calls).toHaveLength(1);
  });

  it("a process with a stale view cannot start the next occurrence early", async () => {
    const h = harness();
    const { fn, calls } = mockFetch(() => chatReply());
    const agent = h.agent(fn);
    const rec = createScheduledAction(agent, input({ repeatEvery: "01:00:00" }));
    const b = other(h, agent);
    h.set(18, 50);
    h.s.tick();
    await h.settle(); // finished: waiting again for tomorrow
    expect(readTasks(h.home)[0]).toMatchObject({ state: "waiting", nextDeliverAt: iso(19, 0, 0, 27) });
    (b as any).startCook(rec.id, false); // what a slow process does with the snapshot it took before the run
    expect(calls).toHaveLength(1);
    expect(readTasks(h.home)[0]!.state).toBe("waiting");
  });

  it("a delivery is emitted once even when two processes own the Agent", async () => {
    const h = harness();
    const { of } = capture();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    createScheduledAction(agent, input());
    const b = other(h, agent);
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.set(19, 0);
    h.s.tick();
    b.tick();
    expect(of("scheduled_action.delivered")).toHaveLength(1);
    expect(readTasks(h.home)[0]!.lastRun).toMatchObject({ status: "ok" });
    expect(readDeliveries(h.home)).toEqual([]);
  });

  it("two processes that picked the same saved delivery at the same moment emit it once", async () => {
    const h = harness();
    const { of } = capture();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    createScheduledAction(agent, input());
    const b = other(h, agent);
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.set(19, 0);
    const entry = readDeliveries(h.home)[0]!; // both took this snapshot before either delivered
    (h.s as any).deliver(entry, h.clock);
    (b as any).deliver(entry, h.clock);
    expect(of("scheduled_action.delivered")).toHaveLength(1);
  });

  it("a process that does not own the Agent never takes a delivery", async () => {
    const h = harness();
    const { of } = capture();
    createScheduledAction(h.agent(mockFetch(() => chatReply()).fn), input());
    h.set(18, 50);
    h.s.tick();
    await h.settle();
    h.set(19, 0);
    other(h).tick();
    expect(of("scheduled_action.delivered")).toHaveLength(0);
    expect(readDeliveries(h.home)).toHaveLength(1);
    h.s.tick();
    expect(of("scheduled_action.delivered")).toHaveLength(1);
  });

  it("a marked-missed decision made on a stale view changes nothing and emits nothing", async () => {
    const h = harness();
    const { of } = capture();
    const g = gate();
    const agent = h.agent(mockFetch(async () => (await g.open, chatReply())).fn);
    const rec = createScheduledAction(agent, input());
    h.set(18, 50);
    h.s.tick(); // now cooking
    (other(h, agent) as any).markMissed(rec.id, "process_down", "waiting");
    expect(readTasks(h.home)[0]!.state).toBe("cooking");
    expect(of("scheduled_action.missed")).toHaveLength(0);
    g.release();
    await h.settle();
  });

  it("keeps a heartbeat while a run is in flight, refreshes it, and removes it when the run ends", async () => {
    const h = harness();
    const g = gate();
    const agent = h.agent(mockFetch(async () => (await g.open, chatReply())).fn);
    const rec = createScheduledAction(agent, input());
    h.set(18, 50);
    h.s.tick();
    const file = path.join(h.home, "scheduled", rec.id, ".heartbeat");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, host: os.hostname() });
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(file, old, old);
    h.set(18, 50, 10);
    h.s.tick();
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(5_000); // refreshed by the tick
    g.release();
    await h.settle();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does not recover a cooking run whose owner process is alive and heartbeating", () => {
    const h = harness();
    const { of } = capture();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const rec = createScheduledAction(agent, input());
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
    });
    fakeOwner(h, rec.id);
    const b = other(h, agent);
    h.set(18, 55);
    b.tick();
    expect(readTasks(h.home)[0]!.state).toBe("cooking");
    expect(of("scheduled_action.missed")).toHaveLength(0);
  });

  it("recovers a cooking run whose owner is dead, or whose heartbeat went stale, or that never had one", () => {
    for (const how of ["dead pid", "stale", "none", "own pid, not running it"] as const) {
      const h = harness();
      const agent = h.agent(mockFetch(() => chatReply()).fn);
      const rec = createScheduledAction(agent, input());
      editTask(h.home, (t) => {
        t.state = "cooking";
        t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
      });
      if (how === "dead pid") fakeOwner(h, rec.id, 2 ** 22 + 4242);
      if (how === "own pid, not running it") fakeOwner(h, rec.id, process.pid); // an earlier scheduler of this very process
      if (how === "stale") {
        const file = fakeOwner(h, rec.id);
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(file, old, old);
      }
      const b = other(h, agent);
      h.set(18, 55);
      b.tick();
      expect(readTasks(h.home)[0]!.state, how).toBe("missed");
    }
  });

  it("a live process notices a dead owner without restarting (every 15 s)", () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const rec = createScheduledAction(agent, input());
    h.set(18, 40);
    h.s.tick(); // first tick: nothing to recover
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 40), deliverAt: iso(19, 0) };
    });
    fakeOwner(h, rec.id, 2 ** 22 + 4242);
    h.set(18, 40, 5);
    h.s.tick();
    expect(readTasks(h.home)[0]!.state).toBe("cooking"); // looked 5 s ago: not yet
    h.set(18, 40, 20);
    h.s.tick();
    expect(readTasks(h.home)[0]!.state).toBe("missed");
  });

  it("refuses to delete a run that another live process is cooking, even with force; deletes it once the owner is dead", async () => {
    const h = harness();
    const agent = h.agent(mockFetch(() => chatReply()).fn);
    const rec = createScheduledAction(agent, input());
    editTask(h.home, (t) => {
      t.state = "cooking";
      t.current = { cookStartedAt: iso(18, 50), deliverAt: iso(19, 0) };
    });
    const file = fakeOwner(h, rec.id);
    const refused = await deleteScheduledAction(rec.id, { home: h.home, force: true });
    expect(refused).toMatchObject({ ok: false, reason: "running" });
    expect((refused as { message: string }).message).toContain(`pid ${process.ppid}`);
    expect(readTasks(h.home)).toHaveLength(1);
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 4242, host: os.hostname(), token: "x" }));
    expect(await deleteScheduledAction(rec.id, { home: h.home })).toEqual({ ok: true });
    expect(readTasks(h.home)).toEqual([]);
  });
});
