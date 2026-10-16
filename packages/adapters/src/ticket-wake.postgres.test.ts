import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTicketChangeNotifier } from "./ticket-changes.js";
import { createTicket, updateTicket } from "./ticket-tools.js";
import { reserveRunToolCall } from "./tool-call-budget.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = enabled ? describe.sequential : describe.skip;

describePostgres("ticket assignment (PostgreSQL contract)", () => {
  const id = `ticket-test-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  const botA = `${id}-a`;
  const botB = `${id}-b`;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
    await db.prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.invalid` } });
    await db.prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    for (const botId of [botA, botB]) {
      await db.prisma.bot.create({
        data: { id: botId, spaceId: id, userId: id, name: botId, color: "fixture" },
      });
      await db.prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    }
    await db.prisma.board.create({ data: { spaceId: id, name: "Fixture" } });
  });
  beforeEach(async () => {
    await db.prisma.event.deleteMany({ where: { spaceId: id } });
    await db.prisma.message.deleteMany({ where: { thread: { spaceId: id } } });
    await db.prisma.task.deleteMany({ where: { spaceId: id } });
    await db.prisma.ticket.deleteMany({ where: { spaceId: id } });
    await db.prisma.thread.updateMany({
      where: { spaceId: id },
      data: { nextEventSeq: 0, nextMessageSeq: 0 },
    });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id } });
      await db.prisma.user.deleteMany({ where: { id } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  const deps = () => ({ prisma: db.prisma, ticketBoardEnabled: true });
  function failingRunStore(): PrismaClient {
    return db.prisma.$extends({
      query: {
        run: {
          async create() {
            throw new Error("injected run storage failure");
          },
        },
      },
    }) as unknown as PrismaClient;
  }
  it("rolls back ticket creation, board number and task when run persistence fails", async () => {
    const before = await db.prisma.board.findUniqueOrThrow({ where: { spaceId: id } });
    await expect(
      createTicket(
        { ...deps(), prisma: failingRunStore() },
        {
          spaceId: id,
          userId: id,
          title: "Atomic create",
          ownerBotId: botA,
        },
      ),
    ).rejects.toThrow("injected run storage failure");
    expect(await db.prisma.ticket.count({ where: { spaceId: id } })).toBe(0);
    expect(await db.prisma.task.count({ where: { spaceId: id } })).toBe(0);
    expect((await db.prisma.board.findUniqueOrThrow({ where: { spaceId: id } })).nextNumber).toBe(
      before.nextNumber,
    );
  });
  it("rolls back reassignment and cancellation when replacement run persistence fails", async () => {
    const result = await createTicket(deps(), {
      spaceId: id,
      title: "Atomic update",
      ownerBotId: botA,
    });
    if ("error" in result) throw new Error(result.error);
    await expect(
      updateTicket(
        { ...deps(), prisma: failingRunStore() },
        { spaceId: id, id: result.ticket.id, ownerBotId: botB },
      ),
    ).rejects.toThrow("injected run storage failure");
    expect(
      (await db.prisma.ticket.findUniqueOrThrow({ where: { id: result.ticket.id } })).assigneeBotId,
    ).toBe(botA);
    const runs = await db.prisma.run.findMany({ where: { spaceId: id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    expect(await db.prisma.task.count({ where: { spaceId: id } })).toBe(1);
  });
  it("serializes concurrent same-owner assignment and repeated notifier delivery", async () => {
    const result = await createTicket(deps(), {
      spaceId: id,
      title: "Concurrent",
      ownerBotId: botA,
      botId: botA,
    });
    if ("error" in result) throw new Error(result.error);
    const changes: Parameters<ReturnType<typeof createTicketChangeNotifier>>[0][] = [];
    const withNotify = {
      ...deps(),
      onTicketChange: async (change: (typeof changes)[number]) => {
        changes.push(change);
      },
    };
    await Promise.all(
      Array.from({ length: 4 }, () =>
        updateTicket(withNotify, { spaceId: id, id: result.ticket.id, ownerBotId: botB }),
      ),
    );
    const runs = await db.prisma.run.findMany({ where: { spaceId: id } });
    expect(runs).toHaveLength(1);
    const enqueue = vi.fn(async () => {});
    const notify = createTicketChangeNotifier({
      ...deps(),
      jobs: { enqueue } as never,
      boardEvents: { notify: async () => {} } as never,
    });
    const wake = changes.find((change) => change.wakeRunId)!;
    await Promise.all([notify(wake), notify(wake)]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await db.prisma.run.count({ where: { spaceId: id } })).toBe(1);
  });
  it("preserves terminal results and never revives cancelled episodes on replay", async () => {
    const result = await createTicket(deps(), { spaceId: id, title: "Episodes", ownerBotId: botA });
    if ("error" in result) throw new Error(result.error);
    const original = await db.prisma.run.findFirstOrThrow({ where: { spaceId: id } });
    await db.prisma.run.update({
      where: { id: original.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const savedResult = await db.prisma.message.create({
      data: {
        threadId: original.threadId,
        botId: botA,
        runId: original.id,
        role: "bot",
        seq: 0,
        blocks: [{ kind: "text", text: "Verified result artifact" }],
      },
    });
    await updateTicket(deps(), { spaceId: id, id: result.ticket.id, ownerBotId: botB });
    await updateTicket(deps(), { spaceId: id, id: result.ticket.id, ownerBotId: botA });
    let runs = await db.prisma.run.findMany({
      where: { spaceId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "cancelled")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "completed")).toHaveLength(1);
    expect(new Set(runs.map((run) => run.clientNonce)).size).toBe(3);
    const active = runs.find((run) => run.status === "queued")!;
    await db.prisma.run.update({
      where: { id: active.id },
      data: { status: "cancelled", completedAt: new Date() },
    });
    await updateTicket(deps(), { spaceId: id, id: result.ticket.id, ownerBotId: botA });
    runs = await db.prisma.run.findMany({ where: { spaceId: id } });
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "cancelled")).toHaveLength(2);
    expect(await db.prisma.message.findUnique({ where: { id: savedResult.id } })).toMatchObject({
      blocks: [{ kind: "text", text: "Verified result artifact" }],
    });
  });

  async function runningAssignment() {
    const result = await createTicket(deps(), { spaceId: id, title: "Budget", ownerBotId: botA });
    if ("error" in result) throw new Error(result.error);
    const run = await db.prisma.run.findFirstOrThrow({ where: { spaceId: id } });
    return {
      ticket: result.ticket,
      run: await db.prisma.run.update({
        where: { id: run.id },
        data: { status: "running", leaseOwner: "fixture-worker", leaseFence: 1 },
      }),
    };
  }
  it("serializes reciprocal assignments across different tickets without deadlock", async () => {
    const first = await createTicket(deps(), { spaceId: id, title: "First", ownerBotId: botA });
    const second = await createTicket(deps(), { spaceId: id, title: "Second", ownerBotId: botB });
    if ("error" in first || "error" in second) throw new Error("fixture creation failed");
    await Promise.all([
      updateTicket(deps(), { spaceId: id, id: first.ticket.id, ownerBotId: botB }),
      updateTicket(deps(), { spaceId: id, id: second.ticket.id, ownerBotId: botA }),
    ]);
    const runs = await db.prisma.run.findMany({ where: { spaceId: id } });
    expect(runs).toHaveLength(4);
    expect(runs.filter((run) => run.status === "cancelled")).toHaveLength(2);
    expect(
      runs
        .filter((run) => run.status === "queued")
        .map((run) => run.botId)
        .sort(),
    ).toEqual([botA, botB].sort());
  }, 15_000);
  it("reserves the final durable slot once across concurrent and restarted callers", async () => {
    const { run } = await runningAssignment();
    const lease = { owner: "fixture-worker", fence: 1 };
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        reserveRunToolCall(db.prisma, run, lease, {
          name: "read",
          executionId: `call-${index}`,
          limit: 1,
        }),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "agent.tool.reserved" } }),
    ).toBe(1);
    expect(
      await reserveRunToolCall(db.prisma, run, lease, {
        name: "read",
        executionId: "fresh-after-restart",
        limit: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "limit" });
    const saved = await db.prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "agent.tool.reserved" },
    });
    expect(
      await reserveRunToolCall(db.prisma, run, lease, {
        name: "read",
        executionId: (saved.payload as { executionId: string }).executionId,
        limit: 1,
      }),
    ).toMatchObject({ allowed: true, count: 1 });
    expect(
      await reserveRunToolCall(
        db.prisma,
        run,
        { ...lease, fence: 0 },
        { name: "read", executionId: "stale", limit: 1 },
      ),
    ).toMatchObject({ allowed: false, reason: "lease" });
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    expect(
      await reserveRunToolCall(
        db.prisma,
        run,
        { ...lease, fence: 2 },
        {
          name: "read",
          executionId: (saved.payload as { executionId: string }).executionId,
          limit: 1,
        },
      ),
    ).toMatchObject({ allowed: false, reason: "limit" });
  });
  it("counts legacy telemetry and permits one approval continuation without double charging", async () => {
    const { run } = await runningAssignment();
    const lease = { owner: "fixture-worker", fence: 1 };
    const approvedEffect = await db.prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: run.id,
        kind: "write",
        idempotencyKey: `${id}-approved`,
        status: "approved",
        request: {},
      },
    });
    await db.prisma.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId: id,
        threadId: run.threadId,
        botId: botA,
        runId: run.id,
        type: "agent.tool.called",
        payload: { name: "write", executionId: "original" },
      }),
    );
    expect(
      await reserveRunToolCall(db.prisma, run, lease, {
        name: "read",
        executionId: "extra",
        limit: 1,
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await reserveRunToolCall(db.prisma, run, lease, {
        name: "write",
        executionId: "approved",
        approvedEffectId: approvedEffect.id,
        limit: 1,
      }),
    ).toMatchObject({ allowed: true, count: 1 });
    expect(
      await reserveRunToolCall(db.prisma, run, lease, {
        name: "write",
        executionId: "another",
        approvedEffectId: approvedEffect.id,
        limit: 1,
      }),
    ).toMatchObject({ allowed: false });
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    expect(
      await reserveRunToolCall(
        db.prisma,
        run,
        { ...lease, fence: 2 },
        {
          name: "write",
          executionId: "approved-after-crash",
          approvedEffectId: approvedEffect.id,
          limit: 1,
        },
      ),
    ).toMatchObject({ allowed: true, count: 1 });
    for (const [index, status] of ["executing", "completed"].entries()) {
      await db.prisma.externalEffect.update({ where: { id: approvedEffect.id }, data: { status } });
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseFence: index + 3 } });
      expect(
        await reserveRunToolCall(
          db.prisma,
          run,
          { ...lease, fence: index + 3 },
          { name: "write", executionId: status, approvedEffectId: approvedEffect.id, limit: 1 },
        ),
      ).toMatchObject({ allowed: false, reason: "limit" });
    }
  });
  it("rolls back reservation metadata if its event cannot be stored", async () => {
    const { run } = await runningAssignment();
    const failing = db.prisma.$extends({
      query: {
        event: {
          async create() {
            throw new Error("injected event storage failure");
          },
        },
      },
    }) as unknown as PrismaClient;
    const before = await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } });
    await expect(
      reserveRunToolCall(
        failing,
        run,
        { owner: "fixture-worker", fence: 1 },
        { name: "read", executionId: "one", limit: 1 },
      ),
    ).rejects.toThrow("injected event storage failure");
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "agent.tool.reserved" } }),
    ).toBe(0);
    expect(
      (await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } })).nextEventSeq,
    ).toBe(before.nextEventSeq);
  });
  it("coordinates reassignment with an in-flight durable reservation", async () => {
    const { run, ticket } = await runningAssignment();
    await Promise.all([
      reserveRunToolCall(
        db.prisma,
        run,
        { owner: "fixture-worker", fence: 1 },
        { name: "read", executionId: "one", limit: 1 },
      ),
      updateTicket(deps(), { spaceId: id, id: ticket.id, ownerBotId: botB }),
    ]);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await reserveRunToolCall(
        db.prisma,
        run,
        { owner: "fixture-worker", fence: 1 },
        { name: "read", executionId: "after-cancel", limit: 1 },
      ),
    ).toMatchObject({ allowed: false, reason: "lease" });
  });
});
