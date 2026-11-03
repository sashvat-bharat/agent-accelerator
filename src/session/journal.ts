/**
 * Append-only step log for a persisted session (dir mode). `session.json` stays the snapshot; every step after it
 * adds ONE short line to `journal.ndjson` instead of rewriting the whole file, so a long chat costs the same per step
 * as a short one. When history changes any other way (rollback, repair, reset, import) or the journal grows past a
 * limit, a fresh snapshot replaces both. The snapshot carries an `epoch` id and the journal header repeats it, so a
 * journal left over from before a snapshot is ignored on load (see `replayJournal` in `store.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message, ContentPart } from "../types/message.ts";
import { writeFileDurable } from "../utils/durable.ts";
import {
  JOURNAL_FILE,
  buildSessionData,
  embeddedMedia,
  quarantineIfCorrupt,
  serializeSession,
  stripRedundantRawArguments,
  type SessionAgentLike,
} from "./store.ts";

/** A journal past this many lines is folded into a fresh snapshot. */
const MAX_JOURNAL_LINES = 500;
/** A journal past this many bytes is folded into a fresh snapshot. */
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/** Persists one session folder (`sessions/<id>/`) step by step. */
export class SessionJournal {
  /** Epoch of the snapshot the journal belongs to; unset until the first snapshot (and after a failed append). */
  private epoch: string | undefined;
  /** How many messages are on disk, and the last one (identity check: history only grew since the last sync). */
  private count = 0;
  private last: Message | undefined;
  private lines = 0;
  private bytes = 0;
  /** JSON of the last written non-message state (config, system prompt, worker traces). */
  private meta = "";
  /** Disk form of each message already prepared (media replaced by `media/` files, redundant raw arguments dropped). */
  private readonly onDisk = new WeakMap<Message, Message>();

  constructor(readonly dir: string) {}

  // Brings the folder up to date with the agent: appends new messages and changed state, or writes a fresh snapshot when history changed another way; in: Agent.doPersist after every step, out: files in this.dir.
  sync(agent: SessionAgentLike): void {
    const messages = agent.context.messages;
    const grew = this.epoch !== undefined && messages.length >= this.count && (this.count === 0 || messages[this.count - 1] === this.last);
    if (!grew) {
      this.snapshot(agent);
      return;
    }
    const records: string[] = [];
    for (let i = this.count; i < messages.length; i++) records.push(JSON.stringify({ t: "msg", i, m: this.toDisk(messages[i]!) }));
    const meta = this.metaOf(agent);
    if (meta !== this.meta) records.push(`{"t":"meta","m":${meta}}`);
    if (records.length === 0) return;
    const text = records.join("\n") + "\n";
    try {
      const fd = fs.openSync(path.join(this.dir, JOURNAL_FILE), "a", 0o600);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.epoch = undefined; // a half-written line may be on disk: the next sync starts over with a snapshot
      throw err;
    }
    this.count = messages.length;
    this.last = messages[messages.length - 1];
    this.meta = meta;
    this.lines += records.length;
    this.bytes += text.length;
    if (this.lines >= MAX_JOURNAL_LINES || this.bytes >= MAX_JOURNAL_BYTES) this.snapshot(agent);
  }

  // Writes `session.json` (new epoch) and then restarts the journal under that epoch; a crash in between leaves a journal with the old epoch, which load ignores; in: sync, out: both files.
  private snapshot(agent: SessionAgentLike): void {
    const messages = agent.context.messages;
    const epoch = randomUUID();
    const target = path.join(this.dir, "session.json");
    if (this.epoch === undefined) quarantineIfCorrupt(target);
    const data = buildSessionData({ ...agent, context: { ...agent.context, messages: messages.map((m) => this.toDisk(m)) } }, null);
    writeFileDurable(target, serializeSession({ ...data, epoch }) + "\n");
    writeFileDurable(path.join(this.dir, JOURNAL_FILE), JSON.stringify({ t: "base", e: epoch }) + "\n", { backup: false });
    this.epoch = epoch;
    this.count = messages.length;
    this.last = messages[messages.length - 1];
    this.lines = 0;
    this.bytes = 0;
    this.meta = this.metaOf(agent);
  }

  // JSON of everything in the snapshot that is not a message, identity or totals; in: the live agent, out: change detection + the `meta` record.
  private metaOf(agent: SessionAgentLike): string {
    const { version: _v, sessionId: _s, messages: _m, totals: _t, ...rest } = buildSessionData(
      { ...agent, context: { ...agent.context, messages: [] } },
      null
    );
    return JSON.stringify(rest);
  }

  // The form of a message that goes to disk: embedded media written once as `media/<kind>-h<hash>.<ext>` (content-addressed, never deleted or renumbered), redundant raw arguments dropped; in: a live message, out: journal lines and snapshots.
  private toDisk(message: Message): Message {
    const known = this.onDisk.get(message);
    if (known) return known;
    const slim = stripRedundantRawArguments([message])[0]!;
    let out = slim;
    if (Array.isArray(slim.content)) {
      let changed = false;
      const content = (slim.content as ContentPart[]).map((part) => {
        const found = embeddedMedia(part);
        if (!found) return part;
        const file = `${found.key}-h${createHash("sha256").update(found.bytes).digest("hex").slice(0, 16)}.${found.ext}`;
        const dest = path.join(this.dir, "media", file);
        if (!fs.existsSync(dest)) writeFileDurable(dest, found.bytes, { backup: false });
        changed = true;
        return { ...(part as unknown as Record<string, unknown>), [found.key]: `media/${file}`, ...(found.mimeType ? { mimeType: found.mimeType } : {}) } as unknown as ContentPart;
      });
      if (changed) out = { ...slim, content };
    }
    this.onDisk.set(message, out);
    return out;
  }
}
