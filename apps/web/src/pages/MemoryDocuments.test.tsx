// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { memory } }));
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: vi.fn() }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Skeleton: () => <div />,
}));

import { SpaceMemorySection } from "./KnowledgeSection";

beforeEach(() => {
  vi.resetAllMocks();
});
const doc = {
  id: "doc",
  path: "facts.md",
  content: "Metric units",
  revision: 3,
  scope: "user",
  botId: null,
  updatedAt: "2026-10-01T00:00:00Z",
};

async function mounted() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SpaceMemorySection />));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(label),
    );
    if (!button) throw new Error(`Missing button ${label}`);
    await act(async () => button.click());
  };
  return {
    container,
    root,
    click,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("deletes using the displayed revision, reloads and stays absent after reopening", async () => {
  let stored = [doc];
  memory.list.mockImplementation(async () => stored);
  memory.remove.mockImplementation(async () => {
    stored = [];
    return { ok: true };
  });
  const ui = await mounted();
  try {
    await ui.click("facts.md");
    await ui.click("Delete");
    expect(memory.remove).toHaveBeenCalledWith({ documentId: "doc", expectedRevision: 3 });
    expect(memory.list).toHaveBeenCalledTimes(2);
    expect(ui.container.textContent).not.toContain("facts.md");
  } finally {
    await ui.close();
  }
  const reopened = await mounted();
  try {
    expect(reopened.container.textContent).not.toContain("facts.md");
  } finally {
    await reopened.close();
  }
});

it("keeps a document visible when deletion fails", async () => {
  memory.list.mockResolvedValue([doc]);
  memory.remove.mockRejectedValue(new Error("conflict"));
  const ui = await mounted();
  try {
    await ui.click("facts.md");
    await ui.click("Delete");
    expect(ui.container.textContent).toContain("facts.md");
    expect(ui.container.textContent).toContain("Could not delete");
    expect(ui.container.querySelector("textarea")?.value).toBe("Metric units");
  } finally {
    await ui.close();
  }
});

it("sends the displayed revision when saving an edit", async () => {
  memory.list.mockResolvedValue([doc]);
  memory.update.mockResolvedValue({ ...doc, content: "Corrected", revision: 4 });
  const ui = await mounted();
  try {
    await ui.click("facts.md");
    const textarea = ui.container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Corrected",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ui.click("Save");
    expect(memory.update).toHaveBeenCalledWith({
      documentId: "doc",
      content: "Corrected",
      expectedRevision: 3,
    });
    await ui.click("facts.md");
    expect(ui.container.querySelector("textarea")?.value).toBe("Corrected");
  } finally {
    await ui.close();
  }
});
