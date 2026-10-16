import { describe, expect, it, vi } from "vitest";
import { botRequestBoundaries, crossesExplicitStop } from "./bot-message-stop-boundary.js";

function fixture() {
  const runs = new Map([
    [
      "root",
      {
        id: "root",
        botId: "a",
        threadId: "ta",
        status: "completed",
        trigger: "user",
        sourceMessageId: null,
        thread: { botId: "a" },
      },
    ],
    [
      "bridge",
      {
        id: "bridge",
        botId: "b",
        threadId: "tb",
        status: "completed",
        trigger: "bot_message",
        sourceMessageId: "in-b",
        thread: { botId: "b" },
      },
    ],
    [
      "child",
      {
        id: "child",
        botId: "c",
        threadId: "tc",
        status: "completed",
        trigger: "bot_message",
        sourceMessageId: "in-c",
        thread: { botId: "c" },
      },
    ],
  ]);
  const messages = new Map<string, Record<string, unknown>>();
  for (const [parent, child, from, to] of [
    ["root", "bridge", "a", "b"],
    ["bridge", "child", "b", "c"],
  ]) {
    messages.set(`in-${to}`, {
      id: `in-${to}`,
      runId: child,
      threadId: `t${to}`,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: from,
          text: "work",
          returnToMessageId: `out-${to}`,
        },
      ],
    });
    messages.set(`out-${to}`, {
      id: `out-${to}`,
      runId: parent,
      threadId: `t${from}`,
      role: "bot",
      botId: from,
      seq: 7,
      blocks: [{ kind: "bot_message_sent", toBotId: to, text: "work" }],
    });
  }
  const db = {
    run: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => messages.get(where.id) ?? null,
      ),
    },
    event: {
      findFirst: vi.fn(async ({ where }: { where: { threadId: string } }) =>
        where.threadId === "ta" ? { payload: { stopThroughMessageSeq: 7 } } : null,
      ),
    },
  };
  return { db, runs, messages };
}
const owner = { spaceId: "space", userId: "owner" };

describe("automatic outcome Stop boundary", () => {
  it("finds a root Stop through a terminal bridge using exact legacy request pairs", async () => {
    const { db } = fixture();
    const ancestry = await botRequestBoundaries(db as never, owner, "child");
    expect(ancestry).toEqual([
      { threadId: "tb", seq: 7 },
      { threadId: "ta", seq: 7 },
    ]);
    expect(await crossesExplicitStop(db as never, ancestry!)).toBe(true);
    for (const [query] of db.run.findFirst.mock.calls) expect(query.where).toMatchObject(owner);
  });
  it.each(["automatic", "fyi", "result", "status"])(
    "keeps a new request after %s communication deliverable with the correct boundary",
    async (mode) => {
      const { db, runs, messages } = fixture();
      runs.set("continuation", {
        id: "continuation",
        botId: "b",
        threadId: "tb",
        status: "completed",
        trigger: "bot_message",
        sourceMessageId: "in-continuation",
        thread: { botId: "b" },
      });
      runs.set("delegate", {
        id: "delegate",
        botId: "d",
        threadId: "td",
        status: "completed",
        trigger: "bot_message",
        sourceMessageId: "in-d",
        thread: { botId: "d" },
      });
      messages.set("in-continuation", {
        runId: "continuation",
        threadId: "tb",
        role: "user",
        clientNonce: mode === "automatic" ? "bot-message:auto-outcome:child" : "manual",
        replyToMessageId: "out-c",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "c",
            text: "answer",
            intent: mode === "automatic" ? "result" : mode,
            returnToMessageId: "out-continuation",
          },
        ],
      });
      messages.set("out-continuation", {
        runId: "child",
        threadId: "tc",
        role: "bot",
        botId: "c",
        seq: 9,
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "b",
            text: "answer",
            intent: mode === "automatic" ? "result" : mode,
          },
        ],
      });
      messages.set("in-d", {
        runId: "delegate",
        threadId: "td",
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "b",
            text: "new work",
            returnToMessageId: "out-d",
          },
        ],
      });
      messages.set("out-d", {
        runId: "continuation",
        threadId: "tb",
        role: "bot",
        botId: "b",
        seq: 12,
        blocks: [{ kind: "bot_message_sent", toBotId: "d", text: "new work" }],
      });
      const ancestry = await botRequestBoundaries(db as never, owner, "delegate");
      expect(ancestry).not.toBeNull();
      expect(ancestry![0]).toEqual({ threadId: "tb", seq: 12 });
      db.event.findFirst.mockResolvedValue(null);
      expect(await crossesExplicitStop(db as never, ancestry!)).toBe(false);
      db.event.findFirst.mockImplementation(async ({ where }) =>
        where.threadId === "ta" ? { payload: { stopThroughMessageSeq: 7 } } : null,
      );
      expect(await crossesExplicitStop(db as never, ancestry!)).toBe(mode === "automatic");
      db.event.findFirst.mockImplementation(async ({ where }) =>
        where.threadId === "tb" ? { payload: { stopThroughMessageSeq: 12 } } : null,
      );
      expect(await crossesExplicitStop(db as never, ancestry!)).toBe(true);
      if (mode === "automatic") {
        messages.get("in-continuation")!.replyToMessageId = "wrong-request";
        expect(await botRequestBoundaries(db as never, owner, "delegate")).toBeNull();
      }
    },
  );
  it("rejects cleared, foreign, mismatched and cyclic request ancestry", async () => {
    const cleared = fixture();
    cleared.messages.delete("out-b");
    expect(await botRequestBoundaries(cleared.db as never, owner, "child")).toBeNull();
    const foreign = fixture();
    foreign.runs.delete("root");
    expect(await botRequestBoundaries(foreign.db as never, owner, "child")).toBeNull();
    const mismatched = fixture();
    mismatched.messages.get("out-b")!.botId = "other";
    expect(await botRequestBoundaries(mismatched.db as never, owner, "child")).toBeNull();
    const cyclic = fixture();
    cyclic.runs.get("root")!.trigger = "bot_message";
    cyclic.runs.get("root")!.sourceMessageId = "in-a" as never;
    cyclic.messages.set("in-a", {
      runId: "root",
      threadId: "ta",
      role: "user",
      blocks: [
        { kind: "bot_message_received", fromBotId: "c", text: "work", returnToMessageId: "out-a" },
      ],
    });
    cyclic.messages.set("out-a", {
      runId: "child",
      threadId: "tc",
      role: "bot",
      botId: "c",
      seq: 8,
      blocks: [{ kind: "bot_message_sent", toBotId: "a", text: "work" }],
    });
    expect(await botRequestBoundaries(cyclic.db as never, owner, "child")).toBeNull();
  });
  it.each([null, {}, "fyi", "status", "result"])(
    "rejects non-request or malformed intent %j",
    async (intent) => {
      const { db, messages } = fixture();
      (messages.get("in-c")!.blocks as Array<Record<string, unknown>>)[0]!.intent = intent;
      expect(await botRequestBoundaries(db as never, owner, "child")).toBeNull();
    },
  );
});
