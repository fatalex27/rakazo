import type { ConnectorTool } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  forgetMemoryDocumentFromTool,
  readMemoryDocumentFromTool,
  saveBotMemoryFromTool,
  selectMemoryTools,
} from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("read_memory_document"),
  tool("forget_memory_document"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "read_memory_document", "forget_memory_document", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

describe("native memory read and forget", () => {
  const context = {
    spaceId: "space",
    userId: "owner",
    operationId: "run",
    traceId: "run",
    signal: new AbortController().signal,
  };
  it("pages a whole Unicode document and keeps scope server-owned", async () => {
    const text = `${"🙂".repeat(1600)} final fact`;
    const read = vi.fn(async () => ({
      documents: [{ id: "doc", path: "facts.md", content: text, revision: 4 }],
    }));
    const first = await readMemoryDocumentFromTool(
      { read } as never,
      "bot",
      { path: "facts.md", botId: "foreign" },
      context,
    );
    const last = await readMemoryDocumentFromTool(
      { read } as never,
      "bot",
      { path: "facts.md", offset: first.nextOffset },
      context,
    );
    expect(first.nextOffset).toBe(1500);
    expect(last.nextOffset).toBeNull();
    expect(String(first.content) + String(last.content)).toBe(text);
    expect(read).toHaveBeenCalledWith({ scope: "bot", botId: "bot", path: "facts.md" }, context);
    expect(first.untrusted).toBe(true);
  });
  it("lists revisions and safely rejects unknown scopes and bad offsets", async () => {
    const read = vi.fn(async () => ({
      documents: [{ id: "doc", path: "facts.md", content: "private", revision: 4 }],
    }));
    const result = await readMemoryDocumentFromTool({ read } as never, "bot", {}, context);
    expect(result.documents).toEqual([
      { id: "doc", path: "facts.md", revision: 4, updatedAt: undefined },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(
      await readMemoryDocumentFromTool({ read } as never, "bot", { scope: "foreign" }, context),
    ).toHaveProperty("error");
    expect(
      await readMemoryDocumentFromTool({ read } as never, "bot", { offset: -1 }, context),
    ).toHaveProperty("error");
  });
  it("deletes only the server bot document after its persisted revision was supplied", async () => {
    const forget = vi.fn(async () => {});
    expect(
      await forgetMemoryDocumentFromTool(
        { forget } as never,
        "bot",
        { documentId: "doc", path: "facts.md", expectedRevision: 4, botId: "foreign" },
        context,
      ),
    ).toEqual({ ok: true, path: "facts.md", scope: "bot" });
    expect(forget).toHaveBeenCalledWith(
      {
        scope: "bot",
        botId: "bot",
        path: "facts.md",
        expectedRevision: 4,
        expectedDocumentId: "doc",
      },
      context,
    );
    forget.mockRejectedValueOnce(new Error("store failed"));
    expect(
      await forgetMemoryDocumentFromTool(
        { forget } as never,
        "bot",
        { documentId: "doc", path: "facts.md", expectedRevision: 4 },
        context,
      ),
    ).toMatchObject({ ok: false });
  });
  it("rejects unavailable deletion and missing revisions without writing", async () => {
    const forget = vi.fn();
    expect(
      await forgetMemoryDocumentFromTool(
        {} as never,
        "bot",
        { documentId: "doc", path: "facts.md", expectedRevision: 4 },
        context,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await forgetMemoryDocumentFromTool({ forget } as never, "bot", { path: "facts.md" }, context),
    ).toMatchObject({ ok: false });
    expect(forget).not.toHaveBeenCalled();
  });
});

describe("revision-checked bot memory saves", () => {
  const context = {
    spaceId: "space",
    userId: "user",
    operationId: "run",
    traceId: "run",
    runId: "run",
    threadId: "thread",
    signal: new AbortController().signal,
  };
  function fixture(revision = 3) {
    const read = vi.fn(async () => ({
      documents: [{ id: "doc", path: "MEMORY.md", content: "latest preference", revision }],
    }));
    const commit = vi.fn(async (request: { expectedRevision?: number }) => {
      if (request.expectedRevision !== revision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      return { id: "doc", path: "MEMORY.md", content: "corrected", revision: revision + 1 };
    });
    return { read, commit };
  }
  it("rejects stale full-document content and returns bounded current data", async () => {
    const memory = fixture();
    const result = await saveBotMemoryFromTool(
      memory as never,
      "bot",
      { documentId: "doc", content: "stale", expectedRevision: 2 },
      context,
    );
    expect(memory.commit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      revision: 3,
      content: "latest preference",
      untrusted: true,
    });
  });
  it("rejects a missing revision rather than overwriting", async () => {
    const memory = fixture();
    expect(
      await saveBotMemoryFromTool(memory as never, "bot", { content: "stale" }, context),
    ).toMatchObject({ ok: false });
    expect(memory.commit).not.toHaveBeenCalled();
    expect(
      await saveBotMemoryFromTool(
        memory as never,
        "bot",
        { content: "stale", expectedRevision: 3 },
        context,
      ),
    ).toMatchObject({ ok: false, id: "doc" });
    expect(memory.commit).not.toHaveBeenCalled();
  });
  it("returns the persisted revision only after successful commit", async () => {
    const memory = fixture();
    expect(
      await saveBotMemoryFromTool(
        memory as never,
        "bot",
        { documentId: "doc", content: "corrected", expectedRevision: 3 },
        context,
      ),
    ).toEqual({ ok: true, path: "MEMORY.md", revision: 4 });
    expect(memory.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "bot",
        botId: "bot",
        expectedRevision: 3,
        expectedDocumentId: "doc",
        sourceRunId: "run",
      }),
      context,
    );
  });
  it("reports a storage failure without claiming a save", async () => {
    const memory = fixture();
    memory.commit.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(
      await saveBotMemoryFromTool(
        memory as never,
        "bot",
        { documentId: "doc", content: "corrected", expectedRevision: 3 },
        context,
      ),
    ).toMatchObject({ ok: false });
  });
  it("reconciles a timeout after persistence instead of repeating the stale write", async () => {
    let revision = 3;
    let writes = 0;
    const memory = {
      read: async () => ({
        documents: [{ id: "doc", path: "MEMORY.md", content: "corrected", revision }],
      }),
      commit: async (request: { expectedRevision?: number }) => {
        if (request.expectedRevision !== revision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
        revision += 1;
        writes += 1;
        throw new Error("response lost after commit");
      },
    };
    const input = { documentId: "doc", content: "corrected", expectedRevision: 3 };
    expect(await saveBotMemoryFromTool(memory as never, "bot", input, context)).toMatchObject({
      ok: false,
    });
    expect(await saveBotMemoryFromTool(memory as never, "bot", input, context)).toMatchObject({
      ok: false,
      revision: 4,
      content: "corrected",
    });
    expect(writes).toBe(1);
  });
  it("bounds stale content without splitting Unicode and survives a failed conflict read", async () => {
    const memory = fixture();
    memory.read.mockResolvedValueOnce({
      documents: [{ id: "doc", path: "MEMORY.md", content: "🙂".repeat(3000), revision: 4 }],
    });
    const result = await saveBotMemoryFromTool(
      memory as never,
      "bot",
      { documentId: "doc", content: "stale", expectedRevision: 2 },
      context,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(7000);
    expect(String(result.content)).not.toContain("�");
    memory.read.mockRejectedValueOnce(new Error("read failed"));
    expect(
      await saveBotMemoryFromTool(
        memory as never,
        "bot",
        { documentId: "doc", content: "stale", expectedRevision: 2 },
        context,
      ),
    ).toMatchObject({ ok: false });
  });
});
