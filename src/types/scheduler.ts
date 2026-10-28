/** Lifecycle of a scheduled action as stored in `tasks.json`. */
export type ScheduledState = "waiting" | "cooking" | "missed" | "done";

/** Outcome of one run. */
export type ScheduledRunStatus = "ok" | "failed";

/** Schedule fields shared by `create` input and the stored record. */
export interface ScheduleSpec {
  /** Delivery clock time `DD:HH:MM`: `DD` days from today, `HH:MM` on a 12-hour clock (see `meridiem`). */
  timeToDeliver: string;
  meridiem: "AM" | "PM";
  /** Duration `DD:HH:MM` before delivery at which the run starts. Default 10 minutes (`00:00:10`). */
  startCookingInAdvance?: string;
  /** Duration `DD:HH:MM` between deliveries (`01:00:00` daily). Omit to run once. */
  repeatEvery?: string;
  /** Extra attempts if a run fails, only while time remains before delivery. Default 0. */
  retries?: number;
}

/** What `createScheduledAction` receives: dynamic sub-agent fields plus the schedule. */
export interface ScheduledActionInput {
  role?: string;
  instructions: string;
  task: string;
  /** Names from the developer's `dynamicSubagents.tools` pool. */
  tools?: string[];
  timeoutMs?: number;
  scheduled_action: ScheduleSpec & {
    /** Human label. */
    name: string;
    /** Lowercase kebab-case, max 48 chars. The SDK appends 6 random chars. */
    id: string;
  };
}

/** What `updateScheduledAction` may change. `id` and the creating agent are immutable. */
export type ScheduledActionPatch = Partial<Omit<ScheduledActionInput, "scheduled_action">> & {
  scheduled_action?: Partial<Omit<ScheduledActionInput["scheduled_action"], "id">>;
};

/** One entry of `tasks.json`. All times are local clock strings `YYYY-MM-DDTHH:mm:ss` (no offset). */
export interface ScheduledActionRecord {
  id: string;
  name: string;
  /** Name of the creating Agent; it runs the worker. */
  agent: string;
  role?: string;
  instructions: string;
  task: string;
  /** Tool NAMES only; resolved against the live agent's pool at run time. */
  tools: string[];
  timeoutMs?: number;
  /** The schedule as given. The stored truth is `nextCookAt` / `nextDeliverAt`. */
  schedule: ScheduleSpec & { startCookingInAdvance: string };
  state: ScheduledState;
  /** `null` for a finished one-shot. */
  nextCookAt: string | null;
  nextDeliverAt: string | null;
  createdAt: string;
  /** Present only while `state` is `cooking`. */
  current?: { cookStartedAt: string; deliverAt: string };
  lastRun?: { status: ScheduledRunStatus; file: string; deliverAt: string; deliveredAt: string; late: boolean };
}

/** Payload of the `scheduled_action.delivered` telemetry event. Plain JSON. */
export interface ScheduledDelivery {
  id: string;
  name: string;
  status: ScheduledRunStatus;
  /** Absolute path of the run file. */
  file: string;
  readyAt: string;
  deliverAt: string;
  late: boolean;
}

/** Result of `killScheduledAction`. */
export type KillResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "running"; message: string };
