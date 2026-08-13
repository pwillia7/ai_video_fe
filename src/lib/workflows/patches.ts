import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import { spliceModel, type SpliceId } from "./model-chain";

/**
 * A patch: one node put in the model's path, and a switch to put it there.
 *
 * The SageAttention patch and the Spectrum forecaster are both exactly this —
 * a node from a ComfyUI export, wired between the model and the sampler, with
 * nothing for the user to set beyond whether it is there at all. Written once
 * as a list rather than twice as named fields because they differ only in which
 * node they carry, and because a third would otherwise mean a third copy of the
 * storage key, the state, the label and the switch.
 *
 * Turbo is deliberately not one of these. It moves the step control's range and
 * carries a switch of its own, which is a different enough shape that folding it
 * in here would cost more than the duplication saves. See turbo.ts.
 *
 * A patch's node settings are whatever its ComfyUI export carries, and are not
 * exposed. They are the node pack's tuning of its own method rather than
 * anything about the shot; if one turns out to be worth setting per run, it
 * becomes a param with a target like anything else.
 *
 * The node is only in the graph when the switch is on, so "off" is its absence
 * rather than the node present and told to do nothing. That is what lets a run
 * with every switch off need none of the packs these nodes come from.
 */
export interface PatchDef {
  /**
   * Which link in the model chain this is. Doubles as the node's id in the
   * graph and as the key the switch is remembered under, so it must stay
   * stable — renaming one silently forgets everyone's setting.
   */
  id: SpliceId;
  /** The switch's name in the sidebar, and in a run's name in the history. */
  label: string;
  /**
   * The node to splice in, exactly as ComfyUI exports it, minus the model link
   * — that is wired by the splice, because only the graph knows where the
   * model is.
   */
  node: ComfyNode;
  /** The input on that node the model arrives at. */
  modelInput: string;
  /**
   * Wall-clock estimate with this patch applied, if it differs. Normally
   * absent: the first finished run in a given combination of switches replaces
   * any static number with this machine's own median, and guessing is worse
   * than not saying.
   */
  estimatedSeconds?: number;
  /** One line under the switch. */
  help: string;
}

/**
 * What the browser is allowed to see. `node` and `modelInput` are withheld for
 * the same reason the graph is: they are server-side wiring the form has no use
 * for.
 */
export type ClientPatch = Omit<PatchDef, "node" | "modelInput">;

export function toClientPatch(patch: PatchDef): ClientPatch {
  const { node: _node, modelInput: _modelInput, ...rest } = patch;
  return rest;
}

/** Splice the patch in, in place. Call it on a clone — `applyParams` does. */
export function applyPatch(graph: ComfyGraph, patch: PatchDef): void {
  spliceModel(graph, {
    id: patch.id,
    label: patch.label,
    node: patch.node,
    modelInput: patch.modelInput,
  });
}

/**
 * The graph this patch would actually queue. Only used by `check:nodes`, which
 * has to ask ComfyUI about classes no stored graph names.
 */
export function patchGraph(graph: ComfyGraph, patch: PatchDef): ComfyGraph {
  const clone = structuredClone(graph);
  applyPatch(clone, patch);
  return clone;
}

/** The patches a workflow offers that a run actually asked for, in chain order. */
export function enabledPatches(
  offered: PatchDef[] | undefined,
  wanted: string[] | undefined,
): PatchDef[] {
  if (!offered?.length || !wanted?.length) return [];
  return offered.filter((patch) => wanted.includes(patch.id));
}
