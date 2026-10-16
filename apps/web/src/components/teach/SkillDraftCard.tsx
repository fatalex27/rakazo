import { Trans } from "@lingui/react/macro";
import type { SkillPlaybook } from "@rakazo/contracts";
import { formatSkillRunPrompt } from "@rakazo/core";
import { Button, Input, Label, Textarea } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  revision?: number;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

function fieldLabel(id: string, title: React.ReactNode) {
  return (
    <Label htmlFor={id} className="mt-3 mb-1 text-[13px] font-normal text-muted-foreground">
      {title}
    </Label>
  );
}

export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  const [saved, setSaved] = useState(block.status === "saved");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState<number | null>(block.revision ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(block.name);
    setPlaybook(block.playbook);
    setSaved(block.status === "saved");
    setRevision(block.revision ?? null);
    setError(null);
    if (block.revision !== undefined) return;
    let active = true;
    // Old draft messages predate revision metadata. Load their current recipe before editing.
    void rpc.skills
      .get({ skillId: block.skillId })
      .then((skill) => {
        if (!active) return;
        setName(skill.name);
        setPlaybook(skill.playbook);
        setSaved(skill.status === "saved");
        setRevision(skill.revision ?? 1);
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [block.skillId, block.status, block.revision]);

  async function saveDraft() {
    if (busy || revision === null) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.skills.updateDraft({
        skillId: block.skillId,
        name,
        playbook,
        expectedRevision: revision,
      });
      setRevision(updated.revision ?? revision + 1);
      const persisted = await rpc.skills.save({
        skillId: block.skillId,
        name,
        expectedRevision: updated.revision ?? revision + 1,
      });
      setRevision(persisted.revision ?? revision + 2);
      setSaved(true);
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    if (busy || revision === null) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.skills.updateDraft({
        skillId: block.skillId,
        name,
        playbook,
        expectedRevision: revision,
      });
      setRevision(updated.revision ?? revision + 1);
      await rpc.skills.testRun({ skillId: block.skillId });
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function reloadDraft() {
    if (busy) return;
    setBusy(true);
    try {
      const skill = await rpc.skills.get({ skillId: block.skillId });
      setName(skill.name);
      setPlaybook(skill.playbook);
      setSaved(skill.status === "saved");
      setRevision(skill.revision ?? 1);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const skillName = name || block.name || block.goal.slice(0, 80);

  return (
    <div
      data-testid="skill-draft-card"
      className="w-[min(520px,92%)] rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[15px] font-medium text-foreground">
        <Trans>Draft skill</Trans>
      </div>
      <div className="mt-1 text-[13.5px] text-muted-foreground">{block.goal}</div>
      {error && (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {error}
          <Button variant="outline" disabled={busy} onClick={() => void reloadDraft()}>
            <Trans>Reload</Trans>
          </Button>
        </div>
      )}
      <fieldset disabled={busy || revision === null} className="m-0 min-w-0 border-0 p-0">
        {fieldLabel("skill-draft-name", <Trans>Name</Trans>)}
        <Input
          id="skill-draft-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {fieldLabel("skill-draft-when", <Trans>When to use</Trans>)}
        <Textarea
          id="skill-draft-when"
          value={playbook.whenToUse}
          onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
          rows={2}
        />
        {fieldLabel("skill-draft-inputs", <Trans>Inputs</Trans>)}
        <Textarea
          id="skill-draft-inputs"
          value={playbook.inputs.join("\n")}
          onChange={(event) =>
            setPlaybook({
              ...playbook,
              inputs: event.target.value.split("\n"),
            })
          }
          rows={2}
        />
        {fieldLabel("skill-draft-steps", <Trans>Steps</Trans>)}
        <Textarea
          id="skill-draft-steps"
          value={playbook.steps.join("\n")}
          onChange={(event) =>
            setPlaybook({
              ...playbook,
              steps: event.target.value.split("\n"),
            })
          }
          rows={5}
        />
        {fieldLabel("skill-draft-check", <Trans>How to check</Trans>)}
        <Textarea
          id="skill-draft-check"
          value={playbook.howToCheck}
          onChange={(event) => setPlaybook({ ...playbook, howToCheck: event.target.value })}
          rows={2}
        />
        {fieldLabel("skill-draft-return", <Trans>What to return</Trans>)}
        <Textarea
          id="skill-draft-return"
          value={playbook.whatToReturn}
          onChange={(event) => setPlaybook({ ...playbook, whatToReturn: event.target.value })}
          rows={2}
        />
        {fieldLabel("skill-draft-approval", <Trans>Approval boundaries</Trans>)}
        <Textarea
          id="skill-draft-approval"
          value={playbook.approvalBoundaries}
          onChange={(event) => setPlaybook({ ...playbook, approvalBoundaries: event.target.value })}
          rows={2}
        />
        {fieldLabel("skill-draft-failure", <Trans>Failure handling</Trans>)}
        <Textarea
          id="skill-draft-failure"
          value={playbook.failureHandling}
          onChange={(event) => setPlaybook({ ...playbook, failureHandling: event.target.value })}
          rows={2}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void saveDraft()}>
            {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void testDraft()}>
            <Trans>Test</Trans>
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onAddRoutine(skillName, formatSkillRunPrompt(skillName, playbook))}
          >
            <Trans>Add to routine</Trans>
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
