import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  listSkillRevisions,
  SkillRevisionConflict,
  skillRevisionSnapshot,
  writeSkillRevision,
} from "./skill-revisions.js";

const owner = { spaceId: "space-test", userId: "user-test" };
function database(kind: "agent" | "taught" = "agent", extra: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = {
    id: "recipe-1",
    ...owner,
    name: "Review persisted status",
    description: "Read-only synthetic verification",
    content:
      "Read the stored result; compare expected state; return evidence. Do not send or spend.",
    source: "user",
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    status: "saved",
    goal: "Verify a saved setting",
    playbook: {
      steps: ["Reopen saved setting", "Compare expected value"],
      approvalBoundaries: "No external writes",
    },
    ...extra,
  };
  let revisions: Array<Record<string, unknown>> = [];
  let failHistory = false;
  const matches = (record: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in v
        ? (v.in as unknown[]).includes(record[k])
        : record[k] === v,
    );
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone(row),
        oldHistory = structuredClone(revisions);
      try {
        return await fn(db);
      } catch (e) {
        row = before;
        revisions = oldHistory;
        throw e;
      }
    },
    agentSkill: {},
    taughtSkill: {},
    skillRevision: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        revisions
          .filter((r) => matches(r, where))
          .slice()
          .reverse(),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        revisions.find((r) => matches(r, where)) ?? null,
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        if (failHistory) throw new Error("History store unavailable");
        for (const entry of data) {
          if (!revisions.some((r) => r.revision === entry.revision))
            revisions.push({ createdAt: new Date(), restoredFrom: null, ...entry });
        }
      },
    },
  };
  db[kind === "agent" ? "agentSkill" : "taughtSkill"] = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      matches(row, where) ? structuredClone(row) : null,
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (!matches(row, where)) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },
  };
  return {
    prisma: db as unknown as PrismaClient,
    current: () => row,
    history: () => revisions,
    fail: () => {
      failHistory = true;
    },
  };
}

describe("skill revision snapshots", () => {
  it("keeps the executable recipe but excludes recordings and credentials", () => {
    expect(
      skillRevisionSnapshot("taught", {
        name: "Review status",
        goal: "Check a result",
        status: "saved",
        playbook: { steps: ["Read the persisted result"] },
        recording: { events: [{ text: "private" }] },
        secret: "private",
      }),
    ).toEqual({
      name: "Review status",
      goal: "Check a result",
      status: "saved",
      playbook: { steps: ["Read the persisted result"] },
    });
  });

  it("captures the legacy baseline and appends an independently reviewable restore", async () => {
    const db = database();
    const original = String(db.current().content);
    await expect(listSkillRevisions(db.prisma, owner, "agent", "recipe-1")).resolves.toMatchObject([
      { revision: 1 },
    ]);
    await writeSkillRevision(db.prisma, owner, "agent", {
      skillId: "recipe-1",
      expectedRevision: 1,
      data: { name: "Review persisted status", description: "Draft", content: "Unverified draft" },
    });
    await expect(
      writeSkillRevision(db.prisma, owner, "agent", {
        skillId: "recipe-1",
        expectedRevision: 2,
        targetRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 3, content: original });
    expect(db.history()).toMatchObject([
      { revision: 1 },
      { revision: 2 },
      { revision: 3, source: "restore", restoredFrom: 1 },
    ]);
    expect(db.history()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ verified: true })]),
    );
  });

  it("rejects a stale revision and leaves the newer recipe untouched", async () => {
    const db = database("agent", { revision: 2 });
    await expect(
      writeSkillRevision(db.prisma, owner, "agent", {
        skillId: "recipe-1",
        expectedRevision: 1,
        targetRevision: 1,
      }),
    ).rejects.toBeInstanceOf(SkillRevisionConflict);
    expect(db.current().revision).toBe(2);
    expect(db.history()).toEqual([]);
  });

  it.each([
    { ...owner, userId: "other-user" },
    { ...owner, spaceId: "other-space" },
  ])("denies foreign history and restore", async (foreign) => {
    const db = database();
    await expect(listSkillRevisions(db.prisma, foreign, "agent", "recipe-1")).rejects.toThrow(
      "not found",
    );
    await expect(
      writeSkillRevision(db.prisma, foreign, "agent", {
        skillId: "recipe-1",
        expectedRevision: 1,
        targetRevision: 1,
      }),
    ).rejects.toThrow("not found");
  });

  it.each(["builtin", "plugin"])("keeps %s recipes immutable", async (source) => {
    const db = database("agent", { source });
    await expect(
      writeSkillRevision(db.prisma, owner, "agent", {
        skillId: "recipe-1",
        expectedRevision: 1,
        targetRevision: 1,
      }),
    ).rejects.toThrow("read-only");
  });

  it("rolls back the current recipe if historical storage fails", async () => {
    const db = database();
    db.fail();
    await expect(
      writeSkillRevision(db.prisma, owner, "agent", {
        skillId: "recipe-1",
        expectedRevision: 1,
        data: { name: "Bad", description: "Bad", content: "Bad" },
      }),
    ).rejects.toThrow("unavailable");
    expect(db.current()).toMatchObject({ revision: 1, name: "Review persisted status" });
  });

  it("versions a synthetic settings playbook without copying recorded private input", async () => {
    const db = database("taught", { recording: { events: [{ text: "private-input" }] } });
    await writeSkillRevision(db.prisma, owner, "taught", {
      skillId: "recipe-1",
      expectedRevision: 1,
      data: {
        name: "Reopen setting",
        status: "saved",
        playbook: {
          steps: ["Reopen and compare"],
          howToCheck: "Persisted value matches",
          approvalBoundaries: "No external writes",
        },
      },
    });
    await expect(
      writeSkillRevision(db.prisma, owner, "taught", {
        skillId: "recipe-1",
        expectedRevision: 2,
        targetRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 3, status: "saved" });
    expect(JSON.stringify(db.history())).not.toContain("private-input");
    expect(db.current().recording).toEqual({ events: [{ text: "private-input" }] });
  });

  it("refuses restoring into an active teaching session", async () => {
    const db = database("taught", { status: "recording" });
    await expect(
      writeSkillRevision(db.prisma, owner, "taught", {
        skillId: "recipe-1",
        expectedRevision: 1,
        targetRevision: 1,
      }),
    ).rejects.toThrow("Finish recording");
  });
});
