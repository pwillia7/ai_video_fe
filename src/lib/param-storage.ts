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
 * Bumped when a switch's default changes, which is the only way such a change
 * can reach anyone who has already run the app.
 *
 * The maps below are written back in full on every load, not only when
 * something is toggled — so after one visit storage holds an explicit entry for
 * every workflow, and "absent" stops meaning "never chose". A new default would
 * be silently outvoted by a value nobody set. Moving the key retires those
 * entries in one go, at the cost of forgetting deliberate choices once.
 *
 * Only the switches. Params keep their key, because they are what someone
 * actually typed.
 */
const DEFAULTS_VERSION = 2;
/**
 * Which workflows are in each run mode, kept apart from the values rather than
 * as pseudo-params: none of it is something the graph reads, and mixing it in
 * would put keys in the params blob that no param declares.
 *
 * Two keys rather than one blob, because the two are stored differently: turbo
 * is one boolean per workflow, and the patches are a list of the switch ids
 * that were on.
 */
const TURBO_KEY = `sorant-turbo-v${DEFAULTS_VERSION}`;
const PATCHES_KEY = `sorant-patches-v${DEFAULTS_VERSION}`;
/**
 * Which distilled LoRA turbo applies, per workflow — a third key for the same
 * reason there are two above: it is one id per workflow rather than a boolean or
 * a list.
 *
 * Per workflow rather than once for the app, unlike Low VRAM. What it answers is
 * which distillation suits the *model this graph runs*, and the two H3 UNETs
 * here do not have the same answer.
 */
const LORA_KEY = `sorant-loras-v${DEFAULTS_VERSION}`;
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

function read<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // As above — a storage failure costs the preference, nothing more.
  }
}

export const writeStoredTurbo = (modes: StoredModes) => write(TURBO_KEY, modes);

/**
 * The stored turbo setting for each workflow, falling back to what the mode
 * declares and ignoring anything stored against a workflow that no longer
 * offers it.
 */
export function hydrateTurbo(workflows: WorkflowSummary[]): StoredModes {
  const stored = read<boolean>(TURBO_KEY);
  const modes: StoredModes = {};
  for (const workflow of workflows) {
    if (!workflow.turbo) continue;
    modes[workflow.id] =
      typeof stored[workflow.id] === "boolean"
        ? stored[workflow.id]
        : workflow.turbo.defaultOn === true;
  }
  return modes;
}

/** Which single-node switches are on, per workflow. */
export type StoredPatches = Record<string, string[]>;

export const writeStoredPatches = (patches: StoredPatches) =>
  write(PATCHES_KEY, patches);

/**
 * The stored patch settings, falling back to whichever switches declare
 * themselves on, and keeping only ids the workflow still offers.
 *
 * A switch removed from a workflow — or renamed, which is the same thing here —
 * would otherwise linger in storage and be sent on the next run, where the
 * server would refuse the whole submission over a switch the form never showed.
 *
 * A stored empty list is a real answer, not a missing one: it is what having
 * turned every switch off looks like, and it has to survive a reload.
 */
export function hydratePatches(workflows: WorkflowSummary[]): StoredPatches {
  const stored = read<string[]>(PATCHES_KEY);
  const patches: StoredPatches = {};
  for (const workflow of workflows) {
    const saved = stored[workflow.id];
    patches[workflow.id] = workflow.patches
      .filter((patch) =>
        Array.isArray(saved) ? saved.includes(patch.id) : patch.defaultOn,
      )
      .map((patch) => patch.id);
  }
  return patches;
}

/** Which turbo LoRA each workflow uses, by id. */
export type StoredLoras = Record<string, string>;

export const writeStoredLoras = (loras: StoredLoras) => write(LORA_KEY, loras);

/**
 * The stored LoRA choice per workflow, keeping only workflows that still offer
 * a choice and ids they still offer.
 *
 * An id that has since been removed — or renamed, which is the same thing here —
 * would otherwise be sent on the next run and refused by the server over an
 * option the form never showed. The first option stands in, because a workflow
 * declaring the list puts the node's own default first.
 */
export function hydrateLoras(workflows: WorkflowSummary[]): StoredLoras {
  const stored = read<string>(LORA_KEY);
  const loras: StoredLoras = {};
  for (const workflow of workflows) {
    const offered = workflow.turbo?.loras;
    if (!offered?.length) continue;
    const saved = stored[workflow.id];
    loras[workflow.id] = offered.some((lora) => lora.id === saved)
      ? saved
      : offered[0].id;
  }
  return loras;
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
 * Takes the turbo modes because a workflow in turbo is a different set of
 * ranges to merge against — see `clampValues`. The patches are not here because
 * they retune no control; each is a node in the graph and nothing else.
 */
export function hydrateAll(
  workflows: WorkflowSummary[],
  turbo: StoredModes,
): Record<string, Record<string, ParamValue>> {
  const stored = readStoredParams();
  return Object.fromEntries(
    workflows.map((workflow) => [
      workflow.id,
      mergeWithDefaults(
        effectiveWorkflow(workflow, turbo[workflow.id]),
        stored[workflow.id],
      ),
    ]),
  );
}
