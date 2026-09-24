"use client";

import type { Job } from "@/lib/jobs";
import { mergeWithDefaults } from "@/lib/param-storage";
import type { RunModes } from "@/lib/workflows/modes";
import { effectiveWorkflow } from "@/lib/workflows/turbo";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

/**
 * What a past generation comes back as, read against the workflow as it is
 * today rather than as it was when the run was made.
 *
 * Everything a run was, not only its values: the mode switches are as much a
 * part of how a take came out as any control, and the steps range depends on
 * turbo, so the values are merged against the workflow *as that mode has it*.
 *
 * Every id is checked against what the workflow still offers, and anything it
 * has dropped is dropped here. That rule is the whole reason this exists as one
 * function: a switch since renamed would be sent on the next run and refused by
 * the server over a control the form never showed, and a strength kept for an
 * entry the list no longer carries would quietly change a run nobody asked to
 * change. There are two callers wanting the same answer — the form's
 * `Reuse settings` and the history's `Retry` — and two copies of these filters
 * would be two chances to disagree about it.
 *
 * The seed is the one thing the two callers want differently, so it is left
 * here and taken out there. See `reuseSettings`.
 */
export interface Restored extends RunModes {
  values: Record<string, ParamValue>;
  turbo: boolean;
  patches: string[];
  lora: Record<string, string>;
  strengths: Record<string, number>;
  tier: Record<string, string>;
  alternateBase: Record<string, boolean>;
}

export function restoreFrom(job: Job, workflow: WorkflowSummary): Restored {
  const turbo = Boolean(job.turbo) && Boolean(workflow.turbo);
  const values = mergeWithDefaults(
    effectiveWorkflow(workflow, turbo),
    job.resolved,
  );

  const lora: Record<string, string> = {};
  const strengths: Record<string, number> = {};
  const tier: Record<string, string> = {};
  const alternateBase: Record<string, boolean> = {};

  for (const patch of workflow.patches) {
    const applied = job.loras?.[patch.id];
    const chosen = applied?.choice;
    const option = patch.choices?.options.find(
      (candidate) => candidate.id === chosen,
    );
    if (!chosen || !option) continue;

    // By patch id, because the switch is what holds a choice.
    lora[patch.id] = chosen;

    // And the rest by the *entry's* id, because those numbers belong to the
    // LoRA rather than to the switch it sits behind — each converges somewhere
    // different and their ranges differ. See `RunModes`.
    if (option.strength && typeof applied.strength === "number") {
      strengths[option.id] = applied.strength;
    }
    if (applied.prompt?.tier && option.prompt?.tiers?.some((t) => t.id === applied.prompt?.tier)) {
      tier[option.id] = applied.prompt.tier;
    }
    // The switch, not the filename: that is the half of the record this side
    // can act on — the browser is never given the model files.
    if (option.baseAlternate && applied.base) {
      alternateBase[option.id] = applied.base.alternate;
    }
  }

  return {
    values,
    turbo,
    patches: workflow.patches
      .filter((patch) => job.patches?.includes(patch.id))
      .map((patch) => patch.id),
    lora,
    strengths,
    tier,
    alternateBase,
  };
}
