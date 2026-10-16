import { randomUUID } from "node:crypto";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/** Assignment wakes only its current owner, without posting a chat message. */
export async function prepareTicketAssigneeRun(
  tx: Prisma.TransactionClient,
  ticket: {
    id: string;
    spaceId: string;
    number: number;
    status: string;
    assigneeBotId: string | null;
  },
  ticketPrefix: string,
): Promise<string | undefined> {
  if (!ticket.assigneeBotId) return undefined;
  const status = TicketStatusSchema.safeParse(ticket.status);
  if (!status.success || isTicketCompletedStatus(status.data)) return undefined;
  const bot = await tx.bot.findFirst({
    where: { id: ticket.assigneeBotId, spaceId: ticket.spaceId, archivedAt: null },
    select: { id: true, userId: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new Error("Ticket assignee is no longer available.");
  const task = await tx.task.create({
    data: {
      spaceId: ticket.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      prompt: `Work on ticket ${ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.`,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: ticket.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      taskId: task.id,
      trigger: "tickets",
      status: "queued",
      clientNonce: `${ticketAssignmentPrefix(ticket.id)}${randomUUID()}`,
    },
  });
  return run.id;
}

function ticketAssignmentPrefix(ticketId: string): string {
  return `ticket-assignment:${ticketId}:`;
}

/** Caller holds the ticket row lock. Historical runs without a linkage are untouched. */
export async function cancelPreviousTicketAssignments(
  tx: Prisma.TransactionClient,
  ticket: { id: string; spaceId: string; assigneeBotId: string | null },
): Promise<void> {
  const where = {
    spaceId: ticket.spaceId,
    trigger: "tickets",
    clientNonce: { startsWith: ticketAssignmentPrefix(ticket.id) },
    status: { in: [...ACTIVE_RUN_STATUSES] },
  };
  const threads = await tx.run.findMany({
    where,
    select: { threadId: true },
    distinct: ["threadId"],
  });
  const target = ticket.assigneeBotId
    ? await tx.bot.findFirst({
        where: { id: ticket.assigneeBotId, spaceId: ticket.spaceId, archivedAt: null },
        select: { thread: { select: { id: true } } },
      })
    : null;
  // Lock old AND replacement threads in one order. Reciprocal assignments of
  // different tickets must not each hold one side while waiting on the other's FK.
  const threadIds = new Set(threads.map((row) => row.threadId));
  if (target?.thread) threadIds.add(target.thread.id);
  for (const threadId of [...threadIds].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
  const now = new Date();
  const runs = await tx.run.updateManyAndReturn({
    where,
    data: { status: "cancelled", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
    select: { id: true, taskId: true },
  });
  if (!runs.length) return;
  await tx.attempt.updateMany({
    where: { runId: { in: runs.map((run) => run.id) }, status: "running" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
