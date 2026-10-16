import type { PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, Prisma } from "@rakazo/db";

export async function reserveRunToolCall(
  prisma: PrismaClient,
  run: { id: string; threadId: string; spaceId: string; botId: string },
  lease: { owner: string; fence: number },
  input: {
    name: string;
    executionId: string;
    reservationKey?: string;
    limit: number;
    approvedEffectId?: string;
    approvedEffectKind?: string;
  },
): Promise<{ allowed: boolean; count: number; reason?: "limit" | "lease" }> {
  return prisma.$transaction(async (tx) => {
    // Match clear/finalize ordering. The run lock serializes concurrent last-slot claims.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
    const current = await tx.run.findFirst({
      where: {
        id: run.id,
        spaceId: run.spaceId,
        threadId: run.threadId,
        status: "running",
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
      },
      select: { id: true },
    });
    if (!current) return { allowed: false, count: 0, reason: "lease" as const };
    if (input.limit <= 0) return { allowed: true, count: 0 };
    const reservationKey = JSON.stringify([
      lease.fence,
      input.reservationKey ?? [input.name, input.executionId],
    ]);
    const previous = await tx.event.findFirst({
      where: {
        runId: run.id,
        type: "agent.tool.reserved",
        payload: { path: ["reservationKey"], equals: reservationKey },
      },
      select: { id: true },
    });
    // Reservations supersede telemetry for the same invocation. Legacy calls with
    // no reservation count conservatively; exact duplicate delivery consumes one slot.
    const slots = await tx.$queryRaw<Array<{ key: string }>>(Prisma.sql`
      SELECT DISTINCT slot.key FROM (
        SELECT COALESCE(e.payload->>'reservationKey', jsonb_build_array(e.payload->>'name', COALESCE(e.payload->>'executionId', e.id))::text) AS key FROM events e
        WHERE e."runId" = ${run.id} AND e.type = 'agent.tool.reserved'
          AND COALESCE(e.payload->>'charged', 'true') <> 'false'
        UNION ALL
        SELECT jsonb_build_array(e.payload->>'name', COALESCE(e.payload->>'executionId', e.id))::text AS key FROM events e
        WHERE e."runId" = ${run.id} AND e.type = 'agent.tool.called'
          AND NOT EXISTS (
            SELECT 1 FROM events reservation
            WHERE reservation."runId" = e."runId" AND reservation.type = 'agent.tool.reserved'
              AND reservation.payload->>'executionId' = e.payload->>'executionId'
              AND reservation.payload->>'name' = e.payload->>'name'
          )
      ) slot LIMIT ${input.limit}
    `);
    if (previous) return { allowed: true, count: slots.length };
    const approvedEffect = input.approvedEffectId
      ? await tx.externalEffect.findFirst({
          where: {
            id: input.approvedEffectId,
            runId: run.id,
            spaceId: run.spaceId,
            kind: input.approvedEffectKind ?? input.name,
            status: "approved",
          },
          select: { id: true },
        })
      : null;
    const approvalAlreadyReserved = approvedEffect
      ? await tx.event.findFirst({
          where: {
            runId: run.id,
            type: "agent.tool.reserved",
            AND: [
              { payload: { path: ["approvedEffectId"], equals: approvedEffect.id } },
              { payload: { path: ["leaseFence"], equals: lease.fence } },
            ],
          },
          select: { id: true },
        })
      : null;
    // A new worker can resume a still-approved effect if its predecessor
    // stopped after reserving but before dispatch. Executing/terminal effects
    // remain subject to the effect replay/uncertain gate, without exemptions.
    const approvedReplay = Boolean(approvedEffect && !approvalAlreadyReserved);
    if (slots.length >= input.limit && !approvedReplay) {
      return { allowed: false, count: slots.length, reason: "limit" as const };
    }
    await appendEventInTransaction(tx, {
      ...run,
      runId: run.id,
      type: "agent.tool.reserved",
      payload: {
        name: input.name,
        executionId: input.executionId,
        reservationKey,
        leaseFence: lease.fence,
        charged: !approvedReplay,
        ...(approvedReplay ? { approvedEffectId: input.approvedEffectId } : {}),
      },
    });
    return { allowed: true, count: slots.length + (approvedReplay ? 0 : 1) };
  });
}
