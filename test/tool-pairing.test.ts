import { describe, it, expect } from "bun:test";
import { AgentContext } from "../src/agent/context.ts";
import { ensureToolPairing } from "../src/agent/loop.ts";

const call = (id: string, name = "t") => ({ id, name, arguments: {} });
const roles = (c: AgentContext) => c.messages.map((m) => m.role);
const resultIds = (c: AgentContext) =>
  c.messages.flatMap((m) => (m.role === "tool" ? (m.content as any[]).map((p) => p.id) : []));

describe("ensureToolPairing", () => {
  it("leaves a healthy history untouched (same array, same messages)", () => {
    const c = new AgentContext();
    c.addUserMessage("go");
    c.addAssistantMessage("", [call("c1")]);
    c.addToolResults([{ id: "c1", name: "t", result: "ok" }]);
    const before = c.messages;
    ensureToolPairing(c);
    expect(c.messages).toBe(before);
  });

  it("after interrupt(): puts the placeholder right behind the call, before the next user message", () => {
    const c = new AgentContext();
    c.addUserMessage("delete the files");
    c.addAssistantMessage("", [call("c1", "rm")]); // tools never ran
    c.addUserMessage("never mind");
    ensureToolPairing(c);
    expect(roles(c)).toEqual(["user", "assistant", "tool", "user"]);
    const placeholder: any = (c.messages[2]!.content as any[])[0];
    expect(placeholder.id).toBe("c1");
    expect(placeholder.isError).toBe(true);
  });

  it("moves a previously misplaced result back behind its call", () => {
    const c = new AgentContext();
    c.addUserMessage("a");
    c.addAssistantMessage("", [call("c1")]);
    c.addUserMessage("b");
    c.addToolResults([{ id: "c1", name: "t", result: "late" }]);
    ensureToolPairing(c);
    expect(roles(c)).toEqual(["user", "assistant", "tool", "user"]);
    expect(((c.messages[2]!.content as any[])[0]).result).toBe("late");
  });

  it("drops orphan results and keeps parallel calls in call order", () => {
    const c = new AgentContext();
    c.addUserMessage("a");
    c.addAssistantMessage("", [call("c1"), call("c2")]);
    c.addToolResults([
      { id: "ghost", name: "t", result: "x" },
      { id: "c2", name: "t", result: "two" },
      { id: "c1", name: "t", result: "one" },
    ]);
    ensureToolPairing(c);
    expect(resultIds(c)).toEqual(["c1", "c2"]);
  });

  it("keeps one result per call when a model reuses the same id", () => {
    const c = new AgentContext();
    c.addUserMessage("a");
    c.addAssistantMessage("", [call("dup"), call("dup")]);
    c.addToolResults([
      { id: "dup", name: "t", result: "first" },
      { id: "dup", name: "t", result: "second" },
    ]);
    ensureToolPairing(c);
    const results = c.messages.filter((m) => m.role === "tool").map((m) => (m.content as any[])[0].result);
    expect(results).toEqual(["first", "second"]);
  });
});
