import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import { spliceModel, type SpliceId } from "./model-chain";
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
 * The splice itself lives in model-chain.ts, which the patches use too and which
 * owns the order they all stack in.
 */

/** Node id for the spliced-in LoRA. */
const TURBO_NODE_ID: SpliceId = "turbo";

/**
 * A memory-for-time input on the spliced node, offered as a switch of its own.
 *
 * Declared rather than assumed because it is the node pack's option, not
 * something this app implements: all we do is write the flag it exports. What
 * it costs and what it saves are the pack's business, so `help` is where the
 * workflow says what turning it on means.
 */
export interface TurboLowVram {
  /** The boolean input on the spliced node. Must be one the node already has. */
  input: string;
  label: string;
  help: string;
}

/**
 * One LoRA file the switch may apply, where more than one is worth offering.
 *
 * A distillation is made against a particular model, and the two H3 UNETs here
 * do not have the same one: `minimax_h3_turbo_v4` is trained against `fl2va` and
 * merely tolerated on `ref2va`, which has a distillation of its own. Which of
 * them a graph should run is therefore a real question on the two `ref2va`
 * workflows and no question at all on the rest — so this is a list, and a
 * workflow with nothing to choose between declares none.
 *
 * `id` is what travels. The filename stays server-side, like the graph and like
 * `requiresModel`, and the browser gets the id, the label and the help — which
 * is all a dropdown needs, and keeps the names of files on someone's ComfyUI box
 * out of a page served to a browser.
 */
export interface TurboLora {
  /** Stable id. Stored per workflow and sent with the run. */
  id: string;
  label: string;
  /** What this one is distilled for, in a line under the control. */
  help: string;
  /** The value written to the node's file input. Server-side only. */
  file: string;
  /**
   * Filename prefixes of the diffusion models this particular LoRA is for —
   * see `requiresModel` on the spec, which this narrows. A spec-level list has
   * to cover every option at once, so it cannot catch an option offered on a
   * graph it was never distilled against; this can, and `check:workflows` does.
   */
  requiresModel?: string[];
}

/** What the browser is told about one. See `TurboLora`. */
export type ClientTurboLora = Omit<TurboLora, "file" | "requiresModel">;

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
  /**
   * Set when the node has a low-VRAM path worth offering. Absent means the
   * switch is not shown and the node's own default stands.
   */
  lowVram?: TurboLowVram;
  /**
   * The LoRA files this switch may apply, and the input naming them. Absent
   * where there is nothing to choose between: the node's own value stands and
   * no control is shown.
   *
   * The node's stored value has to be one of `options`, which is what keeps the
   * default in the list honest — `check:workflows` fails a spec whose node
   * loads a file the dropdown does not offer, since the form would then open
   * showing a choice nobody made.
   */
  loras?: { input: string; options: TurboLora[] };
  /** Wall-clock estimate with the LoRA applied, if it differs. */
  estimatedSeconds?: number;
  /** Where the switch starts before anyone has touched it. See DEFAULTS_VERSION. */
  defaultOn?: boolean;
  /** One line under the switch. */
  help: string;
}

/**
 * What the browser is allowed to see. `node` and `requiresModel` name local
 * model files, which is the same reason the graph itself is withheld from the
 * summary; both are only read by the server and by `check:workflows`.
 *
 * The low-VRAM switch keeps its wording and loses its `input` for the same
 * reason a param keeps its label and loses its `targets`: which node input a
 * control writes to is the server's business, and the form only needs to know
 * there is a switch and what to call it.
 */
export type ClientTurbo = Omit<
  TurboSpec,
  "node" | "modelInput" | "requiresModel" | "lowVram" | "loras"
> & {
  lowVram?: Omit<TurboLowVram, "input">;
  /** Minus the input it writes and the filenames it names. See ClientTurboLora. */
  loras?: ClientTurboLora[];
};

/** Which LoRA the spliced node loads with nothing chosen — its stored value. */
export function defaultLora(spec: TurboSpec): TurboLora | undefined {
  return spec.loras?.options.find(
    (lora) => lora.file === spec.node.inputs[spec.loras!.input],
  );
}

/**
 * The LoRA this id names, or undefined for an id this spec does not offer.
 *
 * Undefined for a *missing* id too, which is the same answer and wants the same
 * treatment: the caller falls back to the node's own value. What must not happen
 * is an unrecognised id quietly loading the default — see `applyParams`, which
 * refuses it, because the whole point of choosing one is knowing which ran.
 */
export function loraFor(
  spec: TurboSpec,
  id: string | undefined,
): TurboLora | undefined {
  if (id === undefined) return undefined;
  return spec.loras?.options.find((lora) => lora.id === id);
}

/**
 * Splice the LoRA in, in place. Call it on a clone — `applyParams` does.
 *
 * `lowVram` and the choice of LoRA are written onto the spliced node rather than
 * reaching it as params like everything else the user sets, because the node
 * they belong to is not in the stored graph: there is nothing for a target to
 * point at until this function has run, and in standard mode there never is.
 */
export function applyTurbo(
  graph: ComfyGraph,
  spec: TurboSpec,
  { lowVram = false, lora }: { lowVram?: boolean; lora?: TurboLora } = {},
): void {
  if (spec.lowVram && !(spec.lowVram.input in spec.node.inputs)) {
    throw new Error(
      `Turbo offers a low-VRAM switch on "${spec.lowVram.input}", which ` +
        `${spec.node.class_type} does not accept.`,
    );
  }
  if (spec.loras && !(spec.loras.input in spec.node.inputs)) {
    throw new Error(
      `Turbo offers a choice of LoRA on "${spec.loras.input}", which ` +
        `${spec.node.class_type} does not accept.`,
    );
  }

  spliceModel(graph, {
    id: TURBO_NODE_ID,
    label: "Turbo",
    node: spec.node,
    modelInput: spec.modelInput,
    inputs: {
      ...(spec.lowVram ? { [spec.lowVram.input]: lowVram } : {}),
      // Absent leaves the node's own value, which is the default option.
      ...(spec.loras && lora ? { [spec.loras.input]: lora.file } : {}),
    },
  });
}

/**
 * The graph turbo would actually queue. Only used by `check:nodes`, which has
 * to ask ComfyUI about classes and files that no stored graph names — and which
 * asks once per LoRA on offer, since an alternative nobody has downloaded is a
 * dropdown entry that fails a render.
 */
export function turboGraph(
  graph: ComfyGraph,
  spec: TurboSpec,
  lora?: TurboLora,
): ComfyGraph {
  const clone = structuredClone(graph);
  applyTurbo(clone, spec, { lora });
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
