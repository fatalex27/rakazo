import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, Run } from "@rakazo/db";
import { createDb, createThreadMessageInTransaction } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  messageBot,
  returnBotMessageOutcome,
} from "../../../packages/adapters/src/bot-messages.js";
import { linkedBotRequestRuns } from "./linked-bot-runs.js";
import type { ThreadTarget } from "./thread-target.js";
import { stopThreadRuns } from "./thread-target.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = enabled ? describe.sequential : describe.skip;

describePostgres("linked bot request cancellation (PostgreSQL contract)", () => {
  let db: ReturnType<typeof createDb>;
  let fixtureId: string;
  let actor: Actor;
  let bots: Array<{ id: string; threadId: string; spaceId: string; userId: string }>;
  const notify = vi.fn(async () => {});
  beforeEach(async () => {
    fixtureId = `linked-stop-${randomUUID()}`;
    db = createDb(process.env.DATABASE_URL!, { poolMax: 6 });
    bots = [];
    for (const suffix of ["owned", "foreign"]) {
      const id = `${fixtureId}-${suffix}`;
      await db.prisma.user.create({
        data: { id, name: "Fixture", email: `${id}@example.invalid` },
      });
      await db.prisma.organization.create({
        data: { id, name: "Fixture", slug: id, createdAt: new Date() },
      });
      await db.prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
      const owner = { userId: id, spaceId: id } as Actor;
      if (suffix === "owned") actor = owner;
      for (let index = 0; index < (suffix === "owned" ? 4 : 1); index += 1) {
        const bot = await db.prisma.bot.create({
          data: { spaceId: id, userId: id, name: `${suffix}-${index}`, color: "fixture" },
        });
        const thread = await db.prisma.thread.create({
          data: { spaceId: id, userId: id, botId: bot.id },
        });
        bots.push({ id: bot.id, threadId: thread.id, spaceId: id, userId: id });
      }
    }
    notify.mockClear();
  });
  afterEach(async () => {
    try {
      for (const suffix of ["owned", "foreign"]) {
        const id = `${fixtureId}-${suffix}`;
        await db.prisma.organization.deleteMany({ where: { id } });
        await db.prisma.user.deleteMany({ where: { id } });
      }
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function runFor(index: number, status = "running", trigger = "bot_message"): Promise<Run> {
    const bot = bots[index]!;
    const task = await db.prisma.task.create({
      data: {
        spaceId: bot.spaceId,
        userId: bot.userId,
        botId: bot.id,
        threadId: bot.threadId,
        status,
        prompt: "Fixture work",
      },
    });
    return db.prisma.run.create({
      data: {
        spaceId: bot.spaceId,
        userId: bot.userId,
        botId: bot.id,
        threadId: bot.threadId,
        taskId: task.id,
        status,
        trigger,
        leaseOwner: status === "running" ? "fixture-worker" : null,
        leaseFence: 1,
      },
    });
  }
  async function link(
    parent: Run,
    child: Run,
    intent: "request" | "question" | "fyi" | "status" | "result" = "request",
  ) {
    return db.prisma.$transaction(async (tx) => {
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: parent.threadId,
        runId: parent.id,
        botId: parent.botId,
        role: "bot",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: child.botId,
            toBotName: "Fixture",
            text: "Work",
            intent,
          },
        ],
      });
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: child.threadId,
        runId: child.id,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: parent.botId,
            fromBotName: "Fixture",
            text: "Work",
            intent,
            returnToMessageId: outbound.id,
            hop: 1,
          },
        ],
      });
      await tx.run.update({ where: { id: child.id }, data: { sourceMessageId: inbound.id } });
      return { outbound, inbound };
    });
  }
  const target = (index = 0) =>
    ({
      kind: "bot",
      botId: bots[index]!.id,
      threadId: bots[index]!.threadId,
      bot: { computer: null },
    }) as ThreadTarget;
  const stop = (prisma = db.prisma) =>
    stopThreadRuns({ prisma, sandbox: {} as never, events: { notify } as never }, actor, target());
  const graph = () =>
    db.prisma.$transaction((tx) => linkedBotRequestRuns(tx, actor, bots[0]!.threadId));

  it("traverses terminal request bridges and stops only owned unfinished request/question work", async () => {
    const parent = await runFor(0, "completed", "user");
    const bridge = await runFor(1, "completed");
    await link(parent, bridge);
    const child = await runFor(2);
    await link(bridge, child, "question");
    const unrelated = await runFor(3, "running", "user");
    const foreign = await runFor(4);
    await link(parent, foreign);
    const ignored: Run[] = [];
    for (const intent of ["fyi", "status", "result"] as const) {
      const run = await runFor(3);
      ignored.push(run);
      await link(parent, run, intent);
    }
    const result = await db.prisma.message.create({
      data: {
        threadId: bridge.threadId,
        runId: bridge.id,
        botId: bridge.botId,
        role: "bot",
        seq: 10,
        blocks: [{ kind: "text", text: "Verified completed result" }],
      },
    });
    expect(new Set((await graph()).map((run) => run.id))).toEqual(new Set([child.id]));
    await stop();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
      "cancelled",
    );
    for (const run of [parent, bridge, unrelated, foreign, ...ignored])
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        run.status,
      );
    expect(await db.prisma.message.findUnique({ where: { id: result.id } })).not.toBeNull();
    expect(notify).toHaveBeenCalledWith(child.threadId, expect.any(Number));
    expect(
      await db.prisma.event.findFirst({
        where: { runId: child.id, threadId: child.threadId, type: "run.cancelled" },
      }),
    ).not.toBeNull();
  });
  it("excludes malformed and unpaired ancestry without trusting JSON claims", async () => {
    const parent = await runFor(0, "completed", "user");
    const malformed = await runFor(1);
    const pair = await link(parent, malformed);
    await db.prisma.message.update({
      where: { id: pair.inbound.id },
      data: { blocks: { kind: "bot_message_received" } },
    });
    const mismatched = await runFor(2);
    const other = await link(parent, mismatched);
    await db.prisma.message.update({
      where: { id: other.inbound.id },
      data: {
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "forged",
            fromBotName: "Fixture",
            text: "Work",
            intent: "request",
            returnToMessageId: other.outbound.id,
          },
        ],
      },
    });
    const ordinary = await runFor(3, "running", "user");
    await link(parent, ordinary);
    expect(await graph()).toEqual([]);
    await stop();
    for (const run of [malformed, mismatched, ordinary])
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "running",
      );
  });
  it("fails closed on a corrupted cyclic chain without partially stopping work", async () => {
    const parent = await runFor(0);
    const child = await runFor(1);
    await link(parent, child);
    await link(child, parent);
    await expect(stop()).rejects.toMatchObject({ code: "CONFLICT" });
    for (const run of [parent, child])
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "running",
      );
    expect(
      await db.prisma.event.count({ where: { spaceId: actor.spaceId, type: "run.cancelled" } }),
    ).toBe(0);
  });
  it("fails closed when the linked node limit is exceeded", async () => {
    const bot = bots[0]!;
    const rows = Array.from({ length: 1025 }, () => ({
      id: randomUUID(),
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      threadId: bot.threadId,
      status: "queued",
      prompt: "Fixture",
    }));
    await db.prisma.task.createMany({ data: rows });
    await db.prisma.run.createMany({
      data: rows.map(({ prompt: _prompt, id, ...row }) => ({
        ...row,
        id: randomUUID(),
        taskId: id,
        trigger: "user",
      })),
    });
    await expect(stop()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.prisma.run.count({ where: { spaceId: actor.spaceId, status: "queued" } })).toBe(
      1025,
    );
  });
  it("stops a new linked child despite more than 1024 completed historical root runs", async () => {
    const bot = bots[0]!;
    const tasks = Array.from({ length: 1025 }, () => ({
      id: randomUUID(),
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      threadId: bot.threadId,
      status: "completed",
      prompt: "Historical fixture",
    }));
    await db.prisma.task.createMany({ data: tasks });
    await db.prisma.run.createMany({
      data: tasks.map(({ prompt: _prompt, id, ...row }) => ({
        ...row,
        id: randomUUID(),
        taskId: id,
        trigger: "user",
        completedAt: new Date(),
      })),
    });
    const parent = await runFor(0, "completed", "user");
    const child = await runFor(1);
    await link(parent, child);
    await stop();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await db.prisma.run.count({ where: { threadId: bot.threadId, status: "completed" } }),
    ).toBe(1026);
  });
  it("ignores fully terminal old deep and cyclic ancestry when stopping current work", async () => {
    const history: Run[] = [];
    for (let index = 0; index < 10; index += 1) {
      const run = await runFor(index % 4, "completed");
      history.push(run);
      if (index) await link(history[index - 1]!, run);
    }
    await link(history.at(-1)!, history[0]!);
    const current = await runFor(0, "running", "user");
    await stop();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: current.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await db.prisma.run.count({
        where: { id: { in: history.map((run) => run.id) }, status: "completed" },
      }),
    ).toBe(10);
  });
  it("does not let unrelated active cyclic or deep work block Stop", async () => {
    const unrelated: Run[] = [];
    for (let index = 0; index < 10; index += 1) {
      const run = await runFor(1 + (index % 3));
      unrelated.push(run);
      if (index) await link(unrelated[index - 1]!, run);
    }
    await link(unrelated.at(-1)!, unrelated[0]!);
    const current = await runFor(0, "running", "user");
    await stop();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: current.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await db.prisma.run.count({
        where: { id: { in: unrelated.map((run) => run.id) }, status: "running" },
      }),
    ).toBe(10);
  });
  it("accepts omitted legacy request intent but rejects null and object intents", async () => {
    const parent = await runFor(0, "completed", "user");
    const children: Run[] = [];
    for (const intent of [undefined, null, { invalid: true }]) {
      const child = await runFor(1);
      const pair = await link(parent, child);
      for (const message of [pair.inbound, pair.outbound]) {
        const blocks = message.blocks as Array<Record<string, unknown>>;
        if (intent === undefined) delete blocks[0]!.intent;
        else blocks[0]!.intent = intent;
        await db.prisma.message.update({
          where: { id: message.id },
          data: { blocks: blocks as never },
        });
      }
      children.push(child);
    }
    await stop();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: children[0]!.id } })).status).toBe(
      "cancelled",
    );
    for (const child of children.slice(1))
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
        "running",
      );
  });
  it("preserves a saved terminal result and suppresses nested automatic wakes after root Stop", async () => {
    const parent = await runFor(0, "completed", "user");
    const bridge = await runFor(1, "completed");
    await link(parent, bridge);
    const child = await runFor(2, "completed");
    await link(bridge, child);
    const final = await db.prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: child.threadId,
        runId: child.id,
        botId: child.botId,
        role: "bot",
        blocks: [{ kind: "text", text: "Persisted final answer" }],
      }),
    );
    await stop();
    const jobs = { enqueue: vi.fn(async () => {}) };
    const messageDeps = { prisma: db.prisma, events: { notify }, jobs };
    const storedChild = await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } });
    expect(
      await returnBotMessageOutcome(
        messageDeps as never,
        storedChild,
        { id: child.botId, name: "Child" },
        "Persisted final answer",
      ),
    ).toBe(true);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(await db.prisma.run.count({ where: { spaceId: actor.spaceId } })).toBe(3);
    expect((await db.prisma.message.findUniqueOrThrow({ where: { id: final.id } })).blocks).toEqual(
      [{ kind: "text", text: "Persisted final answer" }],
    );
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).botOutcomeReturnedAt,
    ).not.toBeNull();
    // A distinct request after the marker has a larger message sequence, even in the same millisecond.
    const replacement = await runFor(0, "completed", "user");
    const newChild = await runFor(1, "completed");
    await link(replacement, newChild);
    expect(
      await returnBotMessageOutcome(
        messageDeps as never,
        await db.prisma.run.findUniqueOrThrow({ where: { id: newChild.id } }),
        { id: newChild.botId, name: "Child" },
        "Replacement answer",
      ),
    ).toBe(true);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
  });
  it.each(["result", "status"] as const)(
    "cancels a nested automatic %s committed before Stop while preserving unrelated manual results",
    async (intent) => {
      const parent = await runFor(0, "completed", "user");
      const bridge = await runFor(1, "completed");
      await link(parent, bridge);
      const child = await runFor(2, "completed");
      await link(bridge, child);
      const unrelated = await runFor(3, "completed", "user");
      const manualResult = await runFor(1, "queued");
      await link(unrelated, manualResult, "result");
      const jobs = { enqueue: vi.fn(async () => {}) };
      const messageDeps = { prisma: db.prisma, events: { notify }, jobs };
      expect(
        await returnBotMessageOutcome(
          messageDeps as never,
          await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } }),
          { id: child.botId, name: "Child" },
          "Completed nested answer",
          intent,
        ),
      ).toBe(true);
      const outcomeMessage = await db.prisma.message.findUniqueOrThrow({
        where: {
          threadId_clientNonce: {
            threadId: bridge.threadId,
            clientNonce: `bot-message:auto-outcome:${child.id}`,
          },
        },
      });
      expect(outcomeMessage.runId).not.toBeNull();
      await stop();
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: outcomeMessage.runId! } })).status,
      ).toBe("cancelled");
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: manualResult.id } })).status,
      ).toBe("queued");
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
        "completed",
      );
      expect(
        await db.prisma.message.findUnique({ where: { id: outcomeMessage.id } }),
      ).not.toBeNull();
    },
  );
  it.each(["automatic", "fyi", "result", "status"] as const)(
    "returns a new delegation after a valid %s continuation and keeps its Stop lineage",
    async (mode) => {
      const parent = await runFor(0, "completed", "user");
      const bridge = await runFor(1, "completed");
      await link(parent, bridge);
      const child = await runFor(2, "completed");
      await link(bridge, child);
      const jobs = { enqueue: vi.fn(async () => {}) };
      const messageDeps = { prisma: db.prisma, events: { notify }, jobs };
      const storedChild = await db.prisma.run.findUniqueOrThrow({ where: { id: child.id } });
      if (mode === "automatic")
        await returnBotMessageOutcome(
          messageDeps as never,
          storedChild,
          { id: child.botId, name: "Child" },
          "First answer",
        );
      else
        await messageBot(
          messageDeps as never,
          storedChild,
          { id: child.botId, name: "Child" },
          {
            bot_id: bridge.botId,
            message: "Independent communication",
            intent: mode,
            deliveryKey: "manual-continuation",
          },
          { allowTerminalSource: true },
        );
      const continuation = await db.prisma.run.findFirstOrThrow({
        where: { botId: bridge.botId, status: "queued" },
      });
      await db.prisma.run.update({ where: { id: continuation.id }, data: { status: "running" } });
      await messageBot(
        messageDeps as never,
        continuation,
        { id: bridge.botId, name: "Bridge" },
        { bot_id: bots[3]!.id, message: "New explicit delegation" },
      );
      const delegate = await db.prisma.run.findFirstOrThrow({
        where: { botId: bots[3]!.id, status: "queued" },
      });
      await db.prisma.run.update({ where: { id: continuation.id }, data: { status: "completed" } });
      await db.prisma.run.update({ where: { id: delegate.id }, data: { status: "completed" } });
      jobs.enqueue.mockClear();
      // No Stop: even the result continuation can delegate and receive its answer.
      expect(
        await returnBotMessageOutcome(
          messageDeps as never,
          delegate,
          { id: delegate.botId, name: "Delegate" },
          "New delegated answer",
        ),
      ).toBe(true);
      expect(jobs.enqueue).toHaveBeenCalledOnce();
      // A second terminal delegation lets us observe the original ancestor marker.
      const second = await runFor(3, "completed");
      await link(continuation, second);
      await stop();
      jobs.enqueue.mockClear();
      expect(
        await returnBotMessageOutcome(
          messageDeps as never,
          await db.prisma.run.findUniqueOrThrow({ where: { id: second.id } }),
          { id: second.botId, name: "Delegate" },
          "Second answer",
        ),
      ).toBe(true);
      expect(jobs.enqueue).toHaveBeenCalledTimes(mode === "automatic" ? 0 : 1);
    },
  );
  it("serializes Stop against request dispatch and allows an explicit new instruction afterwards", async () => {
    const parent = await runFor(0, "running", "user");
    const jobs = { enqueue: vi.fn(async () => {}) };
    const messageDeps = { prisma: db.prisma, events: { notify }, jobs };
    await Promise.all([
      stop(),
      messageBot(
        messageDeps as never,
        parent,
        { id: parent.botId, name: "Parent" },
        { bot_id: bots[1]!.id, message: "Original instruction", deliveryKey: "original" },
      ),
    ]);
    const oldGraph = await graph();
    expect(
      await db.prisma.run.count({
        where: {
          id: { in: oldGraph.map((run) => run.id) },
          status: { in: ["queued", "running", "leased", "waiting_input", "waiting_takeover"] },
        },
      }),
    ).toBe(0);
    const replacement = await runFor(0, "running", "user");
    expect(
      await messageBot(
        messageDeps as never,
        replacement,
        { id: replacement.botId, name: "Parent" },
        {
          bot_id: bots[1]!.id,
          message: "Explicit replacement instruction",
          deliveryKey: "replacement",
        },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await db.prisma.run.findFirst({ where: { botId: bots[1]!.id, status: "queued" } }),
    ).not.toBeNull();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(
      "cancelled",
    );
  });
  it("rolls back every linked cancellation when a terminal event cannot be stored", async () => {
    const parent = await runFor(0, "running", "user");
    const child = await runFor(1);
    await link(parent, child);
    const failing = db.prisma.$extends({
      query: {
        event: {
          async create() {
            throw new Error("injected event failure");
          },
        },
      },
    }) as unknown as PrismaClient;
    await expect(stop(failing)).rejects.toThrow("injected event failure");
    for (const run of [parent, child])
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "running",
      );
    expect(notify).not.toHaveBeenCalled();
  });
});
