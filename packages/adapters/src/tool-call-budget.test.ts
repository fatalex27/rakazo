import { describe, expect, it, vi } from "vitest";
import { reserveRunToolCall } from "./tool-call-budget.js";

const run = { id: "run", threadId: "thread", spaceId: "space", botId: "bot" };
const lease = { owner: "worker", fence: 1 };
function fixture() {
  const records: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let owned = true;
  let effectStatus = "approved";
  const tx = {
    $queryRaw: vi.fn(async (_query: unknown, ...values: unknown[]) =>
      values.length
        ? []
        : records
            .filter((row) => row.payload.charged !== false)
            .map((row) => ({ key: String(row.payload.executionId) })),
    ),
    run: {
      findFirst: vi.fn(async () => (owned ? { id: "run" } : null)),
      findUnique: vi.fn(async () => ({ status: "running", startedAt: new Date() })),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: records.length + 1 })) },
    externalEffect: {
      findFirst: vi.fn(async () => (effectStatus === "approved" ? { id: "effect" } : null)),
    },
    event: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            AND?: Array<{ payload: { path: string[]; equals: string } }>;
            payload?: { path: string[]; equals: string };
          };
        }) => {
          const filters = where.AND ?? (where.payload ? [{ payload: where.payload }] : []);
          return (
            records.find((row) =>
              filters.every(({ payload }) => row.payload[payload.path[0]!] === payload.equals),
            ) ?? null
          );
        },
      ),
      create: vi.fn(async ({ data }: { data: { payload: Record<string, unknown> } }) => {
        const row = { id: `event-${records.length}`, payload: data.payload };
        records.push(row);
        return row;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    prisma,
    tx,
    records,
    setEffectStatus: (status: string) => {
      effectStatus = status;
    },
    loseLease: () => {
      owned = false;
    },
  };
}
describe("durable tool slots", () => {
  it("recovers an approved reservation after crash before dispatch, but never exempts unknown writes", async () => {
    const f = fixture();
    const input = { name: "write", executionId: "original", limit: 1 };
    await reserveRunToolCall(f.prisma as never, run, lease, input);
    const approved = { ...input, executionId: "approved", approvedEffectId: "effect" };
    expect(await reserveRunToolCall(f.prisma as never, run, lease, approved)).toMatchObject({
      allowed: true,
      count: 1,
    });
    expect(
      await reserveRunToolCall(f.prisma as never, run, { ...lease, fence: 2 }, approved),
    ).toMatchObject({ allowed: true, count: 1 });
    for (const state of ["executing", "completed"]) {
      f.setEffectStatus(state);
      expect(
        await reserveRunToolCall(
          f.prisma as never,
          run,
          { ...lease, fence: 3 },
          { ...approved, executionId: state },
        ),
      ).toMatchObject({ allowed: false, reason: "limit" });
    }
    expect(f.tx.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "effect", runId: "run", spaceId: "space", kind: "write", status: "approved" },
      }),
    );
  });
  it("charges separate invocation ordinals and a fresh worker fence", async () => {
    const f = fixture();
    const input = {
      name: "read",
      executionId: "reused-provider-id",
      reservationKey: "main:0",
      limit: 2,
    };
    expect(await reserveRunToolCall(f.prisma as never, run, lease, input)).toMatchObject({
      allowed: true,
      count: 1,
    });
    expect(
      await reserveRunToolCall(f.prisma as never, run, lease, {
        ...input,
        reservationKey: "main:1",
      }),
    ).toMatchObject({ allowed: true, count: 2 });
    expect(
      await reserveRunToolCall(f.prisma as never, run, { ...lease, fence: 2 }, input),
    ).toMatchObject({ allowed: false, reason: "limit" });
  });
  it("reserves before dispatch and reads persisted capacity after a fresh caller", async () => {
    const f = fixture();
    const input = { name: "read", executionId: "one", limit: 1 };
    expect(await reserveRunToolCall(f.prisma as never, run, lease, input)).toEqual({
      allowed: true,
      count: 1,
    });
    expect(
      await reserveRunToolCall(f.prisma as never, run, lease, { ...input, executionId: "two" }),
    ).toEqual({ allowed: false, count: 1, reason: "limit" });
    expect(f.records).toHaveLength(1);
  });
  it("does not charge exact redelivery twice", async () => {
    const f = fixture();
    const input = { name: "read", executionId: "one", limit: 1 };
    await reserveRunToolCall(f.prisma as never, run, lease, input);
    expect(await reserveRunToolCall(f.prisma as never, run, lease, input)).toEqual({
      allowed: true,
      count: 1,
    });
    expect(f.records).toHaveLength(1);
  });
  it("allows one server approved replay at the limit without granting an unlimited bypass", async () => {
    const f = fixture();
    const input = { name: "write", executionId: "original", limit: 1 };
    await reserveRunToolCall(f.prisma as never, run, lease, input);
    expect(
      await reserveRunToolCall(f.prisma as never, run, lease, {
        ...input,
        executionId: "approved",
        approvedEffectId: "effect",
      }),
    ).toEqual({ allowed: true, count: 1 });
    expect(
      await reserveRunToolCall(f.prisma as never, run, lease, {
        ...input,
        executionId: "extra",
        approvedEffectId: "effect",
      }),
    ).toMatchObject({ allowed: false, reason: "limit" });
    expect(f.records).toHaveLength(2);
  });
  it("denies a lost lease before counting or persisting slots", async () => {
    const f = fixture();
    f.loseLease();
    expect(
      await reserveRunToolCall(f.prisma as never, run, lease, {
        name: "read",
        executionId: "one",
        limit: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "lease" });
    expect(f.records).toHaveLength(0);
  });
  it("propagates storage failure without granting a slot", async () => {
    const f = fixture();
    f.tx.event.create.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      reserveRunToolCall(f.prisma as never, run, lease, {
        name: "read",
        executionId: "one",
        limit: 1,
      }),
    ).rejects.toThrow("storage unavailable");
  });
});
