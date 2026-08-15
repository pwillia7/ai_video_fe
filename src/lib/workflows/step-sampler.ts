import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import type { SpliceId } from "./model-chain";
import type { ParamValue } from "./types";

/**
 * The form a graph takes at one particular step count: which sampler it uses,
 * and — where they differ — which weights it loads.
 *
 * The turbo pack ships a sampler built for exactly four steps — it carries the
 * schedule internally, which is why its node takes no inputs at all — and at
 * that step count it is the right one to use in place of the graph's ordinary
 * `KSamplerSelect`. So this is not a switch: it follows from the steps control
 * rather than from a choice of its own, and the only thing to tell the user is
 * that it happened.
 *
 * That makes it a different shape from turbo and the patches, which is why it
 * lives here rather than in patches.ts. Those splice a node into the model's
 * path on the strength of a switch; this replaces a node in the sampler's path
 * on the strength of a value.
 *
 * **It replaces the node in place, keeping its id.** The ComfyUI export does it
 * the other way round — a new node at a new id, with `SamplerCustomAdvanced`
 * rewired to it and the old `KSamplerSelect` deleted — but the two graphs are
 * the same graph. Reusing the id means every link that pointed at the sampler
 * still does, so there is no rewiring to get wrong and nothing to leave behind.
 */
export interface StepSampler {
  /** Id of the numeric param that decides this. */
  param: string;
  /** The value of that param at which the swap happens. */
  atValue: number;
  /** The class in the stored graph this stands in for. Must appear exactly once. */
  replaces: string;
  /** The node that takes its place, as ComfyUI exports it. */
  node: ComfyNode;
  /**
   * Loader inputs this step count also rewrites — a graph whose four-step form
   * loads different weights from its standard one.
   *
   * Reference to Video is why. The ComfyUI export that finally produced a
   * working four-step take with a reference track loads
   * `minimax_h3_ref2va_bf16` and `qwen3vl_32b_minimax_h3_bf16` where the
   * standard graph loads the quantised pair, and that is not a second workflow
   * any more than the sampler swap is: same graph, same controls, same
   * everything a user types.
   *
   * Hung off this spec rather than declared separately because it is the same
   * fact — what this graph *is* at that step count — and keeping it here means
   * one trigger, one note, and one form of the graph for `check:nodes` to ask
   * ComfyUI about. A second, independently-triggered declaration could drift
   * out of step with this one and load the quantised model under the distilled
   * sampler.
   *
   * Node ids rather than classes, because a graph can have two loaders of the
   * same class — this one has two `VAELoader`s — and the point is to name one.
   */
  models?: StepModel[];
  /**
   * Switches this step count refuses, by patch id.
   *
   * Same principle as the sampler and the weights: at this count the graph is
   * the node pack's own four-step form, and that form does not include them. A
   * switch left on here would be a node spliced into a chain it was never part
   * of, on a run the user cannot tell apart from one that was.
   *
   * Refused rather than turned off — the switch keeps whatever it was set to,
   * and comes back the moment the step count moves. The form says so on the
   * switch itself, from `suppressedAt` on the client patch, so nothing is
   * dropped quietly.
   */
  suppresses?: SpliceId[];
  /**
   * The line the form shows under that control while the swap is in effect.
   *
   * Here rather than on the param so it cannot drift from the rule that
   * produces it — `toSummary` copies it onto the control on the way out. A
   * consequence the user should know about, but noise at every other value,
   * which is why it appears and disappears with the number.
   */
  note: string;
}

/** One loader input, and the file it names at the swapping step count. */
export interface StepModel {
  /** Id of the loader in the stored graph. */
  node: string;
  /** The input naming the file — `unet_name`, `clip_name`, `vae_name`. */
  input: string;
  /** What it loads instead. */
  value: string;
}

/** The one node this would replace, or null if that is not what the graph has. */
export function samplerNodeIn(
  graph: ComfyGraph,
  spec: StepSampler,
): string | null {
  const found = Object.keys(graph).filter(
    (id) => graph[id].class_type === spec.replaces,
  );
  return found.length === 1 ? found[0] : null;
}

/** True when the submitted values put the graph at the swapping value. */
export function stepSamplerApplies(
  spec: StepSampler,
  values: Record<string, ParamValue>,
): boolean {
  return Number(values[spec.param]) === spec.atValue;
}

/**
 * The switches this step count will not take, at these values. Empty at every
 * other count, and empty for a graph that refuses none.
 */
export function suppressedPatches(
  spec: StepSampler | undefined,
  values: Record<string, ParamValue>,
): SpliceId[] {
  if (!spec || !stepSamplerApplies(spec, values)) return [];
  return spec.suppresses ?? [];
}

/**
 * Swap the sampler if the values call for it, in place. Call it on a clone —
 * `applyParams` does.
 *
 * Returns whether it did anything, which is what `check:workflows` asserts on:
 * a graph that quietly declined to swap would sample at four steps with the
 * wrong sampler and produce a worse video, not an error.
 */
export function applyStepSampler(
  graph: ComfyGraph,
  spec: StepSampler,
  values: Record<string, ParamValue>,
): boolean {
  if (!stepSamplerApplies(spec, values)) return false;

  const target = samplerNodeIn(graph, spec);
  if (!target) {
    throw new Error(
      `The ${spec.atValue}-step sampler stands in for exactly one ${spec.replaces}; ` +
        `this graph has ${
          Object.values(graph).filter(
            (node) => node.class_type === spec.replaces,
          ).length
        }.`,
    );
  }

  graph[target] = { ...spec.node };

  // The loaders keep their nodes and change one input each: everything wired to
  // them is wired to the same node whichever weights it loads, so there is
  // nothing here to rewire. Anything missing is a mistake in the spec rather
  // than a graph that declined the swap, and `modelProblems` catches it before
  // a run does — this throws for the same reason the sampler above does.
  for (const model of spec.models ?? []) {
    const loader = graph[model.node];
    if (!loader || !(model.input in loader.inputs)) {
      throw new Error(
        `The ${spec.atValue}-step form loads ${model.value} into node ${model.node}.${model.input}, ` +
          `which ${loader ? `${loader.class_type} does not accept` : "this graph does not have"}.`,
      );
    }
    loader.inputs[model.input] = model.value;
  }

  return true;
}

/** What is wrong with the model swaps, if anything. Read by `check:workflows`. */
export function modelProblems(spec: StepSampler, graph: ComfyGraph): string[] {
  const problems: string[] = [];
  for (const model of spec.models ?? []) {
    const loader = graph[model.node];
    if (!loader) {
      problems.push(
        `The ${spec.atValue}-step form loads ${model.value} into node ${model.node}, which is not in the graph.`,
      );
      continue;
    }
    if (!(model.input in loader.inputs)) {
      problems.push(
        `The ${spec.atValue}-step form loads ${model.value} into "${model.input}", which ${loader.class_type} (node ${model.node}) does not accept.`,
      );
    }
  }
  return problems;
}

/**
 * The graph this would actually queue. Only used by `check:nodes`, which has to
 * ask ComfyUI about a class no stored graph names.
 */
export function stepSamplerGraph(
  graph: ComfyGraph,
  spec: StepSampler,
): ComfyGraph {
  const clone = structuredClone(graph);
  applyStepSampler(clone, spec, { [spec.param]: spec.atValue });
  return clone;
}
