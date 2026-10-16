ALTER TABLE "agent_skills" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "taught_skills" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "skill_revisions" (
  "id" TEXT NOT NULL,
  "agentSkillId" TEXT,
  "taughtSkillId" TEXT,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "restoredFrom" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "skill_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_revisions_one_parent" CHECK (("agentSkillId" IS NULL) <> ("taughtSkillId" IS NULL)),
  CONSTRAINT "skill_revisions_positive_revision" CHECK ("revision" > 0),
  CONSTRAINT "skill_revisions_agentSkillId_fkey" FOREIGN KEY ("agentSkillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "skill_revisions_taughtSkillId_fkey" FOREIGN KEY ("taughtSkillId") REFERENCES "taught_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "skill_revisions_agentSkillId_revision_key" ON "skill_revisions"("agentSkillId", "revision");
CREATE UNIQUE INDEX "skill_revisions_taughtSkillId_revision_key" ON "skill_revisions"("taughtSkillId", "revision");
