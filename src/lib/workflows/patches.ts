import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import {
  MODEL_LOADER,
  modelLoaderIn,
  spliceModel,
  type SpliceId,
} from "./model-chain";
import type { ParamValue } from "./types";

/**
 * What the one diffusion-model loader loads while a patch is applied.
 *
 * For a LoRA whose stored graph is on weights it was not made for. MiniMax-H3
 * LoRAs are built against fp16/fp8 bases, and the rotated and quantised
 * checkpoints — `*_int8_convrot`, `*_nvfp4`, `*_w4a8` — store their weights in a
 * different basis: the LoRA loads into one without any error at all and then
 * produces warped faces and melting limbs. So the swap is not a tuning choice,
 * it is the difference between the switch working and the switch quietly ruining
 * every take made with it on.
 *
 * The loader is found rather than named, unlike `StepModel`'s node id. There is
 * exactly one `UNETLoader` in these graphs — `spliceModel` depends on that
 * already, and refuses the patch outright if it is not true — so an id here
 * would be one more thing to keep in step with a re-export, for no gain.
 *
 * Only the diffusion model. The text encoder is not where a model-only LoRA
 * applies, so the graph's `CLIPLoader` is left alone whatever it is quantised to.
 */
export interface PatchBase {
  /** The file the loader names while the switch is on. */
  value: string;
  /** Set where a second supported base is worth offering. */
  alternate?: PatchBaseAlternate;
  /**
   * Filename prefixes this patch is known to work on. `value` — and
   * `alternate.value` — have to start with one of them, which is what turns
   * "someone pointed this at a rotated checkpoint" into a failed
   * `check:workflows` rather than a render that finishes looking subtly wrong.
   */
  allowed: string[];
}

/**
 * A second base the patch also runs on, offered as a switch under it.
 *
 * Not a quality setting so much as a question about the machine and what is on
 * its disk: the full-precision checkpoint is the better one and the lighter one
 * is what you reach for when it will not fit or is not downloaded. That is the
 * same kind of question Low VRAM answers, which is why the switch is remembered
 * once for the whole app rather than per workflow.
 *
 * A boolean rather than a list of files, because there are two and the app
 * should not be handing the browser a menu of the model files on someone's
 * disk — `base` is withheld from `ClientPatch` for exactly that reason. Which
 * file each side of the switch means is resolved on the server. A third base
 * would want a different shape, and would be the point to reconsider this.
 */
export interface PatchBaseAlternate {
  /** The file the loader names instead, while this switch is on. */
  value: string;
  label: string;
  help: string;
}

/**
 * A numeric input on the spliced node, offered as a control of its own.
 *
 * Written onto the node at splice time rather than reaching it as a param,
 * because the node is not in the stored graph — the same reason turbo's
 * `lowVram` works this way. See `PatchDef`.
 */
export interface PatchStrength {
  /** The input on the spliced node. Must be one the node already has. */
  input: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  help: string;
}

/**
 * A patch: one node put in the model's path, and a switch to put it there.
 *
 * The SageAttention patch, the Spectrum forecaster and the VHS style LoRA are
 * all exactly this — a node from a ComfyUI export, wired between the model and
 * the sampler, on a switch. Written once as a list rather than three times as
 * named fields because they differ only in which node they carry, and because a
 * fourth would otherwise mean a fourth copy of the storage key, the state, the
 * label and the switch.
 *
 * Turbo is deliberately not one of these. It moves the step control's range and
 * carries a switch of its own, which is a different enough shape that folding it
 * in here would cost more than the duplication saves. See turbo.ts.
 *
 * A patch's node settings are whatever its ComfyUI export carries, and are not
 * exposed. They are the node pack's tuning of its own method rather than
 * anything about the shot.
 *
 * `strength` is the exception, and it is declared rather than reached by a param
 * `target` for the same reason turbo's low-VRAM switch is: the node it belongs
 * to is not in the stored graph, so there is nothing for a target to point at
 * until the splice has run, and while the switch is off there never is. A style
 * LoRA needs one — how much of a look to apply is the shot's question, not the
 * node pack's — so it travels with the run's modes rather than with the
 * workflow's params.
 *
 * `base` is the other addition, and it exists because a LoRA is trained against
 * particular weights. A patch that says nothing about the base leaves the graph
 * loading whatever it always did; one that names a base swaps the loader for as
 * long as the switch is on.
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
  /** Where the switch starts before anyone has touched it. See DEFAULTS_VERSION. */
  defaultOn?: boolean;
  /** Set when this patch's node needs weights the stored graph does not load. */
  base?: PatchBase;
  /** Set when one of the node's inputs is the user's to set. */
  strength?: PatchStrength;
  /** One line under the switch. */
  help: string;
}

/**
 * What the browser is allowed to see. `node`, `modelInput` and `base` are
 * withheld for the same reason the graph is: they name local model files and
 * server-side wiring the form has no use for. `strength` keeps its wording and
 * loses its `input`, exactly as a param keeps its label and loses its `targets`.
 */
export type ClientPatch = Omit<
  PatchDef,
  "node" | "modelInput" | "base" | "strength"
> & {
  strength?: Omit<PatchStrength, "input">;
  /**
   * The base switch's wording, minus the filename it selects — the same trade
   * `strength` makes, and for the same reason: the form needs to know there is
   * a switch and what to call it, not which file sits behind either side.
   */
  baseAlternate?: Omit<PatchBaseAlternate, "value">;
  /**
   * The value of another control at which this switch is refused, and the line
   * that says so — see `suppresses` on StepSampler, which is where the rule
   * actually lives.
   *
   * Not written by hand on a patch, exactly like a param's `noteAt`:
   * `toSummary` fills it in from whatever declares the rule, so the switch
   * cannot claim something the queued graph does not do.
   */
  suppressedAt?: { param: string; value: ParamValue; note: string };
};

export function toClientPatch(patch: PatchDef): ClientPatch {
  const { node: _node, modelInput: _modelInput, base, strength, ...rest } = patch;
  const client: ClientPatch = rest;
  if (strength) {
    const { input: _input, ...clientStrength } = strength;
    client.strength = clientStrength;
  }
  if (base?.alternate) {
    const { value: _value, ...clientAlternate } = base.alternate;
    client.baseAlternate = clientAlternate;
  }
  return client;
}

/**
 * Whether this switch is refused at these values — asked by the form, so the
 * row can show as off rather than lying about a node the run will not have.
 *
 * The values passed have to be the ones that will actually run: a pinned
 * control submits its pinned value and not what is stored under it. See
 * `pinnedValues`.
 */
export function patchSuppressed(
  patch: ClientPatch,
  values: Record<string, ParamValue>,
): boolean {
  const rule = patch.suppressedAt;
  return rule !== undefined && values[rule.param] === rule.value;
}

/** What the run carries for one patch, for the patches that take anything. */
export interface PatchOptions {
  /**
   * The strength this run set, ignored by a patch that declares none.
   * Out-of-range numbers are clamped rather than refused: the control cannot
   * produce one, so anything outside the range came from a hand-written request
   * or a stored value from an older range, and neither is worth failing a
   * render over.
   */
  strength?: number;
  /** Load the patch's alternate base. Ignored where it offers none. */
  alternateBase?: boolean;
}

/**
 * Splice the patch in, in place, and swap the base it needs. Call it on a clone
 * — `applyParams` does.
 */
export function applyPatch(
  graph: ComfyGraph,
  patch: PatchDef,
  options: PatchOptions = {},
): void {
  const { strength, alternateBase } = options;
  if (patch.strength && !(patch.strength.input in patch.node.inputs)) {
    throw new Error(
      `${patch.label} offers a strength on "${patch.strength.input}", which ` +
        `${patch.node.class_type} does not accept.`,
    );
  }

  spliceModel(graph, {
    id: patch.id,
    label: patch.label,
    node: patch.node,
    modelInput: patch.modelInput,
    inputs: patch.strength
      ? { [patch.strength.input]: resolveStrength(patch.strength, strength) }
      : undefined,
  });

  applyPatchBase(graph, patch, alternateBase);
}

/**
 * The file this patch's base resolves to. The alternate only when the patch
 * actually offers one, so a stale `true` in a stored run cannot name a file
 * that no longer exists.
 */
export function patchBaseFile(
  base: PatchBase,
  alternateBase: boolean | undefined,
): string {
  return alternateBase && base.alternate ? base.alternate.value : base.value;
}

/** The strength this run uses: the submitted one clamped, or the default. */
export function resolveStrength(
  spec: PatchStrength,
  submitted: number | undefined,
): number {
  if (submitted === undefined || !Number.isFinite(submitted)) {
    return spec.default;
  }
  return Math.min(spec.max, Math.max(spec.min, submitted));
}

/**
 * Point the loader at the weights this patch needs, in place.
 *
 * Throws rather than carrying on, for the same reason the step sampler's model
 * swap does: a graph that quietly declined would load the base the LoRA was not
 * made for and finish, which is the failure this whole declaration exists to
 * prevent.
 */
function applyPatchBase(
  graph: ComfyGraph,
  patch: PatchDef,
  alternateBase: boolean | undefined,
): void {
  if (!patch.base) return;
  const file = patchBaseFile(patch.base, alternateBase);
  const loader = modelLoaderIn(graph);
  if (!loader) {
    throw new Error(
      `${patch.label} loads ${file}, but this graph has no single diffusion-model loader to put it in.`,
    );
  }
  graph[loader].inputs.unet_name = file;
}

/**
 * What is wrong with a patch's base, if anything. Read by `check:workflows`.
 *
 * The splice check proves the node can be wired in. This asks the separate
 * question of whether the weights underneath it are ones the LoRA belongs on —
 * the same distinction `turboProblems` draws with `requiresModel`, and for the
 * same reason: attaching to the wrong base fails nothing at all.
 */
export function patchBaseProblems(
  patch: PatchDef,
  graph: ComfyGraph,
): string[] {
  const base = patch.base;
  if (!base) return [];

  const problems: string[] = [];
  const loader = modelLoaderIn(graph);
  if (!loader) {
    problems.push(
      `${patch.label} loads ${base.value}, but this graph has no single ${MODEL_LOADER} to load it into.`,
    );
    return problems;
  }
  if (!("unet_name" in graph[loader].inputs)) {
    problems.push(
      `${patch.label} loads ${base.value} into node ${loader}, which does not accept "unet_name".`,
    );
  }
  // Both sides of the switch, not only the default. An alternate outside the
  // list is the same mistake as a default outside it, and is the easier one to
  // make: it is the option someone reaches for when the recommended base will
  // not fit, which is exactly when a quantised one looks tempting.
  const named = base.alternate ? [base.value, base.alternate.value] : [base.value];
  for (const file of named) {
    if (!base.allowed.some((prefix) => file.startsWith(prefix))) {
      problems.push(
        `${patch.label} goes on ${base.allowed.map((prefix) => `${prefix}*`).join(" or ")}, but it loads ${file}.`,
      );
    }
  }
  if (base.alternate && base.alternate.value === base.value) {
    problems.push(
      `${patch.label}'s base switch offers ${base.value} on both sides, so it does nothing.`,
    );
  }
  return problems;
}

/**
 * The graph this patch would queue on its alternate base. Only used by
 * `check:nodes`, which has to ask about a file the ordinary patched graph does
 * not name either.
 */
export function patchAlternateGraph(
  graph: ComfyGraph,
  patch: PatchDef,
): ComfyGraph | null {
  if (!patch.base?.alternate) return null;
  const clone = structuredClone(graph);
  applyPatch(clone, patch, { alternateBase: true });
  return clone;
}

/**
 * The graph this patch would actually queue. Only used by `check:nodes`, which
 * has to ask ComfyUI about classes no stored graph names — and, for a patch
 * with a `base`, about a model file no stored graph names either.
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
