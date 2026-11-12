/**
 * The named in-memory sessions of one Agent (`run(prompt, { sessionId })`, `agent.session(id)`): one `AgentContext` per
 * id, at most 100 kept (least recently used goes first) and dropped after an hour idle. The Agent's own session is
 * never kept here: it is its default context.
 */
import { AgentContext } from "./context.ts";
import { clearSessionRouting } from "../providers.ts";
import { clearInteractionChains } from "../providers/google.ts";

/** Max named sessions kept per Agent (LRU). */
const SESSION_LRU_MAX = 100;
/** Idle TTL for named sessions. */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** The named sessions of one Agent. */
export class NamedSessions {
  private readonly entries = new Map<string, { context: AgentContext; lastAccess: number }>();

  constructor(
    private readonly defaultId: () => string,
    private readonly defaultContext: () => AgentContext,
    private readonly create: () => AgentContext
  ) {}

  // Forgets a session's provider chain and routing state; in: every removal below, out: nothing.
  private forget(id: string): void {
    try {
      clearInteractionChains(id);
    } catch {}
    try {
      clearSessionRouting(id);
    } catch {}
  }

  /** The context for `sessionId` (the default session gives the Agent's own context); expired ones are dropped and the oldest is evicted past the limit. */
  contextFor(sessionId?: string): AgentContext {
    const sid = sessionId || this.defaultId();
    if (sid === this.defaultId()) return this.defaultContext();
    const now = Date.now();
    try {
      for (const [key, entry] of [...this.entries]) {
        if (now - entry.lastAccess > SESSION_TTL_MS) {
          this.entries.delete(key);
          this.forget(key);
        }
      }
    } catch {}
    const existing = this.entries.get(sid);
    if (existing) {
      existing.lastAccess = now;
      return existing.context;
    }
    const fresh = this.create();
    this.entries.set(sid, { context: fresh, lastAccess: now });
    try {
      while (this.entries.size > SESSION_LRU_MAX) {
        let oldest: string | undefined;
        let oldestTs = Infinity;
        for (const [key, entry] of this.entries) {
          if (entry.lastAccess < oldestTs) {
            oldestTs = entry.lastAccess;
            oldest = key;
          }
        }
        if (!oldest) break;
        this.entries.delete(oldest);
        this.forget(oldest);
      }
    } catch {}
    return fresh;
  }

  /** Drops one session and its provider state; no-op for an unknown id. */
  dispose(id: string): void {
    try {
      this.entries.delete(id);
    } catch {}
    this.forget(id);
  }

  /** Drops every named session. */
  clear(): void {
    try {
      for (const id of [...this.entries.keys()]) this.forget(id);
      this.entries.clear();
    } catch {}
  }

  /** The ids of the named sessions held now. */
  ids(): string[] {
    return [...this.entries.keys()];
  }
}
