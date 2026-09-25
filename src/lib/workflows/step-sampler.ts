import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import type { SpliceId } from "./model-chain";
import type { ParamValue } from "./types";
import type { SwappedModel } from "./model-swap";

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
   * The run is refused unless turbo is on, and this is what it is refused with.
   *
   * A property of this form rather than of any control: at this count the
   * sampler is the pack's distilled one, whose whole schedule assumes the LoRA
   * is under it. Without it the run finishes, takes the time, and comes back
   * wrong — which is worse than being refused.
   *
   * It used to hang off the pin that forced four steps whenever Reference to
   * Video was given a reference, and went with it when the weights stopped
   * following the step count. That left the hole it had been covering: every
   * graph here starts its steps slider at four, so every one of them could be
   * run at four with the switch off. Declared here, it covers all of them.
   */
  requiresTurbo?: string;
  /**
   * Loaders this step count also rewrites — a graph whose four-step form loads
   * different weights from its standard one.
   *
   * Remix is the only graph left with any. Its reference is the clip it is
   * rebuilding, which is required, so "with a reference" and "always" are the
   * same statement there and the step count is the only thing that varies —
   * which makes this the honest place for it.
   *
   * Reference to Video used to declare its bf16 pair here too, and that was
   * wrong: its references are optional, so the swap had to follow them rather
   * than the count, and hanging it here forced the count to be pinned. It has
   * moved to `modelSwap`. See model-swap.ts for the whole of that reasoning.
   */
  models?: SwappedModel[];
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
