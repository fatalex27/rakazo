import { describe, expect, it, vi } from "vitest";
import { withLockedBotRequestRuns } from "./linked-bot-runs.js";

const actor = { spaceId: "space", userId: "user" };
function fixture(
  graph: (attempt: number) => Array<{ id: string; threadId: string; depth: number }>,
) {
  let attempt = 0;
  const locks: string[][] = [];
  const operation = vi.fn(async () => "committed");
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const current = attempt++;
      locks.push([]);
      return fn({
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: async (_query: unknown, id?: string) => {
          if (id) {
            locks[current]!.push(id);
            return [];
          }
          return graph(current);
        },
      });
    }),
  };
  return { prisma, operation, locks };
}
describe("linked Stop graph locking", () => {
  it("fails before mutation if database discovery exceeds its statement deadline", async () => {
    const operation = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async () => {
            throw new Error("canceling statement due to statement timeout");
          },
        }),
      ),
    };
    await expect(
      withLockedBotRequestRuns(prisma as never, actor, "root", operation),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(operation).not.toHaveBeenCalled();
  });
  it("rolls back expansion before mutation and retries all thread locks in order", async () => {
    const f = fixture(() => [
      { id: "parent", threadId: "z-root", depth: 0 },
      { id: "child", threadId: "a-child", depth: 1 },
    ]);
    expect(await withLockedBotRequestRuns(f.prisma as never, actor, "z-root", f.operation)).toBe(
      "committed",
    );
    expect(f.operation).toHaveBeenCalledOnce();
    expect(f.locks).toEqual([["z-root"], ["a-child", "z-root"]]);
  });
  it("fails explicitly after bounded expansion without partially cancelling", async () => {
    const f = fixture((attempt) => [
      { id: `child-${attempt}`, threadId: `child-thread-${attempt}`, depth: 1 },
    ]);
    await expect(
      withLockedBotRequestRuns(f.prisma as never, actor, "root", f.operation),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(5);
    expect(f.operation).not.toHaveBeenCalled();
  });
  it.each(["depth", "nodes"])("fails closed at its %s bound", async (kind) => {
    const f = fixture(() =>
      kind === "depth"
        ? [{ id: "cycle", threadId: "root", depth: 8 }]
        : Array.from({ length: 1025 }, (_, index) => ({
            id: `run-${index}`,
            threadId: "root",
            depth: 0,
          })),
    );
    await expect(
      withLockedBotRequestRuns(f.prisma as never, actor, "root", f.operation),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.operation).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
  });
});
