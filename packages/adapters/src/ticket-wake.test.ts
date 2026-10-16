import { describe, expect, it, vi } from "vitest";
import { cancelPreviousTicketAssignments, prepareTicketAssigneeRun } from "./ticket-wake.js";

const ticket = {
  id: "ticket-1",
  spaceId: "space-1",
  number: 1,
  status: "todo",
  assigneeBotId: "bot-1",
};
function setup() {
  return {
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", userId: "user-1", thread: { id: "thread-1" } })),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findMany: vi.fn(async () => [{ threadId: "thread-1" }]),
      create: vi.fn(async () => ({ id: "run-1" })),
      updateManyAndReturn: vi.fn(async () => [{ id: "old-run", taskId: "old-task" }]),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => []),
  };
}
describe("durable ticket assignment", () => {
  it.each(["done", "closed", "cancelled", "invalid"])(
    "does not create work for %s",
    async (status) => {
      const tx = setup();
      expect(
        await prepareTicketAssigneeRun(tx as never, { ...ticket, status }, "RAK"),
      ).toBeUndefined();
      expect(tx.task.create).not.toHaveBeenCalled();
    },
  );
  it("does not create unassigned work", async () => {
    const tx = setup();
    await prepareTicketAssigneeRun(tx as never, { ...ticket, assigneeBotId: null }, "RAK");
    expect(tx.bot.findFirst).not.toHaveBeenCalled();
  });
  it("fails the transaction if the assignee became unavailable", async () => {
    const tx = setup();
    tx.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(prepareTicketAssigneeRun(tx as never, ticket, "RAK")).rejects.toThrow(
      "no longer available",
    );
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot-1", spaceId: "space-1", archivedAt: null } }),
    );
  });
  it("cancels only active runs linked to this ticket, retaining terminal results", async () => {
    const tx = setup();
    await cancelPreviousTicketAssignments(tx as never, ticket);
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        trigger: "tickets",
        clientNonce: { startsWith: "ticket-assignment:ticket-1:" },
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: {
        status: "cancelled",
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      select: { id: true, taskId: true },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-task"] } },
      data: { status: "cancelled" },
    });
    expect(tx.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: { in: ["old-run"] }, status: "running" } }),
    );
  });
  it("does not touch attempts or tasks if no active assignment remains", async () => {
    const tx = setup();
    tx.run.updateManyAndReturn.mockResolvedValueOnce([]);
    await cancelPreviousTicketAssignments(tx as never, ticket);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.attempt.updateMany).not.toHaveBeenCalled();
  });
});
