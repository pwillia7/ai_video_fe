"use client";

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

  return values;
}

/** Every workflow's values, with anything stored layered on top. */
export function hydrateAll(
  workflows: WorkflowSummary[],
): Record<string, Record<string, ParamValue>> {
  const stored = readStoredParams();
  return Object.fromEntries(
    workflows.map((workflow) => [
      workflow.id,
      mergeWithDefaults(workflow, stored[workflow.id]),
    ]),
  );
}
