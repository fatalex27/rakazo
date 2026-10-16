// @vitest-environment jsdom
import type { SkillPlaybook } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  updateDraft: vi.fn(),
  save: vi.fn(),
  testRun: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { skills: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _v, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Label: ({ children }: ComponentProps<"label">) => <span>{children}</span>,
}));

import { SkillDraftCard } from "./SkillDraftCard";

const playbook: SkillPlaybook = {
  whenToUse: "Review persisted status",
  inputs: ["expected value"],
  steps: ["Read stored result", "Compare value"],
  howToCheck: "Persisted value equals expected",
  whatToReturn: "Result source",
  approvalBoundaries: "No external writes",
  failureHandling: "Report mismatch",
};
beforeEach(() => {
  vi.resetAllMocks();
});

async function render(revision: number | undefined) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    onRefresh = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <SkillDraftCard
        block={{
          kind: "skill_draft",
          skillId: "skill-test",
          name: "Review status",
          goal: "Check setting",
          playbook,
          status: "draft",
          revision,
        }}
        onRefresh={onRefresh}
        onAddRoutine={() => {}}
      />,
    ),
  );
  return {
    container,
    onRefresh,
    click: async (text: string) => {
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
      if (!button) throw new Error(`Missing ${text}`);
      await act(async () => button.click());
    },
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("chains returned revisions through save and reuses the persisted revision on a second save", async () => {
  api.updateDraft.mockResolvedValueOnce({ revision: 6 }).mockResolvedValueOnce({ revision: 8 });
  api.save.mockResolvedValueOnce({ revision: 7 }).mockResolvedValueOnce({ revision: 9 });
  const view = await render(5);
  try {
    await view.click("Save");
    expect(api.updateDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedRevision: 5 }),
    );
    expect(api.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedRevision: 6 }));
    await view.click("Saved");
    expect(api.updateDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: 7 }),
    );
    expect(api.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedRevision: 8 }));
  } finally {
    await view.dispose();
  }
});

it("recovers from a save conflict by explicitly reloading the persisted recipe", async () => {
  api.updateDraft
    .mockRejectedValueOnce(new Error("Skill changed. Read it again."))
    .mockResolvedValueOnce({ revision: 9 });
  api.get.mockResolvedValue({ revision: 8, name: "Latest recipe", playbook, status: "draft" });
  api.save.mockResolvedValue({ revision: 10 });
  const view = await render(5);
  try {
    await view.click("Save");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Skill changed");
    expect(api.save).not.toHaveBeenCalled();
    expect(api.testRun).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Saved");
    expect(view.container.querySelector("input")?.value).toBe("Review status");
    await view.click("Reload");
    expect(view.container.querySelector("input")?.value).toBe("Latest recipe");
    await view.click("Save");
    expect(api.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 8, name: "Latest recipe" }),
    );
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 9 }));
  } finally {
    await view.dispose();
  }
});

it("loads a legacy message's current recipe before enabling its editor", async () => {
  api.get.mockResolvedValue({ revision: 12, name: "Current recipe", playbook, status: "draft" });
  api.updateDraft.mockResolvedValue({ revision: 13 });
  api.save.mockResolvedValue({ revision: 14 });
  const view = await render(undefined);
  try {
    expect(api.get).toHaveBeenCalledWith({ skillId: "skill-test" });
    expect(view.container.querySelector("input")?.value).toBe("Current recipe");
    await view.click("Save");
    expect(api.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 12, name: "Current recipe" }),
    );
  } finally {
    await view.dispose();
  }
});

it("test runs do not change the recipe into a verified or saved result", async () => {
  api.updateDraft.mockResolvedValue({ revision: 6 });
  api.testRun.mockResolvedValue({ runId: "synthetic-test" });
  const view = await render(5);
  try {
    await view.click("Test");
    expect(api.testRun).toHaveBeenCalledWith({ skillId: "skill-test" });
    expect(api.save).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Saved");
  } finally {
    await view.dispose();
  }
});
