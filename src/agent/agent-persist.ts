/**
 * Saving of one Agent's session: the coalesced `persistNow` gate and the synchronous write behind it (folder journal or
 * single file). `Agent.persistNow` and `Agent.doPersist` call these.
 */
import type { Agent } from "./agent.ts";
import { saveSessionFile, sessionDirFor } from "../session/store.ts";
import { SessionJournal } from "../session/journal.ts";

// The step journal of the agent's session folder, recreated when `sessionId` changes; in: doPersist, out: the journal.
function journalFor(agent: Agent, root: string): SessionJournal {
  const dir = sessionDirFor(root, agent.sessionId);
  if (agent.journal?.dir !== dir) agent.journal = new SessionJournal(dir);
  return agent.journal;
}

// True when this agent saves its session at all (`persist` set, and not a stateless agent unless allowed); in: persistNow and doPersist, out: a boolean.
function shouldPersist(agent: Agent): boolean {
  const cfg = agent.persistConfig;
  if (!cfg || (!cfg.dir && !cfg.file)) return false;
  try {
    if (agent.stateless && !cfg.allowStateless) return false;
  } catch {}
  return true;
}

/** Schedules one save for the end of the current tick (calls in the same tick coalesce); in: `Agent.persistNow`, out: a microtask that runs `doPersist`. */
export function persistNow(agent: Agent): void {
  if (!shouldPersist(agent) || agent.persistScheduled) return;
  agent.persistScheduled = true;
  queueMicrotask(() => {
    agent.persistScheduled = false;
    doPersist(agent);
  });
}

/** Writes the session now (journal sync in folder mode, else a snapshot file); a failure goes to `persist.onPersistError` and never throws; in: `Agent.doPersist`, out: files on disk. */
export function doPersist(agent: Agent): void {
  if (!shouldPersist(agent)) return;
  const cfg = agent.persistConfig!;
  try {
    if (cfg.dir) journalFor(agent, cfg.dir).sync(agent);
    else if (cfg.file) saveSessionFile(cfg.file, agent, null);
  } catch (err) {
    try {
      cfg.onPersistError?.(err);
    } catch {}
  }
}
