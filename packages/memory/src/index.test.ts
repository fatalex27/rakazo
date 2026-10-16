import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "memory-1",
        path: "facts.md",
        content: "A fact",
        revision: 3,
        updatedAt,
        revisions: [{ sourceRunId: "run-1", sourceThreadId: "thread-1" }],
      },
    ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
          sourceRunId: "run-1",
          sourceThreadId: "thread-1",
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
      include: {
        revisions: {
          orderBy: { revision: "desc" },
          take: 1,
          select: { sourceRunId: true, sourceThreadId: true },
        },
      },
    });
  });

  it("rejects a stale revision inside the transaction without changing data or history", async () => {
    const tx = {
      memoryDocument: {
        findFirst: vi.fn(async () => ({ id: "doc", revision: 4 })),
        update: vi.fn(),
        create: vi.fn(),
      },
      memoryRevision: { create: vi.fn() },
    };
    const store = new MarkdownMemoryStore({
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    } as never);
    await expect(
      store.commit(
        { scope: "bot", botId: "bot-1", path: "facts.md", content: "stale", expectedRevision: 3 },
        context,
      ),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(tx.memoryDocument.findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
        path: "facts.md",
      },
    });
    expect(tx.memoryDocument.update).not.toHaveBeenCalled();
    expect(tx.memoryDocument.create).not.toHaveBeenCalled();
    expect(tx.memoryRevision.create).not.toHaveBeenCalled();
  });
  it("deletes the owned document at its current revision and refuses stale or missing records", async () => {
    const tx = {
      memoryDocument: {
        findFirst: vi.fn(async () => ({ id: "owned", revision: 3 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const store = new MarkdownMemoryStore({
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    } as never);
    const request = {
      scope: "bot" as const,
      botId: "bot-1",
      path: "facts.md",
      expectedRevision: 3,
      expectedDocumentId: "owned",
    };
    await store.forget(request, context);
    expect(tx.memoryDocument.findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
        path: "facts.md",
      },
    });
    expect(tx.memoryDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: "owned", revision: 3, spaceId: "workspace-1", userId: "user-1" },
    });
    await expect(store.forget({ ...request, expectedRevision: 2 }, context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    expect(tx.memoryDocument.deleteMany).toHaveBeenCalledOnce();
    await expect(store.forget({ ...request, botId: undefined }, context)).rejects.toThrow();
  });
  it.each(["bot", "user"] as const)(
    "rejects stale generation tokens at the same revision for %s memory",
    async (scope) => {
      const current = { id: "new-generation", revision: 1, path: "facts.md", content: "recreated" };
      const tx = {
        memoryDocument: {
          findFirst: vi.fn(async () => current),
          update: vi.fn(async () => ({ ...current, revision: 2 })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
        memoryRevision: { create: vi.fn() },
      };
      const store = new MarkdownMemoryStore({
        $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
      } as never);
      const stale = {
        scope,
        botId: scope === "bot" ? "bot-1" : undefined,
        path: "facts.md",
        expectedRevision: 1,
        expectedDocumentId: "deleted-generation",
      };
      await expect(store.commit({ ...stale, content: "stale" }, context)).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );
      await expect(store.forget(stale, context)).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
      expect(tx.memoryDocument.update).not.toHaveBeenCalled();
      expect(tx.memoryDocument.deleteMany).not.toHaveBeenCalled();
      await store.commit({ ...stale, expectedDocumentId: current.id, content: "fresh" }, context);
      await store.forget({ ...stale, expectedDocumentId: current.id }, context);
      expect(tx.memoryDocument.update).toHaveBeenCalledOnce();
      expect(tx.memoryDocument.deleteMany).toHaveBeenCalledOnce();
    },
  );
});
