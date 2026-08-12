import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import type { ParamValue, WorkflowSummary } from "./types";

/**
 * Turbo mode: the same graph, sampled with a distilled LoRA.
 *
 * A turbo variant of a MiniMax H3 graph differs from its base by exactly one
 * node. The LoRA loader takes the diffusion model the UNET loader produced, and
 * everything that read the UNET reads the LoRA's output instead. Nothing else
 * moves — not the conditioning, not the frame maths, not the rewrite stage.
 *
 * That is small enough, and mechanical enough, to do here rather than by
 * keeping a second copy of every graph. The graphs stay verbatim from their
 * ComfyUI exports, which is the property that lets them be diffed against a
 * re-export, and the LoRA is spliced into a clone on the way to the queue.
 *
 * The consumers are found rather than declared. In every graph here they are
 * BasicScheduler and BasicGuider, but naming them per workflow would be a list
 * to keep in step with five graphs, and the graph already knows: anything
 * linked to the loader's output is a consumer by definition. Missing one would
 * be the quiet kind of wrong — sigmas scheduled against the distilled model
 * while the guider ran the base one.
 */

/**
 * Node id for the spliced-in LoRA. Not a number, like the "105:" ids the
 * subgraph exports carry, and for the same reason those work: ComfyUI's API
 * format keys nodes by string.
 */
const TURBO_NODE_ID = "turbo";

/**
 * The class holding the diffusion model. Every graph here loads one this way;
 * a graph that used a checkpoint loader instead would need adding here, and
 * would fail `pnpm check:workflows` until it was.
 */
const MODEL_LOADER = "UNETLoader";

/** How the steps control is retuned when the mode is on. */
export interface TurboSteps {
  /** Id of the control to retune — "steps", as `samplingParams` names it. */
  param: string;
  default: number;
  min: number;
  max: number;
  help?: string;
}

export interface TurboSpec {
  /**
   * The node to splice in, exactly as ComfyUI exports it, minus the model link
   * — that is wired here, because only the graph knows where the model is.
   */
  node: ComfyNode;
  /** The input on that node the model arrives at. */
  modelInput: string;
  /**
   * Filename prefixes of the diffusion models this LoRA may be attached to.
   *
   * A LoRA is trained against particular models, and the splice cannot tell: it
   * would attach just as cleanly to a UNET the LoRA knows nothing about, and
   * the run would finish having quietly produced something worse rather than
   * failing. Listing the models it is known to work on lets `check:workflows`
   * catch a graph it does not belong on at the point that graph is written,
   * instead of minutes into a render.
   *
   * A list rather than one name because a distillation can cover more than one
   * checkpoint of the same family — see `h3Turbo`, where it covers both H3
   * UNETs in use here.
   */
  requiresModel?: string[];
  /**
   * A distilled model converges in single digits, so the range moves rather
   * than just the default: the base graph's 60 is not a slower-but-better
   * setting here, it is off the end of what the LoRA was made for.
   */
  steps: TurboSteps;
  /** Wall-clock estimate with the LoRA applied, if it differs. */
  estimatedSeconds?: number;
  /** One line under the switch. */
  help: string;
}

/**
 * What the browser is allowed to see. `node` and `requiresModel` name local
 * model files, which is the same reason the graph itself is withheld from the
 * summary; both are only read by the server and by `check:workflows`.
 */
export type ClientTurbo = Omit<
  TurboSpec,
  "node" | "modelInput" | "requiresModel"
>;

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
 * Splice the LoRA in, in place. Call it on a clone — `applyParams` does.
 *
 * Rewiring happens before the node is added, so the LoRA's own model input is
 * not caught by its own rewrite.
 */
export function applyTurbo(graph: ComfyGraph, spec: TurboSpec): void {
  const loader = modelLoaderIn(graph);
  if (!loader) {
    throw new Error(
      `Turbo needs exactly one ${MODEL_LOADER} to attach to; this graph has ` +
        `${Object.values(graph).filter((n) => n.class_type === MODEL_LOADER).length}.`,
    );
  }
  if (graph[TURBO_NODE_ID]) {
    throw new Error(`Turbo needs node id "${TURBO_NODE_ID}", which is taken.`);
  }

  let rewired = 0;
  for (const node of Object.values(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isLinkFrom(value, loader)) continue;
      node.inputs[input] = [TURBO_NODE_ID, 0];
      rewired += 1;
    }
  }
  if (rewired === 0) {
    throw new Error(
      `Nothing reads ${MODEL_LOADER} (node ${loader}), so there is nothing for turbo to sit in front of.`,
    );
  }

  graph[TURBO_NODE_ID] = {
    ...spec.node,
    inputs: { ...spec.node.inputs, [spec.modelInput]: [loader, 0] },
  };
}

/**
 * The graph turbo would actually queue. Only used by `check:nodes`, which has
 * to ask ComfyUI about classes and files that no stored graph names.
 */
export function turboGraph(graph: ComfyGraph, spec: TurboSpec): ComfyGraph {
  const clone = structuredClone(graph);
  applyTurbo(clone, spec);
  return clone;
}

/**
 * Enough of a param for the steps retune. Written structurally so the same
 * function serves `ParamDef` on the server and `ClientParam` in the browser.
 */
interface Retunable {
  id: string;
  type: string;
  default: ParamValue;
  help?: string;
  min?: number;
  max?: number;
}

/** The workflow's params with the steps control retuned for the LoRA. */
export function turboParams<P extends Retunable>(
  params: P[],
  spec: Pick<TurboSpec, "steps"> | undefined,
): P[] {
  if (!spec) return params;
  const { steps } = spec;
  return params.map((param) =>
    param.id === steps.param
      ? // The spread narrows to P plus the overridden keys, which TypeScript
        // will not accept as P on its own — every key written here is one the
        // constraint above already declares.
        ({
          ...param,
          default: steps.default,
          min: steps.min,
          max: steps.max,
          help: steps.help ?? param.help,
        } as P)
      : param,
  );
}

/** The workflow as it behaves in the given mode. Identity when turbo is off. */
export function effectiveWorkflow(
  workflow: WorkflowSummary,
  turbo: boolean | undefined,
): WorkflowSummary {
  if (!turbo || !workflow.turbo) return workflow;
  return {
    ...workflow,
    params: turboParams(workflow.params, workflow.turbo),
    estimatedSeconds:
      workflow.turbo.estimatedSeconds ?? workflow.estimatedSeconds,
  };
}

/**
 * How a run is named once the mode is part of what it is — in the history, in
 * the notification, and above the tips.
 */
export function workflowLabel(name: string, turbo: boolean | undefined): string {
  return turbo ? `${name} (Turbo)` : name;
}
