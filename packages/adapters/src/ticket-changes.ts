import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { BoardEvents, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export type TicketChange = {
  spaceId: string;
  boardId: string;
  ticketId: string;
  assigneeBotId: string | null;
  wakeAssignee: boolean;
  wakeRunId?: string;
};
export type TicketChangeNotifier = (change: TicketChange) => Promise<void>;

export function createTicketChangeNotifier(deps: {
  boardEvents: BoardEvents;
  prisma: PrismaClient;
  jobs: JobPublisher;
  ticketBoardEnabled?: boolean;
}): TicketChangeNotifier {
  return async (change) => {
    if (!deps.ticketBoardEnabled) return;
    await deps.boardEvents
      .notify(change.spaceId, {
        boardId: change.boardId,
        ticketId: change.ticketId,
      })
      .catch(() => undefined);
    if (change.wakeRunId) {
      await deps.jobs.enqueue(runContinueJob(change.wakeRunId)).catch((error) => {
        getLogger().warn("ticket wake deferred to reconciliation", error);
      });
    }
  };
}
