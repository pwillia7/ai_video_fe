import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import type { ParamValue } from "./types";

/**
 * The sampler a graph uses at one particular step count.
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
  return true;
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
