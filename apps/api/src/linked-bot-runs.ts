import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { Prisma as PrismaSql, withTransactionRetry } from "@rakazo/db";

export type LinkedBotRun = { id: string; threadId: string; depth: number; overflow?: boolean };
const MAX_LINKED_RUNS = 1024;
const MAX_LINK_DEPTH = 8;
const MAX_GRAPH_ATTEMPTS = 5;

/** Walk backwards only from unfinished deliveries, rather than the chat's lifetime history. */
export async function linkedBotRequestRuns(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  threadId: string,
): Promise<LinkedBotRun[]> {
  const rows = await tx.$queryRaw<LinkedBotRun[]>(PrismaSql.sql`
    WITH RECURSIVE ancestry AS (
      SELECT r.id AS origin, r.id, r."threadId", r."botId", r."sourceMessageId", r.trigger,
        0 AS depth, ARRAY[r.id]::text[] AS path, false AS cycle
      FROM runs r INNER JOIN threads t ON t.id = r."threadId"
      WHERE r.trigger = 'bot_message' AND r.status IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
        AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
        AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
        AND t."botId" = r."botId" AND t."groupId" IS NULL
      UNION ALL
      SELECT child.origin, parent.id, parent."threadId", parent."botId", parent."sourceMessageId", parent.trigger,
        child.depth + 1, child.path || parent.id, parent.id = ANY(child.path)
      FROM ancestry child
      INNER JOIN messages inbound ON inbound.id = child."sourceMessageId"
        AND inbound."runId" = child.id AND inbound."threadId" = child."threadId" AND inbound.role = 'user'
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inbound.blocks) = 'array' THEN inbound.blocks ELSE '[]'::jsonb END) received
      INNER JOIN messages outbound ON outbound.id = received->>'returnToMessageId' AND outbound.role = 'bot'
      INNER JOIN runs parent ON parent.id = outbound."runId" AND parent."threadId" = outbound."threadId"
        AND outbound."botId" = parent."botId"
        AND parent."spaceId" = ${actor.spaceId} AND parent."userId" = ${actor.userId}
      INNER JOIN threads parent_thread ON parent_thread.id = parent."threadId"
        AND parent_thread."spaceId" = ${actor.spaceId} AND parent_thread."userId" = ${actor.userId}
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(outbound.blocks) = 'array' THEN outbound.blocks ELSE '[]'::jsonb END) sent
      WHERE child.depth < ${MAX_LINK_DEPTH} AND NOT child.cycle AND child.trigger = 'bot_message'
        AND jsonb_typeof(sent) = 'object' AND jsonb_typeof(received) = 'object'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(inbound.blocks) = 'array' THEN inbound.blocks ELSE '[]'::jsonb END) = 1
        AND jsonb_array_length(CASE WHEN jsonb_typeof(outbound.blocks) = 'array' THEN outbound.blocks ELSE '[]'::jsonb END) = 1
        AND sent->>'kind' = 'bot_message_sent' AND sent->>'toBotId' = child."botId"
        AND received->>'kind' = 'bot_message_received' AND received->>'fromBotId' = parent."botId"
        AND jsonb_typeof(sent->'toBotId') = 'string'
        AND jsonb_typeof(received->'fromBotId') = 'string' AND jsonb_typeof(received->'returnToMessageId') = 'string'
        AND (NOT (received ? 'intent') OR jsonb_typeof(received->'intent') = 'string')
        AND (NOT (sent ? 'intent') OR jsonb_typeof(sent->'intent') = 'string')
        AND (
          COALESCE(received->>'intent', 'request') IN ('request', 'question')
          -- A terminal return committed before Stop is still unfinished request work.
          -- Only the server delivery key and the exact original request reply prove it.
          OR (
            received->>'intent' IN ('result', 'status')
            AND parent.trigger = 'bot_message' AND parent.status IN ('completed', 'failed', 'cancelled')
            AND inbound."clientNonce" = 'bot-message:auto-outcome:' || parent.id
            AND EXISTS (
              SELECT 1 FROM messages original_in
              INNER JOIN messages original_out ON original_out.id = inbound."replyToMessageId"
                AND original_out."threadId" = child."threadId" AND original_out.role = 'bot'
                AND original_out."botId" = child."botId"
              INNER JOIN runs original_parent ON original_parent.id = original_out."runId"
                AND original_parent."threadId" = original_out."threadId" AND original_parent."botId" = child."botId"
                AND original_parent."spaceId" = ${actor.spaceId} AND original_parent."userId" = ${actor.userId}
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(original_in.blocks) = 'array' THEN original_in.blocks ELSE '[]'::jsonb END) original_received
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(original_out.blocks) = 'array' THEN original_out.blocks ELSE '[]'::jsonb END) original_sent
              WHERE original_in.id = parent."sourceMessageId" AND original_in."runId" = parent.id
                AND original_in."threadId" = parent."threadId" AND original_in.role = 'user'
                AND jsonb_array_length(CASE WHEN jsonb_typeof(original_in.blocks) = 'array' THEN original_in.blocks ELSE '[]'::jsonb END) = 1
                AND jsonb_array_length(CASE WHEN jsonb_typeof(original_out.blocks) = 'array' THEN original_out.blocks ELSE '[]'::jsonb END) = 1
                AND original_received->>'kind' = 'bot_message_received' AND original_received->>'fromBotId' = child."botId"
                AND original_received->>'returnToMessageId' = original_out.id
                AND original_sent->>'kind' = 'bot_message_sent' AND original_sent->>'toBotId' = parent."botId"
                AND jsonb_typeof(original_received->'fromBotId') = 'string'
                AND jsonb_typeof(original_received->'returnToMessageId') = 'string'
                AND jsonb_typeof(original_sent->'toBotId') = 'string'
                AND jsonb_typeof(original_received->'text') = 'string' AND jsonb_typeof(original_sent->'text') = 'string'
                AND (NOT (original_received ? 'intent') OR jsonb_typeof(original_received->'intent') = 'string')
                AND (NOT (original_sent ? 'intent') OR jsonb_typeof(original_sent->'intent') = 'string')
                AND COALESCE(original_received->>'intent', 'request') IN ('request', 'question')
                AND COALESCE(original_received->>'intent', 'request') = COALESCE(original_sent->>'intent', 'request')
            )
          )
        )
        AND COALESCE(sent->>'intent', 'request') = COALESCE(received->>'intent', 'request')
        AND jsonb_typeof(sent->'text') = 'string' AND jsonb_typeof(received->'text') = 'string'
    ), root_origins AS (
      SELECT DISTINCT origin FROM ancestry WHERE "threadId" = ${threadId}
    ), relevant AS (
      SELECT r.id, r."threadId", 0 AS depth, false AS overflow
      FROM runs r INNER JOIN threads t ON t.id = r."threadId"
      WHERE r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
        AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
        AND r.status IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
        AND (r."threadId" = ${threadId} OR r.id IN (SELECT origin FROM root_origins))
      LIMIT ${MAX_LINKED_RUNS + 1}
    )
    SELECT * FROM relevant
    UNION ALL
    (SELECT id, "threadId", depth, true AS overflow FROM ancestry
      WHERE (cycle OR depth >= ${MAX_LINK_DEPTH}) AND origin IN (SELECT origin FROM root_origins) LIMIT 1)
  `);
  if (
    rows.length > MAX_LINKED_RUNS ||
    rows.some((row) => row.overflow || row.depth >= MAX_LINK_DEPTH)
  ) {
    throw new ORPCError("CONFLICT", { message: "Linked work exceeds the safe stop boundary." });
  }
  return rows;
}

class ExpandedRunGraph extends Error {
  constructor(readonly threads: string[]) {
    super("Linked work changed while locking");
  }
}

/** Re-discover under sorted thread locks; expansion rolls back before cancellation. */
export async function withLockedBotRequestRuns<T>(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  rootThreadId: string,
  operation: (tx: Prisma.TransactionClient, runs: LinkedBotRun[]) => Promise<T>,
): Promise<T> {
  const threadIds = new Set([rootThreadId]);
  return withTransactionRetry(async () => {
    for (let attempt = 0; attempt < MAX_GRAPH_ATTEMPTS; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          // Bound server work and lock waits, not merely the returned row count.
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          for (const id of [...threadIds].sort()) {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${id} FOR UPDATE`;
          }
          const runs = await linkedBotRequestRuns(tx, actor, rootThreadId);
          const newThreads = runs.map((run) => run.threadId).filter((id) => !threadIds.has(id));
          if (newThreads.length) throw new ExpandedRunGraph(newThreads);
          return operation(tx, runs);
        });
      } catch (error) {
        if (!(error instanceof ExpandedRunGraph)) {
          if (error instanceof Error && /statement timeout/i.test(error.message)) {
            throw new ORPCError("CONFLICT", {
              message: "Linked work could not be checked within the safe stop limit.",
            });
          }
          throw error;
        }
        for (const id of error.threads) threadIds.add(id);
      }
    }
    throw new ORPCError("CONFLICT", { message: "Linked work changed while stopping. Try again." });
  });
}
