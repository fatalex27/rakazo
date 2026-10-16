import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

describe("native memory routes", () => {
  function fixture(found = true) {
    const document = {
      id: "doc",
      path: "facts.md",
      content: "Metric",
      revision: 3,
      scope: "bot",
      botId: "owned-bot",
    };
    const findFirst = vi.fn(async () => (found ? document : null));
    const forget = vi.fn(async () => {});
    const commit = vi.fn(async () => ({ ...document, revision: 4 }));
    const deps = {
      prisma: { memoryDocument: { findFirst } },
      memory: { forget, commit },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1",
        screenProxySecret: "fixture",
        sandboxProvider: "fake",
      },
      dataDir: "fixture",
    } as unknown as RouterDeps;
    const actor: Actor = {
      spaceId: "space",
      userId: "owner",
      email: "owner@rakazo.test",
      isDeploymentOwner: false,
    };
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    return { client, forget, commit, findFirst };
  }
  it("deletes only an owned document and forwards its revision and server bot", async () => {
    const f = fixture();
    expect(await f.client.memory.remove({ documentId: "doc", expectedRevision: 3 })).toEqual({
      ok: true,
    });
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "doc", spaceId: "space", userId: "owner" },
    });
    expect(f.forget).toHaveBeenCalledWith(
      {
        scope: "bot",
        botId: "owned-bot",
        path: "facts.md",
        expectedRevision: 3,
        expectedDocumentId: "doc",
      },
      expect.objectContaining({ spaceId: "space", userId: "owner" }),
    );
  });
  it("does not call a store for a foreign or missing document", async () => {
    const f = fixture(false);
    await expect(
      f.client.memory.remove({ documentId: "foreign", expectedRevision: 3 }),
    ).rejects.toThrow();
    expect(f.forget).not.toHaveBeenCalled();
  });
  it("passes the displayed revision when editing and propagates delete failures", async () => {
    const f = fixture();
    await f.client.memory.update({ documentId: "doc", content: "Corrected", expectedRevision: 3 });
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Corrected", expectedRevision: 3, botId: "owned-bot" }),
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
    );
    f.forget.mockRejectedValueOnce(new Error("storage failed"));
    await expect(
      f.client.memory.remove({ documentId: "doc", expectedRevision: 3 }),
    ).rejects.toThrow();
  });
});
