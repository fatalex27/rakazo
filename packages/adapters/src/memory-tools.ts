import type { AdapterContext, ConnectorTool, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";

/** Full-document writes must name the revision the caller actually read. */
export async function saveBotMemoryFromTool(
  memory: MemoryStore,
  botId: string,
  input: Record<string, unknown>,
  context: AdapterContext,
  sourceThreadId?: string,
): Promise<Record<string, unknown>> {
  const path = String(input.path ?? "MEMORY.md");
  const expectedRevision = input.expectedRevision;
  const current = async () => {
    const snapshot = await memory.read({ scope: "bot", botId, path }, context);
    const document = snapshot.documents[0];
    const content = Array.from(document?.content ?? "")
      .slice(0, 1500)
      .join("");
    return {
      untrusted: true,
      path,
      id: document?.id,
      revision: document?.revision ?? 0,
      content,
      truncated: content !== (document?.content ?? ""),
    };
  };
  try {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 0 ||
      ((expectedRevision as number) > 0 &&
        (typeof input.documentId !== "string" || !input.documentId))
    ) {
      return {
        ok: false,
        error:
          "Provide documentId and expectedRevision from the memory context, or revision 0 for a new document.",
        ...(await current()),
      };
    }
    const saved = await memory.commit(
      {
        scope: "bot",
        botId,
        path,
        content: String(input.content ?? ""),
        expectedRevision: expectedRevision as number,
        expectedDocumentId: (expectedRevision as number) > 0 ? String(input.documentId) : undefined,
        sourceRunId: context.runId,
        sourceThreadId,
      },
      context,
    );
    return { ok: true, path: saved.path, revision: saved.revision };
  } catch (error) {
    if (error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR) {
      try {
        return { ok: false, error: MEMORY_REVISION_CONFLICT_ERROR, ...(await current()) };
      } catch {
        // A failed reconciliation read must never be presented as a successful save.
      }
    }
    return {
      ok: false,
      error: "Memory was not confirmed saved. Read the current document before retrying.",
    };
  }
}

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);
const NATIVE_MEMORY_TOOL_NAMES = new Set([
  "remember",
  "read_memory_document",
  "forget_memory_document",
]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => !NATIVE_MEMORY_TOOL_NAMES.has(tool.name))
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

export async function readMemoryDocumentFromTool(
  memory: MemoryStore,
  botId: string,
  input: Record<string, unknown>,
  context: AdapterContext,
): Promise<Record<string, unknown>> {
  if (input.scope !== undefined && input.scope !== "bot" && input.scope !== "user")
    return { error: "Invalid memory scope." };
  const scope = input.scope === "user" ? "user" : "bot";
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0)
    return { error: "Invalid memory offset." };
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path && path.length > 512)
    return { error: "Memory path exceeds the tool response budget. Use the memory settings." };
  const snapshot = await memory.read(
    { scope, ...(scope === "bot" ? { botId } : {}), ...(path ? { path } : {}) },
    context,
  );
  if (!path) {
    const documents = snapshot.documents
      .slice(offset as number, (offset as number) + 20)
      .map(({ id, path, revision, updatedAt }) => ({ id, path, revision, updatedAt }));
    if (Buffer.byteLength(JSON.stringify(documents), "utf8") > 8000)
      return {
        error:
          "Memory metadata exceeds the response budget. Use a specific path or the memory settings.",
      };
    return {
      untrusted: true,
      scope,
      documents,
      nextOffset:
        (offset as number) + 20 < snapshot.documents.length ? (offset as number) + 20 : null,
    };
  }
  const document = snapshot.documents[0];
  if (!document)
    return { untrusted: true, scope, path, revision: 0, content: "", nextOffset: null };
  const characters = Array.from(document.content);
  const content = characters.slice(offset as number, (offset as number) + 1500).join("");
  return {
    untrusted: true,
    scope,
    path,
    id: document.id,
    revision: document.revision,
    updatedAt: document.updatedAt,
    sourceRunId: document.sourceRunId,
    sourceThreadId: document.sourceThreadId,
    content,
    nextOffset: (offset as number) + 1500 < characters.length ? (offset as number) + 1500 : null,
  };
}

export async function forgetMemoryDocumentFromTool(
  memory: MemoryStore,
  botId: string,
  input: Record<string, unknown>,
  context: AdapterContext,
): Promise<Record<string, unknown>> {
  if (!memory.forget)
    return { ok: false, error: "This memory store does not support deleting documents." };
  if (input.scope !== undefined && input.scope !== "bot" && input.scope !== "user")
    return { ok: false, error: "Invalid memory scope." };
  if (
    typeof input.path !== "string" ||
    !input.path ||
    typeof input.documentId !== "string" ||
    !input.documentId ||
    input.path.length > 512 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1
  )
    return { ok: false, error: "Provide path and the current expectedRevision." };
  const scope = input.scope === "user" ? "user" : "bot";
  try {
    await memory.forget(
      {
        scope,
        ...(scope === "bot" ? { botId } : {}),
        path: input.path,
        expectedRevision: input.expectedRevision as number,
        expectedDocumentId: input.documentId,
      },
      context,
    );
    return { ok: true, path: input.path, scope };
  } catch {
    return {
      ok: false,
      error: "Memory was not confirmed deleted. Read the current document before retrying.",
    };
  }
}
