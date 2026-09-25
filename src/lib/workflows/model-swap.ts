import type { ComfyGraph } from "@/lib/comfy";
import { isSet, type ParamValue } from "./types";

/** One loader input, and the file it names when the swap is in effect. */
export interface SwappedModel {
  /** Id of the loader in the stored graph. */
  node: string;
  /** The input naming the file — `unet_name`, `clip_name`, `vae_name`. */
  input: string;
  /** What it loads instead. */
  value: string;
}

/**
 * The weights a graph loads when the run is carrying something the stored
 * graph's weights cannot take.
 *
 * Reference to Video is the only graph with one, and the history is worth
 * keeping because it explains the shape. The quantised pair this graph stores —
 * `minimax_h3_ref2va_pruned_int8_convrot` with `qwen3vl_32b_minimax_h3_nvfp4_awq`
 * — comes back from ComfyUI as `RuntimeError: The size of tensor a (3) must
 * match the size of tensor b (2) at non-singleton dimension 0` on a run
 * carrying more than one kind of reference block. The bf16 pair takes the same
 * references and does not fail.
 *
 * That was first declared as part of what the graph *is at four steps*, hung
 * off `stepSampler`, because four steps is where the working ComfyUI export
 * happened to have been made. It meant the step count had to be pinned to four
 * whenever a reference was attached, which in turn forced the distilled LoRA on
 * — so attaching a voice reference silently bought the lowest step count in the
 * range and a LoRA distilled against a different backbone, with no way to run
 * the comparison that would show it.
 *
 * The failure was never about the step count. It is a batch-dimension mismatch
 * in the reference path, and it is there at twenty steps as much as at four. So
 * the rule belongs to the reference: whenever the run carries one of these, the
 * graph loads the pair that takes it, at whatever step count the user chose.
 *
 * Declared rather than written into the params so a stale one fails a check
 * instead of a render — see `modelSwapProblems`, and `modelSwapBaseProblems`
 * for the LoRA bases it must not silently override.
 */
export interface ModelSwap {
  /**
   * Params whose being set puts the graph in this form. Any one of them is
   * enough.
   *
   * Several because the rule is about what the *run* carries rather than what
   * one control implies: a reference track, a voice and a reference clip are
   * all "something other than a still", and one declaration naming all three
   * keeps them from drifting apart.
   */
  whenSet: string[];
  /** The loaders this rewrites, and what each loads instead. */
  models: SwappedModel[];
  /**
   * The line the form shows on each control in `whenSet` while it is set.
   *
   * On the controls that cause it rather than on the sampler, because that is
   * where the consequence is chosen. Attaching a voice is what moves the graph
   * onto these weights; the steps slider no longer has anything to do with it.
   */
  note: string;
}

/** True when the submitted values put the graph in the swapped form. */
export function modelSwapApplies(
  spec: ModelSwap,
  values: Record<string, ParamValue>,
): boolean {
  return spec.whenSet.some((id) => isSet(values[id]));
}

/**
 * Point the loaders at the other weights if the values call for it, in place.
 * Call it on a clone — `applyParams` does.
 *
 * Returns whether it did anything. The loaders keep their nodes and change one
 * input each, so everything wired to them is wired to the same node whichever
 * weights it loads and there is nothing to rewire. Anything missing is a
 * mistake in the declaration rather than a graph that declined the swap, which
 * is why it throws — `modelSwapProblems` catches it before a run does.
 */
export function applyModelSwap(
  graph: ComfyGraph,
  spec: ModelSwap,
  values: Record<string, ParamValue>,
): boolean {
  if (!modelSwapApplies(spec, values)) return false;

  for (const model of spec.models) {
    const loader = graph[model.node];
    if (!loader || !(model.input in loader.inputs)) {
      throw new Error(
        `This graph loads ${model.value} into node ${model.node}.${model.input} when a reference needs it, ` +
          `which ${loader ? `${loader.class_type} does not accept` : "this graph does not have"}.`,
      );
    }
    loader.inputs[model.input] = model.value;
  }

  return true;
}

/** What is wrong with the declaration, if anything. Read by `check:workflows`. */
export function modelSwapProblems(
  spec: ModelSwap,
  graph: ComfyGraph,
): string[] {
  const problems: string[] = [];

  if (!spec.whenSet.length) {
    problems.push("The model swap names no control that triggers it.");
  }
  if (!spec.models.length) {
    problems.push("The model swap names no weights to load.");
  }

  for (const model of spec.models) {
    const loader = graph[model.node];
    if (!loader) {
      problems.push(
        `The swapped form loads ${model.value} into node ${model.node}, which is not in the graph.`,
      );
      continue;
    }
    if (!(model.input in loader.inputs)) {
      problems.push(
        `The swapped form loads ${model.value} into "${model.input}", which ${loader.class_type} (node ${model.node}) does not accept.`,
      );
    }
  }
  return problems;
}

/**
 * The graph this would actually queue. Used by `check:nodes`, which has to ask
 * ComfyUI about model files no stored graph names.
 */
export function modelSwapGraph(
  graph: ComfyGraph,
  spec: ModelSwap,
): ComfyGraph {
  const clone = structuredClone(graph);
  applyModelSwap(clone, spec, Object.fromEntries(
    spec.whenSet.map((id) => [id, "set"]),
  ));
  return clone;
}
