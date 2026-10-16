import type { Prisma, PrismaClient } from "@rakazo/db";

type Reader = Pick<Prisma.TransactionClient, "run" | "message" | "event">;
type Owner = { spaceId: string; userId: string };
export type RequestBoundary = { threadId: string; seq: number };

function block(value: unknown, kind: string) {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const item = value[0];
  if (!item || typeof item !== "object" || item.kind !== kind || typeof item.text !== "string")
    return null;
  const intent = Object.hasOwn(item, "intent") ? item.intent : "request";
  return ["request", "question", "result", "status", "fyi"].includes(intent)
    ? { ...item, intent }
    : null;
}

const isRequest = (intent: string) => intent === "request" || intent === "question";

/** Only server-paired, owned private requests establish a return boundary. */
export async function botRequestBoundaries(
  db: Reader | PrismaClient,
  owner: Owner,
  runId: string,
): Promise<RequestBoundary[] | null> {
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const boundaries: RequestBoundary[] = [];
  const seen = new Set<string>();
  for (let depth = 0; depth <= 8; depth += 1) {
    if (seen.has(runId)) return null;
    seen.add(runId);
    const child = await db.run.findFirst({
      where: { id: runId, ...scope, thread: { ...scope, groupId: null } },
      select: {
        id: true,
        threadId: true,
        botId: true,
        trigger: true,
        sourceMessageId: true,
        thread: { select: { botId: true } },
      },
    });
    if (!child || child.thread.botId !== child.botId) return null;
    if (child.trigger !== "bot_message") return boundaries.length ? boundaries : null;
    if (!child.sourceMessageId || depth === 8) return null;
    const inbound = await db.message.findUnique({ where: { id: child.sourceMessageId } });
    const received = block(inbound?.blocks, "bot_message_received");
    if (
      inbound?.role !== "user" ||
      inbound.runId !== child.id ||
      inbound.threadId !== child.threadId ||
      !received ||
      typeof received.returnToMessageId !== "string" ||
      typeof received.fromBotId !== "string"
    )
      return null;
    const outbound = await db.message.findUnique({ where: { id: received.returnToMessageId } });
    const sent = block(outbound?.blocks, "bot_message_sent");
    if (
      outbound?.role !== "bot" ||
      !outbound.runId ||
      !sent ||
      sent.toBotId !== child.botId ||
      sent.intent !== received.intent
    )
      return null;
    const parent = await db.run.findFirst({
      where: {
        id: outbound.runId,
        ...scope,
        threadId: outbound.threadId,
        botId: received.fromBotId,
        thread: { ...scope, botId: received.fromBotId, groupId: null },
      },
      select: { id: true, botId: true, trigger: true, status: true, sourceMessageId: true },
    });
    if (!parent || outbound.botId !== parent.botId) return null;
    if (!isRequest(received.intent)) {
      if (!inbound.clientNonce?.startsWith("bot-message:auto-outcome:")) {
        // A valid manual FYI/result starts an independent conversation. Its
        // explicit downstream request still has its own Stop boundary.
        return boundaries.length ? boundaries : null;
      }
      if (
        !["result", "status"].includes(received.intent) ||
        inbound.clientNonce !== `bot-message:auto-outcome:${parent.id}` ||
        parent.trigger !== "bot_message" ||
        !["completed", "failed", "cancelled"].includes(parent.status) ||
        !parent.sourceMessageId
      )
        return null;
      const originalIn = await db.message.findUnique({ where: { id: parent.sourceMessageId } });
      const originalReceived = block(originalIn?.blocks, "bot_message_received");
      if (
        originalIn?.role !== "user" ||
        originalIn.runId !== parent.id ||
        originalIn.threadId !== outbound.threadId ||
        !originalReceived ||
        !isRequest(originalReceived.intent) ||
        originalReceived.fromBotId !== child.botId ||
        typeof originalReceived.returnToMessageId !== "string" ||
        inbound.replyToMessageId !== originalReceived.returnToMessageId
      )
        return null;
      const originalOut = await db.message.findUnique({
        where: { id: originalReceived.returnToMessageId },
      });
      const originalSent = block(originalOut?.blocks, "bot_message_sent");
      if (
        originalOut?.role !== "bot" ||
        originalOut.threadId !== child.threadId ||
        originalOut.botId !== child.botId ||
        !originalOut.runId ||
        !originalSent ||
        originalSent.toBotId !== parent.botId ||
        originalSent.intent !== originalReceived.intent
      )
        return null;
      // The next iteration verifies this original request's parent ownership.
    }
    boundaries.push({ threadId: outbound.threadId, seq: outbound.seq });
    runId = parent.id;
  }
  return null;
}

export async function crossesExplicitStop(db: Reader, boundaries: RequestBoundary[]) {
  for (const boundary of boundaries) {
    const marker = await db.event.findFirst({
      where: {
        threadId: boundary.threadId,
        type: "thread.meta",
        payload: { path: ["notice"], equals: "explicit-stop" },
      },
      orderBy: { seq: "desc" },
      select: { payload: true },
    });
    const payload = marker?.payload;
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload.stopThroughMessageSeq === "number" &&
      boundary.seq <= payload.stopThroughMessageSeq
    )
      return true;
  }
  return false;
}
