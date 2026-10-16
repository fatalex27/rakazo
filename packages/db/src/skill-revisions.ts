import type { AgentSkill, Prisma, PrismaClient, TaughtSkill } from "./client.js";
import { IsolationError } from "./scope.js";

export type SkillKind = "agent" | "taught";
type SkillOwner = { spaceId: string; userId: string };
type Recipe = AgentSkill | TaughtSkill;

export class SkillRevisionConflict extends Error {
  constructor() {
    super("Skill changed. Read it again before updating or restoring.");
  }
}
export class SkillRevisionRejected extends Error {}

/** Whitelist executable fields: recordings, leases, secrets and account state never enter history. */
export function skillRevisionSnapshot(
  kind: SkillKind,
  row: Record<string, unknown>,
): Prisma.InputJsonObject {
  const keys =
    kind === "agent" ? ["name", "description", "content"] : ["name", "goal", "status", "playbook"];
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as Prisma.InputJsonObject;
}

async function owned(
  tx: Prisma.TransactionClient,
  owner: SkillOwner,
  kind: SkillKind,
  skillId: string,
) {
  const where = { id: skillId, spaceId: owner.spaceId, userId: owner.userId };
  const row =
    kind === "agent"
      ? await tx.agentSkill.findFirst({ where })
      : await tx.taughtSkill.findFirst({ where });
  if (!row) throw new IsolationError();
  return row;
}

function historyWhere(kind: SkillKind, id: string) {
  return kind === "agent" ? { agentSkillId: id } : { taughtSkillId: id };
}

function assertEditable(kind: SkillKind, row: Recipe) {
  if (kind === "agent" && "source" in row && row.source !== "user") {
    throw new SkillRevisionRejected("Builtin and plugin skills are read-only.");
  }
  if (kind === "taught" && "status" in row && row.status !== "draft" && row.status !== "saved") {
    throw new SkillRevisionRejected("Finish recording before changing or restoring a skill.");
  }
}

export async function listSkillRevisions(
  prisma: PrismaClient,
  owner: SkillOwner,
  kind: SkillKind,
  skillId: string,
  requestedRevision?: number,
) {
  return prisma.$transaction(async (tx) => {
    const current = await owned(tx, owner, kind, skillId);
    assertEditable(kind, current);
    const rows = await tx.skillRevision.findMany({
      where: {
        ...historyWhere(kind, skillId),
        ...(requestedRevision === undefined ? {} : { revision: requestedRevision }),
      },
      orderBy: { revision: "desc" },
      take: 100,
    });
    // Legacy rows have no history until their first edit. Their baseline is still reviewable.
    if (
      (requestedRevision === undefined || requestedRevision === current.revision) &&
      !rows.some((row) => row.revision === current.revision)
    ) {
      rows.unshift({
        id: `current:${current.id}`,
        agentSkillId: kind === "agent" ? current.id : null,
        taughtSkillId: kind === "taught" ? current.id : null,
        revision: current.revision,
        snapshot: skillRevisionSnapshot(kind, current) as Prisma.JsonObject,
        source: kind === "agent" ? "user" : "recording",
        restoredFrom: null,
        createdAt: current.updatedAt,
      });
    }
    return rows.map(({ id: _id, agentSkillId: _a, taughtSkillId: _t, snapshot, ...row }) => ({
      ...row,
      ...(requestedRevision === undefined ? {} : { snapshot }),
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

type RevisionWrite = { skillId: string; expectedRevision: number; targetRevision?: number };
type AgentRecipe = Pick<AgentSkill, "name" | "description" | "content">;
type TaughtRecipe = Pick<TaughtSkill, "name" | "playbook" | "status">;

export function writeSkillRevision(
  prisma: PrismaClient,
  owner: SkillOwner,
  kind: "agent",
  input: RevisionWrite & { data?: AgentRecipe },
): Promise<AgentSkill>;
export function writeSkillRevision(
  prisma: PrismaClient,
  owner: SkillOwner,
  kind: "taught",
  input: RevisionWrite & { data?: TaughtRecipe },
): Promise<TaughtSkill>;
export async function writeSkillRevision(
  prisma: PrismaClient,
  owner: SkillOwner,
  kind: SkillKind,
  input: RevisionWrite & { data?: AgentRecipe | TaughtRecipe },
): Promise<Recipe> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new SkillRevisionConflict();
  if (
    input.targetRevision !== undefined &&
    (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1)
  )
    throw new SkillRevisionConflict();
  return prisma.$transaction(async (tx) => {
    const current = await owned(tx, owner, kind, input.skillId);
    assertEditable(kind, current);
    if (current.revision !== input.expectedRevision) throw new SkillRevisionConflict();
    let snapshot = input.data
      ? skillRevisionSnapshot(kind, { ...current, ...input.data })
      : undefined;
    if (input.targetRevision !== undefined) {
      const previous = await tx.skillRevision.findFirst({
        where: { ...historyWhere(kind, current.id), revision: input.targetRevision },
      });
      if (!previous && input.targetRevision !== current.revision) throw new IsolationError();
      snapshot = previous
        ? (previous.snapshot as Prisma.InputJsonObject)
        : skillRevisionSnapshot(kind, current);
    }
    if (!snapshot) throw new Error("Provide a recipe or revision to restore.");
    const revision = current.revision + 1;
    const where = {
      id: current.id,
      spaceId: owner.spaceId,
      userId: owner.userId,
      revision: current.revision,
    };
    const changed =
      kind === "agent"
        ? await tx.agentSkill.updateMany({
            where: { ...where, source: "user" },
            data: { ...snapshot, revision } as Prisma.AgentSkillUpdateManyMutationInput,
          })
        : await tx.taughtSkill.updateMany({
            where: { ...where, status: { in: ["draft", "saved"] } },
            data: { ...snapshot, revision } as Prisma.TaughtSkillUpdateManyMutationInput,
          });
    if (changed.count !== 1) throw new SkillRevisionConflict();
    const parent = historyWhere(kind, current.id);
    await tx.skillRevision.createMany({
      data: [
        {
          ...parent,
          revision: current.revision,
          snapshot: skillRevisionSnapshot(kind, current),
          source: kind === "agent" ? "user" : "recording",
          createdAt: current.updatedAt,
        },
        {
          ...parent,
          revision,
          snapshot,
          source: input.targetRevision === undefined ? "user" : "restore",
          restoredFrom: input.targetRevision ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return owned(tx, owner, kind, current.id);
  });
}
