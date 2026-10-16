import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import {
  listSkillRevisions,
  SkillRevisionConflict,
  writeSkillRevision,
} from "./skill-revisions.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
postgres("skill revisions (isolated PostgreSQL synthetic recipes)", () => {
  const schema = `skill_test_${randomUUID().replaceAll("-", "")}`;
  const owner = { userId: "synthetic-user", spaceId: "synthetic-space" };
  let pool: Pool;
  let prisma: PrismaClient;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".agent_skills (LIKE public.agent_skills INCLUDING ALL);
      CREATE TABLE "${schema}".taught_skills (LIKE public.taught_skills INCLUDING ALL);
      CREATE TABLE "${schema}".skill_revisions (LIKE public.skill_revisions INCLUDING ALL);
      ALTER TABLE "${schema}".skill_revisions ADD FOREIGN KEY ("agentSkillId") REFERENCES "${schema}".agent_skills(id) ON DELETE CASCADE;
      ALTER TABLE "${schema}".skill_revisions ADD FOREIGN KEY ("taughtSkillId") REFERENCES "${schema}".taught_skills(id) ON DELETE CASCADE;`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
  beforeEach(async () => {
    await prisma.skillRevision.deleteMany();
    await prisma.agentSkill.deleteMany();
    await prisma.taughtSkill.deleteMany();
  });
  async function agent() {
    return prisma.agentSkill.create({
      data: {
        ...owner,
        name: "Review persisted result",
        description: "Synthetic read-only recipe",
        content:
          "Read persisted result; compare expected value; return source. No external writes.",
      },
    });
  }
  const replacement = {
    name: "Review persisted result",
    description: "Edited draft",
    content: "Unverified replacement",
  };

  it("allows exactly one concurrent writer and preserves the prior recipe", async () => {
    const skill = await agent();
    const input = { skillId: skill.id, expectedRevision: 1, data: replacement };
    const results = await Promise.allSettled([
      writeSkillRevision(prisma, owner, "agent", input),
      writeSkillRevision(prisma, owner, "agent", input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      SkillRevisionConflict,
    );
    expect(await prisma.agentSkill.findUnique({ where: { id: skill.id } })).toMatchObject({
      revision: 2,
    });
    expect(await prisma.skillRevision.count()).toBe(2);
    const restored = await writeSkillRevision(prisma, owner, "agent", {
      skillId: skill.id,
      expectedRevision: 2,
      targetRevision: 1,
    });
    expect(restored).toMatchObject({ revision: 3, content: skill.content });
    const history = await listSkillRevisions(prisma, owner, "agent", skill.id);
    expect(history.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(history.every((r) => !("snapshot" in r))).toBe(true);
    expect(await listSkillRevisions(prisma, owner, "agent", skill.id, 1)).toMatchObject([
      { snapshot: { content: skill.content } },
    ]);
  });

  it("rolls back a recipe update when revision persistence fails", async () => {
    const skill = await agent();
    await pool.query(
      `ALTER TABLE "${schema}".skill_revisions ADD CONSTRAINT reject_new_revision CHECK (revision < 2)`,
    );
    try {
      await expect(
        writeSkillRevision(prisma, owner, "agent", {
          skillId: skill.id,
          expectedRevision: 1,
          data: replacement,
        }),
      ).rejects.toThrow();
      expect(await prisma.agentSkill.findUnique({ where: { id: skill.id } })).toMatchObject({
        revision: 1,
        content: skill.content,
      });
      expect(await prisma.skillRevision.count()).toBe(0);
    } finally {
      await pool.query(
        `ALTER TABLE "${schema}".skill_revisions DROP CONSTRAINT reject_new_revision`,
      );
    }
  });

  it("scopes history and restore to the owner and keeps builtin/plugin readonly", async () => {
    const skill = await agent();
    await writeSkillRevision(prisma, owner, "agent", {
      skillId: skill.id,
      expectedRevision: 1,
      data: replacement,
    });
    for (const foreign of [
      { ...owner, userId: "other-user" },
      { ...owner, spaceId: "other-space" },
    ]) {
      await expect(listSkillRevisions(prisma, foreign, "agent", skill.id, 1)).rejects.toThrow(
        "not found",
      );
      await expect(
        writeSkillRevision(prisma, foreign, "agent", {
          skillId: skill.id,
          expectedRevision: 2,
          targetRevision: 1,
        }),
      ).rejects.toThrow("not found");
    }
    for (const source of ["builtin", "plugin"]) {
      await prisma.agentSkill.update({ where: { id: skill.id }, data: { source } });
      await expect(
        writeSkillRevision(prisma, owner, "agent", {
          skillId: skill.id,
          expectedRevision: 2,
          targetRevision: 1,
        }),
      ).rejects.toThrow("read-only");
    }
  });

  it("restores a settings playbook without recording data and cascades deletion", async () => {
    const playbook = {
      whenToUse: "Recheck a setting",
      inputs: ["expected"],
      steps: ["Reopen stored setting", "Compare"],
      howToCheck: "Matches expected",
      whatToReturn: "Persisted source",
      approvalBoundaries: "No external writes",
      failureHandling: "Report mismatch",
    };
    const skill = await prisma.taughtSkill.create({
      data: {
        ...owner,
        botId: "synthetic-bot",
        name: "Verify reopened setting",
        goal: "Check setting",
        status: "saved",
        playbook,
        recording: { events: [{ text: "synthetic-private-input" }] },
      },
    });
    await writeSkillRevision(prisma, owner, "taught", {
      skillId: skill.id,
      expectedRevision: 1,
      data: {
        name: skill.name,
        status: "saved",
        playbook: { ...playbook, steps: ["Changed draft"] },
      },
    });
    const restored = await writeSkillRevision(prisma, owner, "taught", {
      skillId: skill.id,
      expectedRevision: 2,
      targetRevision: 1,
    });
    expect(restored).toMatchObject({ revision: 3, playbook, recording: skill.recording });
    expect(
      JSON.stringify(await listSkillRevisions(prisma, owner, "taught", skill.id, 1)),
    ).not.toContain("synthetic-private-input");
    await prisma.taughtSkill.delete({ where: { id: skill.id } });
    expect(await prisma.skillRevision.count()).toBe(0);
  });
});
