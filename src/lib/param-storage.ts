"use client";

import { effectiveWorkflow } from "@/lib/workflows/turbo";
import {
  defaultValuesFor,
  type ParamValue,
  type WorkflowSummary,
} from "@/lib/workflows/types";

/**
 * Remembers the settings for each workflow between sessions.
 *
 * Stored per workflow id, so switching between them and coming back keeps both
 * sets — the same reason they are held separately in memory.
 */

const STORAGE_KEY = "sorant-params";
/**
 * Which workflows are in turbo, kept apart from the values rather than as a
 * pseudo-param: it is not something the graph reads, and mixing it in would
 * put a key in the params blob that no param declares.
 */
const MODES_KEY = "sorant-turbo";
/**
 * Whether turbo's low-VRAM path is on. One boolean for the whole app rather
 * than one per workflow, because what it answers is "will this card hold the
 * LoRA the fast way", which is the same answer on every graph.
 */
const LOW_VRAM_KEY = "sorant-low-vram";

export type StoredModes = Record<string, boolean>;

export function readStoredLowVram(): boolean {
  try {
    return localStorage.getItem(LOW_VRAM_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeStoredLowVram(lowVram: boolean): void {
  try {
    localStorage.setItem(LOW_VRAM_KEY, lowVram ? "on" : "off");
  } catch {
    // As below — a storage failure costs the preference, nothing more.
  }
}

export function readStoredModes(): StoredModes {
  try {
    const raw = localStorage.getItem(MODES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredModes;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredModes(modes: StoredModes): void {
  try {
    localStorage.setItem(MODES_KEY, JSON.stringify(modes));
  } catch {
    // As above — a storage failure costs the preference, nothing more.
  }
}

/**
 * The stored mode for each workflow, ignoring anything stored against a
 * workflow that no longer offers turbo.
 */
export function hydrateModes(workflows: WorkflowSummary[]): StoredModes {
  const stored = readStoredModes();
  const modes: StoredModes = {};
  for (const workflow of workflows) {
    if (!workflow.turbo) continue;
    modes[workflow.id] = stored[workflow.id] === true;
  }
  return modes;
}

export type StoredParams = Record<string, Record<string, ParamValue>>;

export function readStoredParams(): StoredParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredParams;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredParams(values: StoredParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Storage full or disabled — settings just will not survive a reload.
  }
}

/**
 * Layers stored values over the workflow's defaults.
 *
 * Reading the stored blob directly would be wrong in both directions: a param
 * added since it was written would come back undefined, and a param since
 * removed would linger. Starting from the defaults and only accepting keys the
 * schema still declares keeps a stale blob from breaking the form.
 *
 * The type check guards the other schema change that matters — a control whose
 * kind changed, where the old value would now be nonsense.
 */
export function mergeWithDefaults(
  workflow: WorkflowSummary,
  stored: Record<string, ParamValue> | undefined,
): Record<string, ParamValue> {
  const values = defaultValuesFor(workflow);
  if (!stored) return values;

  for (const param of workflow.params) {
    const saved = stored[param.id];
    if (saved === undefined) continue;
    if (typeof saved !== typeof param.default) continue;
    values[param.id] = saved;
  }

  return clampValues(workflow, values);
}

/**
 * Pull every number back inside the range its control declares.
 *
 * Ranges are not fixed for the life of a value: turning Turbo on takes the
 * steps slider from 4–60 to 4–8 under a stored 20, and a workflow's own limits
 * can change between releases. An out-of-range value would render as a slider
 * pinned at one end and then be refused by the server on submit, so it is
 * brought in wherever values meet params — on load, and on toggling the mode.
 */
export function clampValues(
  workflow: WorkflowSummary,
  values: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const clamped = { ...values };
  for (const param of workflow.params) {
    if (param.type !== "slider" && param.type !== "number") continue;
    const value = clamped[param.id];
    if (typeof value !== "number") continue;
    clamped[param.id] = Math.min(param.max, Math.max(param.min, value));
  }
  return clamped;
}

/**
 * Every workflow's values, with anything stored layered on top.
 *
 * Takes the modes because a workflow in turbo is a different set of ranges to
 * merge against — see `clampValues`.
 */
export function hydrateAll(
  workflows: WorkflowSummary[],
  modes: StoredModes,
): Record<string, Record<string, ParamValue>> {
  const stored = readStoredParams();
  return Object.fromEntries(
    workflows.map((workflow) => [
      workflow.id,
      mergeWithDefaults(
        effectiveWorkflow(workflow, modes[workflow.id]),
        stored[workflow.id],
      ),
    ]),
  );
}
