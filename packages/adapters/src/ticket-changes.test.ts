import { describe, expect, it, vi } from "vitest";
import type { TicketChange } from "./ticket-changes.js";
import { createTicketChangeNotifier } from "./ticket-changes.js";

const change: TicketChange = {
  spaceId: "space-1",
  boardId: "board-1",
  ticketId: "ticket-1",
  assigneeBotId: "bot-1",
  wakeAssignee: true,
  wakeRunId: "run-1",
};
function setup(ticketBoardEnabled = true) {
  const notify = vi.fn(async () => {});
  const enqueue = vi.fn(async () => {});
  const transaction = vi.fn();
  const changes = createTicketChangeNotifier({
    ticketBoardEnabled,
    prisma: { $transaction: transaction } as never,
    jobs: { enqueue } as never,
    boardEvents: { notify } as never,
  });
  return { changes, notify, enqueue, transaction };
}

describe("ticket changes", () => {
  it("does nothing when disabled", async () => {
    const s = setup(false);
    await s.changes(change);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("only dispatches the already committed run on repeated delivery", async () => {
    const s = setup();
    await s.changes(change);
    await s.changes(change);
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).toHaveBeenCalledTimes(2);
    expect(s.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(s.notify).toHaveBeenCalledWith("space-1", { boardId: "board-1", ticketId: "ticket-1" });
  });
  it("does not synthesize a run from an old assignment notification", async () => {
    const s = setup();
    await s.changes({ ...change, wakeRunId: undefined });
    expect(s.notify).toHaveBeenCalledOnce();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("leaves missed dispatch to the durable run reconciler", async () => {
    const s = setup();
    s.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(s.changes(change)).resolves.toBeUndefined();
    expect(s.transaction).not.toHaveBeenCalled();
  });
});
