import type { ComfyGraph, ComfyNode } from "@/lib/comfy";

/**
 * The stretch of graph between the diffusion model and the sampler, and the
 * nodes this app splices into it.
 *
 * Three switches now put a node there — Turbo's distilled LoRA, the SageAttention
 * patch and Spectrum's forecaster — and none of them is in any stored graph. All
 * work the same way: take the model from whatever currently produces it, and
 * make everything that read that model read this node instead. Keeping the
 * mechanics here rather than once per switch is what makes them composable,
 * because the hard part is not the splice, it is that they stack in a particular
 * order.
 *
 * The consumers are found rather than declared. In every graph here they are
 * BasicScheduler and BasicGuider, but naming them per workflow would be a list
 * to keep in step with five graphs, and the graph already knows: anything
 * linked to the anchor's output is a consumer by definition. Missing one would
 * be the quiet kind of wrong — sigmas scheduled against one model while the
 * guider ran another.
 */

/**
 * The class holding the diffusion model. Every graph here loads one this way;
 * a graph that used a checkpoint loader instead would need adding here, and
 * would fail `pnpm check:workflows` until it was.
 */
export const MODEL_LOADER = "UNETLoader";

/**
 * Node ids for the spliced-in nodes, in the order they stack between the loader
 * and the sampler.
 *
 * The order is the point of this array, and it is the ComfyUI export's:
 * `UNETLoader → MiniMaxH3TurboLoRA → PathchSageAttentionKJ →
 * SpectrumApplyMiniMaxH3 → BasicScheduler`/`BasicGuider`. Turbo's LoRA attaches
 * to the raw diffusion model, the attention patch swaps the kernel on whatever
 * weights are in play by then, and Spectrum wraps whatever model is actually
 * going to be sampled.
 *
 * Getting any of it out of order would fail nothing. It would just sample
 * something subtly other than what the nodes were meant to produce — a LoRA
 * applied to a model Spectrum had already wrapped, or an attention patch that
 * the LoRA's weights then landed behind.
 *
 * Stated once here so every switch inherits it, and so `spliceModel` can find
 * the right anchor whichever order they happen to be applied in.
 *
 * Not numbers, unlike the "105:" ids the subgraph exports carry, and for the
 * same reason those work: ComfyUI's API format keys nodes by string.
 */
export const SPLICE_ORDER = ["turbo", "sage", "spectrum"] as const;

export type SpliceId = (typeof SPLICE_ORDER)[number];

/** True for a link to the given node's first output. */
function isLinkFrom(value: unknown, nodeId: string): boolean {
  return Array.isArray(value) && value[0] === nodeId && value[1] === 0;
}

/** The one diffusion-model loader in the graph, or null if that is not what it has. */
export function modelLoaderIn(graph: ComfyGraph): string | null {
  const loaders = Object.keys(graph).filter(
    (id) => graph[id].class_type === MODEL_LOADER,
  );
  return loaders.length === 1 ? loaders[0] : null;
}

/**
 * What the node being spliced in takes its model from: the latest node already
 * spliced in ahead of it, or the loader when there is none.
 *
 * Computed from SPLICE_ORDER rather than from "whatever was added last", so the
 * chain comes out the same whichever order the switches are applied in.
 */
function anchorFor(graph: ComfyGraph, id: SpliceId): string | null {
  const earlier = SPLICE_ORDER.slice(0, SPLICE_ORDER.indexOf(id));
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    if (graph[earlier[index]]) return earlier[index];
  }
  return modelLoaderIn(graph);
}

export interface Splice {
  /** Which link in the chain this is. Doubles as the node's id in the graph. */
  id: SpliceId;
  /** How the switch is named in an error message. */
  label: string;
  /**
   * The node to splice in, exactly as ComfyUI exports it, minus the model link
   * — that is wired here, because only the graph knows where the model is.
   */
  node: ComfyNode;
  /** The input on that node the model arrives at. */
  modelInput: string;
  /** Written over the node's own inputs, for anything the app drives. */
  inputs?: Record<string, unknown>;
}

/**
 * Put the node in the model's path, in place. Call it on a clone —
 * `applyParams` does.
 *
 * Rewiring happens before the node is added, so its own model input is not
 * caught by its own rewrite.
 */
export function spliceModel(graph: ComfyGraph, splice: Splice): void {
  const { id, label, node, modelInput, inputs } = splice;

  if (graph[id]) {
    throw new Error(`${label} needs node id "${id}", which is taken.`);
  }

  const anchor = anchorFor(graph, id);
  if (!anchor) {
    const loaders = Object.values(graph).filter(
      (candidate) => candidate.class_type === MODEL_LOADER,
    ).length;
    throw new Error(
      `${label} needs exactly one ${MODEL_LOADER} to attach to; this graph has ${loaders}.`,
    );
  }

  let rewired = 0;
  for (const other of Object.values(graph)) {
    for (const [input, value] of Object.entries(other.inputs)) {
      if (!isLinkFrom(value, anchor)) continue;
      other.inputs[input] = [id, 0];
      rewired += 1;
    }
  }
  if (rewired === 0) {
    throw new Error(
      `Nothing reads node ${anchor} (${graph[anchor].class_type}), so there is nothing for ${label} to sit in front of.`,
    );
  }

  graph[id] = {
    ...node,
    inputs: {
      ...node.inputs,
      ...inputs,
      // Last, so the wire always wins over anything named above it.
      [modelInput]: [anchor, 0],
    },
  };
}
