import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("memory commits (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-commit-test",
    traceId: "memory-commit-test",
    spaceId: "memory-commit-space",
    userId: "memory-commit-user",
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: context.spaceId,
        name: "Memory Test Organization",
        slug: context.spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: context.spaceId,
            name: "Memory Test Space",
            bots: {
              create: {
                id: "memory-commit-bot",
                userId: context.userId,
                name: "Memory Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: context.spaceId } });
    } finally {
      await close();
    }
  });

  function request(path: string, content: string): MemoryCommitRequest {
    return {
      scope: "user",
      path,
      content,
      sourceRunId: `run-${content}`,
      sourceThreadId: `thread-${content}`,
    };
  }

  async function document(path: string) {
    return prisma.memoryDocument.findFirstOrThrow({
      where: { spaceId: context.spaceId, path },
      include: { revisions: { orderBy: { revision: "asc" } } },
    });
  }
  it.each(["bot", "user"] as const)(
    "rejects remember/forget ABA after delete and recreation in %s memory",
    async (scope) => {
      const path = `aba-${scope}.md`,
        botId = scope === "bot" ? "memory-commit-bot" : undefined;
      const old = await store.commit(
        { scope, botId, path, content: "old generation", expectedRevision: 0 },
        context,
      );
      await store.forget(
        { scope, botId, path, expectedRevision: 1, expectedDocumentId: old.id },
        context,
      );
      const fresh = await store.commit(
        { scope, botId, path, content: "new generation", expectedRevision: 0 },
        context,
      );
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.revision).toBe(1);
      const stale = { scope, botId, path, expectedRevision: 1, expectedDocumentId: old.id };
      await expect(store.commit({ ...stale, content: "stale overwrite" }, context)).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );
      await expect(store.forget(stale, context)).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
      expect((await store.read({ scope, botId, path }, context)).documents[0]).toMatchObject({
        id: fresh.id,
        revision: 1,
        content: "new generation",
      });
      const saved = await store.commit(
        { ...stale, expectedDocumentId: fresh.id, content: "fresh overwrite" },
        context,
      );
      expect(saved.revision).toBe(2);
      await store.forget({ ...stale, expectedDocumentId: fresh.id, expectedRevision: 2 }, context);
      expect((await store.read({ scope, botId, path }, context)).documents).toEqual([]);
    },
  );

  it.each(["user", "bot"] as const)(
    "forgets only an owned current %s revision, cascades history, and stays absent on fresh retrieval",
    async (scope) => {
      const path = `forget-${scope}.md`;
      const botId = scope === "bot" ? "memory-commit-bot" : undefined;
      const initial = await store.commit(
        { ...request(path, `forgotten-${scope}`), scope, botId },
        context,
      );
      const updated = await store.commit(
        {
          ...request(path, `corrected-forgotten-${scope}`),
          scope,
          botId,
          expectedRevision: initial.revision,
        },
        context,
      );
      expect(await prisma.memoryRevision.count({ where: { documentId: initial.id } })).toBe(2);
      const read = await store.read({ scope, botId, path }, context);
      expect(read.documents[0]).toMatchObject({
        revision: 2,
        sourceRunId: `run-corrected-forgotten-${scope}`,
        sourceThreadId: `thread-corrected-forgotten-${scope}`,
      });
      const removal = {
        scope,
        botId,
        path,
        expectedRevision: updated.revision,
        expectedDocumentId: updated.id,
      };
      await expect(store.forget(removal, { ...context, userId: "foreign-owner" })).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );
      await expect(
        store.forget({ ...removal, expectedRevision: initial.revision }, context),
      ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
      expect((await store.read({ scope, botId, path }, context)).documents[0]?.revision).toBe(2);
      await store.forget(removal, context);
      expect(await prisma.memoryDocument.count({ where: { id: initial.id } })).toBe(0);
      expect(await prisma.memoryRevision.count({ where: { documentId: initial.id } })).toBe(0);
      const reopened = new MarkdownMemoryStore(prisma);
      expect(
        await reopened.read({ scope, botId, path }, { ...context, runId: "fresh-run" }),
      ).toEqual({ documents: [] });
      expect(await reopened.search({ scope: "all", query: `forgotten-${scope}` }, context)).toEqual(
        [],
      );
    },
  );

  it.each(["user", "bot"] as const)(
    "retries overlapping %s saves with fresh revisions and matching history",
    async (scope) => {
      const path = `concurrent-${scope}.md`;
      const write = (content: string): MemoryCommitRequest => ({
        ...request(path, content),
        scope,
        botId: scope === "bot" ? "memory-commit-bot" : undefined,
      });
      const initial = await store.commit(write("initial"), context);
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryDocument: {
              async findFirst({ args, query }) {
                const result = await query(args);
                reads += 1;
                // Both first attempts see revision 1 before either can write.
                if (reads === 2) release();
                if (reads <= 2) await bothRead;
                return result;
              },
            },
          },
        }) as PrismaClient,
      );

      const results = await Promise.allSettled([
        concurrentStore.commit(write("first"), context),
        concurrentStore.commit(write("second"), context),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(reads).toBe(3);
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(saved.map((result) => result.revision).sort()).toEqual([2, 3]);
      const current = await document(path);
      expect(current.revision).toBe(3);
      expect(current.content).toBe(saved.find((result) => result.revision === 3)!.content);
      expect(current.revisions).toHaveLength(3);
      for (const result of [initial, ...saved]) {
        expect(
          current.revisions.find((revision) => revision.revision === result.revision),
        ).toMatchObject({
          documentId: result.id,
          revision: result.revision,
          content: result.content,
          sourceRunId: `run-${result.content}`,
          sourceThreadId: `thread-${result.content}`,
        });
      }
    },
  );

  it.each([false, true])(
    "rolls back a rejected history insert and permits a caller retry (existing: %s)",
    async (existing) => {
      const path = `rejected-${existing}.md`;
      if (existing) await store.commit(request(path, "initial"), context);
      const before = await prisma.memoryDocument.findMany({
        where: { spaceId: context.spaceId, path },
        include: { revisions: true },
      });
      let inserts = 0;
      const rejectingStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryRevision: {
              async create({ args, query }) {
                inserts += 1;
                // Make PostgreSQL reject the history row after the document write.
                return query({
                  ...args,
                  data: {
                    ...args.data,
                    document: undefined,
                    documentId: "missing-memory-document",
                  },
                });
              },
            },
          },
        }) as PrismaClient,
      );

      await expect(rejectingStore.commit(request(path, "rejected"), context)).rejects.toMatchObject(
        {
          code: "P2003",
        },
      );
      expect(inserts).toBe(1);
      expect(
        await prisma.memoryDocument.findMany({
          where: { spaceId: context.spaceId, path },
          include: { revisions: true },
        }),
      ).toEqual(before);

      const retried = await store.commit(request(path, "rejected"), context);
      expect(retried.revision).toBe(existing ? 2 : 1);
      const current = await document(path);
      expect(current.revisions).toHaveLength(retried.revision);
      expect(current.revisions.at(-1)).toMatchObject({
        revision: retried.revision,
        content: retried.content,
      });
    },
  );

  it("bounds conflict retries, preserves only committed saves, and allows a later retry", async () => {
    const path = "exhausted.md";
    await store.commit(request(path, "initial"), context);
    let attempts = 0;
    const conflictingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              attempts += 1;
              // Invalidate every attempted snapshot with a separate committed save.
              await store.commit(request(path, `winner-${attempts}`), context);
              return result;
            },
          },
        },
      }) as PrismaClient,
    );

    await expect(conflictingStore.commit(request(path, "rejected"), context)).rejects.toMatchObject(
      {
        code: "P2034",
      },
    );
    expect(attempts).toBe(3);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 4, content: "winner-3" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "initial" },
      { revision: 2, content: "winner-1" },
      { revision: 3, content: "winner-2" },
      { revision: 4, content: "winner-3" },
    ]);

    const retried = await store.commit(request(path, "rejected"), context);
    expect(retried.revision).toBe(5);
    const afterRetry = await document(path);
    expect(afterRetry).toMatchObject({ revision: 5, content: "rejected" });
    expect(afterRetry.revisions).toHaveLength(5);
    expect(afterRetry.revisions.at(-1)).toMatchObject({ revision: 5, content: "rejected" });
  });
});
