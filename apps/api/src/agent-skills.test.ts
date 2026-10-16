import type { Actor } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function savedSkill(name: string, source = "user") {
  return {
    id: "saved-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name,
    description: "Saved review recipe",
    content: buildSkillMd({ name, description: "Saved review recipe", body: "Saved steps" }),
    source,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    revision: 1,
  };
}

function setup(rows: ReturnType<typeof savedSkill>[] = []) {
  type Where = { id?: string; spaceId: string; userId: string; source?: string };
  const matches = (row: ReturnType<typeof savedSkill>, where: Where) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value);
  const agentSkill = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const row = rows.find((row) => matches(row, where));
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: object }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const index = rows.findIndex((row) => matches(row, where));
      if (index < 0) return { count: 0 };
      rows.splice(index, 1);
      return { count: 1 };
    }),
  };
  const revisions: Array<Record<string, unknown>> = [];
  const db = {
    agentSkill,
    skillRevision: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        revisions
          .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
          .slice()
          .reverse(),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        revisions.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
      ),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data)
          if (!revisions.some((r) => r.revision === row.revision))
            revisions.push({ createdAt: new Date(), restoredFrom: null, ...row });
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    agentSkill,
    service: createAgentSkillsService(db as unknown as PrismaClient),
  };
}

describe("built-in skill precedence in the API", () => {
  it("returns revision history and rejects stale or foreign restores", async () => {
    const original = savedSkill("Read saved result");
    const { service } = setup([original]);
    await expect(
      service.update(actor, { skillId: original.id, expectedRevision: 1, body: "New draft" }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(service.history(actor, original.id)).resolves.toMatchObject([
      { revision: 2 },
      { revision: 1 },
    ]);
    await expect(service.history(actor, original.id, 1)).resolves.toMatchObject([
      { snapshot: { content: expect.stringContaining("Saved steps") } },
    ]);
    await expect(
      service.restore(actor, { skillId: original.id, expectedRevision: 2, targetRevision: 1 }),
    ).resolves.toMatchObject({ revision: 3, content: expect.stringContaining("Saved steps") });
    await expect(
      service.restore(actor, { skillId: original.id, expectedRevision: 2, targetRevision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.remove(actor, original.id, 2)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.get(actor, { skillId: original.id })).resolves.toMatchObject({
      revision: 3,
    });
    await expect(
      service.history({ ...actor, userId: "foreign-user" }, original.id),
    ).rejects.toThrow("not found");
  });
  it.each(["interrogate", " Interrogate "])(
    "keeps %j listed, readable and mutable",
    async (name) => {
      const { service } = setup([savedSkill(name)]);
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "saved-1", name, readOnly: false }),
      ]);
      await expect(service.listWithContent(actor)).resolves.toEqual([
        expect.objectContaining({ id: "saved-1", content: expect.stringContaining("Saved steps") }),
      ]);
      await expect(service.get(actor, { name: " INTERROGATE " })).resolves.toMatchObject({
        id: "saved-1",
        source: "user",
      });
      await expect(service.get(actor, { skillId: "saved-1" })).resolves.toMatchObject({ name });
      await expect(
        service.update(actor, {
          expectedRevision: 1,
          skillId: "saved-1",
          description: "Updated recipe",
        }),
      ).resolves.toMatchObject({ name: name.trim(), description: "Updated recipe" });
      await expect(service.remove(actor, "saved-1", 2)).resolves.toEqual({ ok: true });
      await expect(service.get(actor, { name: "Interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
    },
  );

  it("preserves plugin precedence and read-only enforcement", async () => {
    const { service, agentSkill } = setup([savedSkill(" Interrogate ", "plugin")]);
    await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
      id: "saved-1",
      source: "plugin",
      readOnly: true,
    });
    await expect(
      service.update(actor, { expectedRevision: 1, skillId: "saved-1", body: "Changed" }),
    ).rejects.toThrow("read-only");
    await expect(service.remove(actor, "saved-1", 2)).rejects.toThrow("read-only");
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
    expect(agentSkill.deleteMany).not.toHaveBeenCalled();
  });

  it.each([{ spaceId: "other-space" }, { userId: "other-user" }])(
    "does not let foreign skills shadow the builtin: %j",
    async (foreignOwner) => {
      const { service } = setup([{ ...savedSkill(" Interrogate "), ...foreignOwner }]);
      await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "builtin:Interrogate" }),
      ]);
      await expect(service.get(actor, { skillId: "saved-1" })).rejects.toThrow();
    },
  );
});
