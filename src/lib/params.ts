import type { ComfyGraph } from "@/lib/comfy";
import {
  applyBypass,
  bypassApplies,
  bypassProblems,
} from "@/lib/workflows/director";
import { modelLoaderIn } from "@/lib/workflows/model-chain";
import type { RunModes } from "@/lib/workflows/modes";
import { applyPatch, enabledPatches } from "@/lib/workflows/patches";
import type { SpliceId } from "@/lib/workflows/model-chain";
import {
  applyStepSampler,
  modelProblems,
  samplerNodeIn,
  suppressedPatches,
} from "@/lib/workflows/step-sampler";
import {
  applyTurbo,
  defaultLora,
  loraFor,
  turboParams,
} from "@/lib/workflows/turbo";
import {
  pinnedValue,
  type ParamDef,
  type ParamValue,
  type WorkflowDef,
} from "@/lib/workflows/types";

export class ParamError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ParamError";
  }
}

const MAX_SEED = 0xffffffffffff; // ComfyUI's usual upper bound for seed inputs.

/** What a required file control is missing, for the error it throws. */
const MISSING_NOUN = {
  image: "an image",
  video: "a video",
  audio: "a track",
} as const;

/**
 * True when a filename or subfolder could climb out of the directory it is
 * meant to name. ComfyUI does its own checking, but our route handlers are the
 * internet-facing edge of it, and a param value is user input like any other.
 */
export function isUnsafePath(value: string): boolean {
  return value.includes("..") || value.startsWith("/") || value.includes("\\");
}

function randomSeed(): number {
  return Math.floor(Math.random() * MAX_SEED);
}

/**
 * Coerce one submitted value into what the node input expects, rejecting
 * anything outside the declared range rather than silently clamping — a
 * surprising resolution is worse than a clear error on a multi-minute job.
 */
function coerce(
  param: ParamDef,
  raw: unknown,
  allowedValues?: string[] | null,
): ParamValue {
  switch (param.type) {
    case "text":
    case "textarea": {
      if (raw == null) return param.default;
      if (typeof raw !== "string") {
        throw new ParamError(`${param.label} must be text.`, param.id);
      }
      if (param.maxLength && raw.length > param.maxLength) {
        throw new ParamError(
          `${param.label} is limited to ${param.maxLength} characters.`,
          param.id,
        );
      }
      return raw;
    }

    case "number":
    case "slider": {
      if (raw == null) return param.default;
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ParamError(`${param.label} must be a number.`, param.id);
      }
      if (value < param.min || value > param.max) {
        throw new ParamError(
          `${param.label} must be between ${param.min} and ${param.max}.`,
          param.id,
        );
      }
      return value;
    }

    case "select": {
      const value = String(raw ?? param.default);
      // `allowedValues` is the live list from ComfyUI when available. A null
      // means the lookup failed, in which case we let ComfyUI reject it rather
      // than blocking a choice that may well be valid.
      const allowed =
        allowedValues === undefined
          ? param.options.map((option) => option.value)
          : allowedValues;

      if (allowed !== null && !allowed.includes(value)) {
        throw new ParamError(`${value} is not a valid ${param.label}.`, param.id);
      }
      return value;
    }

    case "toggle": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      if (raw == null) return param.default;
      throw new ParamError(`${param.label} must be true or false.`, param.id);
    }

    // LoadImage, LoadVideo and LoadAudio all take a filename in ComfyUI's input
    // directory rather than the file itself, so the three carry the same shape
    // of value and the same escape risk.
    case "image":
    case "video":
    case "audio": {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        if (param.required) {
          throw new ParamError(
            `${param.label} is required — add ${MISSING_NOUN[param.type]} first.`,
            param.id,
          );
        }
        return "";
      }
      if (isUnsafePath(value)) {
        throw new ParamError(`Invalid ${param.type} reference.`, param.id);
      }
      return value;
    }

    // Not user input in the usual sense — the form measures it off a loaded
    // clip — but it arrives over the same wire as everything else, so it is
    // checked the same way. Anything unusable falls back to the default, which
    // every target has to read as "not known".
    case "measured": {
      if (raw == null) return param.default;
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return param.default;
      }
      return value;
    }

    case "seed": {
      const value =
        raw == null
          ? param.default
          : typeof raw === "string"
            ? Number(raw)
            : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ParamError(`${param.label} must be a number.`, param.id);
      }
      // -1 is the conventional "randomise for me" sentinel.
      if (value < 0) return randomSeed();
      return Math.floor(value) % MAX_SEED;
    }
  }
}

export interface AppliedParams {
  /** A copy of the workflow graph with user values written in. */
  graph: ComfyGraph;
  /** The values actually used, including any seed we generated. */
  resolved: Record<string, ParamValue>;
  /**
   * The switches this run actually got, which is what was asked for minus
   * whatever the step count refuses. Reported rather than assumed so the run is
   * recorded as what it was: the history names the modes a generation used, and
   * the estimate is learned per combination of them.
   */
  patches: string[];
}

/**
 * How the run is being made, as against what it is of. None of these is a
 * param: they change which graph gets queued rather than a value inside one,
 * and the nodes they speak for are not in the stored graph at all. See
 * modes.ts, and turbo.ts and patches.ts for the splices.
 *
 * An object rather than more positional arguments because two of the three are
 * booleans and would otherwise be tellable apart only by counting commas.
 */
export interface RunMode extends RunModes {
  /** Apply the turbo LoRA the memory-sparing way. Only means anything with turbo. */
  lowVram?: boolean;
  /**
   * Which of the offered LoRAs to apply, by id. Only means anything with turbo,
   * and only on a workflow that offers a choice — see `TurboLora`.
   *
   * Here rather than in `RunModes` for the same reason `lowVram` is: it is a
   * detail of how the one node is spliced rather than a mode a finished run is
   * named after. Unset takes the node's own file, which is the default option.
   */
  lora?: string;
}

/**
 * Write submitted values into a fresh copy of the graph. Throws if a param
 * target does not exist, which catches a stale mapping immediately rather
 * than sending a subtly wrong job to the GPU.
 */
export function applyParams(
  workflow: WorkflowDef,
  submitted: Record<string, unknown>,
  /** Live enum values per param id, from resolveDynamicOptions. */
  allowedValues?: Record<string, string[] | null>,
  mode: RunMode = {},
): AppliedParams {
  const turbo = mode.turbo === true;
  // structuredClone would choke on the transform functions, but those live on
  // the param definitions rather than the graph, so the graph clones cleanly.
  const graph = structuredClone(workflow.graph);
  const resolved: Record<string, ParamValue> = {};

  // The steps control has a different range in turbo, so the range a value is
  // checked against has to be the one the form was showing.
  const params = turbo
    ? turboParams(workflow.params, workflow.turbo)
    : workflow.params;

  // Coercion first, before anything touches the graph. Nothing here reads it,
  // and one thing below needs the answers: which switches the run may have
  // depends on the step count, which is a submitted value like any other.
  //
  // Then everything is coerced before anything is *written*, so a transform can
  // read the whole submission and not merely its own value. The director's
  // `system_prompt` is why: several controls contribute to it — the duration,
  // and on the reference graph the per-reference facet selects — and each of
  // them rebuilds the entire instruction from the same inputs. That is only
  // safe if they all see the same complete values, which in a single pass they
  // would not: what each could read would depend on where it sat in the params
  // array, and the last one to run would win with a partial view.
  for (const param of params) {
    resolved[param.id] = coerce(
      param,
      submitted[param.id],
      allowedValues ? allowedValues[param.id] : undefined,
    );
  }

  // Before anything reads a value, because a pin is decided by another
  // control's coerced value and every later reader — the splices below, the
  // targets, the step sampler, `finalize`, and the record of the run that is
  // stored afterwards — has to see the pinned number rather than the submitted
  // one. See `pinnedBy`.
  for (const param of params) {
    const pinned = pinnedValue(param, resolved);
    if (pinned !== undefined) resolved[param.id] = pinned;
  }

  // Every splice runs before the values are written, so `finalize` sees the
  // graph that will actually be queued. Nothing targets the loader or any
  // spliced node in any case.
  //
  // Turbo first and the patches after, so each ends up wrapping the model the
  // one before it produced — though that ordering is enforced by SPLICE_ORDER
  // rather than by the order of these lines, so rearranging them would be
  // untidy rather than wrong.
  if (turbo) {
    if (!workflow.turbo) {
      throw new ParamError(`Workflow "${workflow.id}" has no turbo mode.`);
    }
    // Refused rather than fallen back on. An id this workflow does not offer
    // means the two ends disagree about what is installed or what is on offer,
    // and quietly applying the default would answer "which LoRA made this take"
    // with the wrong file — which is the one question the control exists to let
    // someone ask.
    const lora = loraFor(workflow.turbo, mode.lora);
    if (mode.lora !== undefined && !lora) {
      throw new ParamError(
        `Workflow "${workflow.id}" has no "${mode.lora}" turbo LoRA.`,
      );
    }
    applyTurbo(graph, workflow.turbo, {
      lowVram: mode.lowVram === true,
      lora,
    });
  }

  for (const id of mode.patches ?? []) {
    if (!workflow.patches?.some((patch) => patch.id === id)) {
      throw new ParamError(`Workflow "${workflow.id}" has no "${id}" switch.`);
    }
  }
  // An unknown id is still an error above; a refused one is not. The step count
  // decides which nodes this graph is run with, and a switch it does not take
  // is left set and left out — see `suppresses`, and `patches` in the result,
  // which is what the run is recorded as having used.
  const refused = suppressedPatches(workflow.stepSampler, resolved);
  const patches = enabledPatches(
    workflow.patches,
    (mode.patches ?? []).filter((id) => !refused.includes(id as SpliceId)),
  );
  for (const patch of patches) {
    applyPatch(graph, patch);
  }

  for (const param of params) {
    const value = resolved[param.id];

    for (const target of param.targets) {
      const node = graph[target.node];
      if (!node) {
        throw new ParamError(
          `Workflow "${workflow.id}" maps ${param.id} to node ${target.node}, which is not in the graph.`,
          param.id,
        );
      }
      if (!(target.input in node.inputs)) {
        throw new ParamError(
          `Workflow "${workflow.id}" maps ${param.id} to ${node.class_type}.${target.input}, which that node does not accept.`,
          param.id,
        );
      }
      // A transform lets one control feed differently-shaped inputs, e.g. an
      // fps number into one node and into a formula string on another.
      node.inputs[target.input] = target.transform
        ? target.transform(value, resolved)
        : value;
    }
  }

  // After the values, because which sampler the graph wants is decided by one
  // of them. Nothing above targets the sampler, so there is no write to
  // overwrite — the node it replaces holds only its own class's settings.
  if (workflow.stepSampler) {
    applyStepSampler(graph, workflow.stepSampler, resolved);
  }

  // Runs last so it sees the resolved values and can prune anything they made
  // redundant — an unused optional input, and the node that fed it.
  workflow.finalize?.(graph, resolved);

  // After even that, because taking the director out prunes whatever was only
  // ever shown to it — including nodes `finalize` writes to on its way past.
  // See applyBypass.
  if (workflow.directorBypass && bypassApplies(workflow.directorBypass, resolved)) {
    applyBypass(graph, workflow.directorBypass);
  }

  return { graph, resolved, patches: patches.map((patch) => patch.id) };
}

/**
 * Structural check that every declared target resolves. Run against the
 * registry by `pnpm exec tsx scripts/check-workflows.ts`, and cheap enough to
 * also guard each request.
 */
export function validateWorkflow(workflow: WorkflowDef): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();

  for (const param of workflow.params) {
    if (seenIds.has(param.id)) {
      problems.push(`Duplicate param id "${param.id}".`);
    }
    seenIds.add(param.id);

    // The one control that is allowed to write nothing: the director bypass
    // does its work by unwiring a node rather than by setting a value, and a
    // target invented for it would have to write something it does not mean.
    // Anything else with no targets is a control that does nothing at all.
    if (
      param.targets.length === 0 &&
      param.id !== workflow.directorBypass?.param
    ) {
      problems.push(`Param "${param.id}" has no targets.`);
    }

    for (const target of param.targets) {
      const node = workflow.graph[target.node];
      if (!node) {
        problems.push(
          `Param "${param.id}" targets missing node "${target.node}".`,
        );
        continue;
      }
      if (!(target.input in node.inputs)) {
        problems.push(
          `Param "${param.id}" targets "${target.input}" which ${node.class_type} (node ${target.node}) does not accept.`,
        );
      }
    }
  }

  if (workflow.directorBypass) {
    problems.push(
      ...bypassProblems(
        workflow.directorBypass,
        workflow.graph,
        workflow.params,
      ),
    );
  }
  problems.push(...pinProblems(workflow));
  problems.push(...turboProblems(workflow));
  problems.push(...patchProblems(workflow));
  problems.push(...stepSamplerProblems(workflow));
  problems.push(...directorProblems(workflow));

  return problems;
}

/**
 * Whether every pin names a control that exists and holds a value that control
 * would accept — in either mode, because turbo moves the numeric ranges.
 *
 * A pin onto a param that has since been renamed would silently never fire; one
 * onto a number outside the control's range would fire and be rejected at
 * submit, on a control the user was shown as not theirs to fix. Both are the
 * kind of thing that only shows up on the run that needed it. See `pinnedBy`.
 */
function pinProblems(workflow: WorkflowDef): string[] {
  const problems: string[] = [];

  for (const param of workflow.params) {
    const pin = param.pinnedBy;
    if (!pin) continue;

    if (!workflow.params.some((other) => other.id === pin.whenSet)) {
      problems.push(
        `Param "${param.id}" is pinned by "${pin.whenSet}", which this workflow has no param for.`,
      );
    }

    if (param.type !== "slider" && param.type !== "number") continue;
    const ranges: Array<[string, number, number]> = [
      ["standard", param.min, param.max],
    ];
    if (workflow.turbo && workflow.turbo.steps.param === param.id) {
      ranges.push([
        "turbo",
        workflow.turbo.steps.min,
        workflow.turbo.steps.max,
      ]);
    }
    for (const [mode, min, max] of ranges) {
      if (Number(pin.value) < min || Number(pin.value) > max) {
        problems.push(
          `Param "${param.id}" is pinned to ${String(pin.value)}, which is outside its own ${min}–${max} range in ${mode} mode.`,
        );
      }
    }
  }

  return problems;
}

/**
 * Whether the step sampler would actually swap when its value is reached.
 *
 * Worth checking here more than any of the others, because this is the one
 * whose failure is silent in both directions. A graph that has no
 * `KSamplerSelect` to stand in for would throw at generation time; a control
 * whose range no longer contains the triggering value would simply never fire,
 * and every four-step run would quietly sample with the wrong sampler and come
 * back a worse video rather than an error.
 */
function stepSamplerProblems(workflow: WorkflowDef): string[] {
  const spec = workflow.stepSampler;
  if (!spec) return [];

  const problems: string[] = [];

  problems.push(...modelProblems(spec, workflow.graph));

  // A refused switch this workflow does not offer would refuse nothing, and the
  // form would say nothing either — `suppressedAt` lands on the patch it names,
  // so a name that matches none of them silently goes nowhere.
  for (const id of spec.suppresses ?? []) {
    if (!workflow.patches?.some((patch) => patch.id === id)) {
      problems.push(
        `The ${spec.atValue}-step form refuses the "${id}" switch, which this workflow does not offer.`,
      );
    }
  }

  if (!samplerNodeIn(workflow.graph, spec)) {
    const found = Object.values(workflow.graph).filter(
      (node) => node.class_type === spec.replaces,
    ).length;
    problems.push(
      `The ${spec.atValue}-step sampler stands in for exactly one ${spec.replaces}, but this graph has ${found}.`,
    );
  }

  const param = workflow.params.find((candidate) => candidate.id === spec.param);
  if (!param) {
    problems.push(
      `The step sampler keys off "${spec.param}", which this workflow has no param for.`,
    );
    return problems;
  }
  if (param.type !== "slider" && param.type !== "number") {
    problems.push(
      `The step sampler keys off "${spec.param}", which is a ${param.type} rather than a numeric control.`,
    );
    return problems;
  }

  // In whichever mode the control is in. Turbo moves the range, and a value
  // outside it in either mode is a swap that can never happen there.
  const ranges: Array<[string, number, number]> = [
    ["standard", param.min, param.max],
  ];
  if (workflow.turbo && workflow.turbo.steps.param === spec.param) {
    ranges.push(["turbo", workflow.turbo.steps.min, workflow.turbo.steps.max]);
  }
  for (const [mode, min, max] of ranges) {
    if (spec.atValue < min || spec.atValue > max) {
      problems.push(
        `The step sampler fires at ${spec.atValue}, which is outside "${spec.param}"'s ${min}–${max} range in ${mode} mode, so it would never be used there.`,
      );
    }
  }

  return problems;
}

/**
 * Whether each patch's splice would work on this graph — asked here for the
 * same reason as turbo's: a patch has no separate definition to check, and the
 * failure would otherwise land minutes into a render.
 *
 * Two cases per patch, because they are different splices. Alone, a patch
 * attaches to the UNET loader; in the full stack it attaches to a node that is
 * itself only there at run time, and a graph where that second splice found
 * nothing to sit in front of would pass the first check and fail the run.
 *
 * The full stack rather than every combination: with the splices anchored by
 * SPLICE_ORDER, an intermediate combination cannot break one that both the
 * alone and the everything-at-once case survive.
 */
function patchProblems(workflow: WorkflowDef): string[] {
  const patches = workflow.patches ?? [];
  if (patches.length === 0) return [];

  const problems: string[] = [];

  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.id)) {
      problems.push(`Two patches share the id "${patch.id}".`);
    }
    seen.add(patch.id);
  }

  const attempt = (
    what: string,
    where: string,
    apply: (graph: ComfyGraph) => void,
  ) => {
    try {
      apply(structuredClone(workflow.graph));
    } catch (error) {
      problems.push(
        `${what} cannot be applied${where}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  for (const patch of patches) {
    attempt(patch.label, " on its own", (graph) => applyPatch(graph, patch));
  }

  attempt("The switches", " together", (graph) => {
    if (workflow.turbo) applyTurbo(graph, workflow.turbo);
    for (const patch of patches) applyPatch(graph, patch);
  });

  return problems;
}

/**
 * Whether a graph that runs a prompt director also tells it how long the video
 * is. The length block is found by param id — `duration` on a graph that sets
 * its own length, `source_seconds` on one that measures a source clip — so
 * renaming either param would otherwise drop the block silently, and the only
 * symptom would be shot cut times landing past the end of the video.
 */
function directorProblems(workflow: WorkflowDef): string[] {
  const drivesDirector = workflow.params.some((param) =>
    param.targets.some(
      (target) =>
        target.input === "system_prompt" &&
        workflow.graph[target.node]?.class_type === "OAIAPI_ChatCompletion",
    ),
  );
  if (!drivesDirector) return [];

  const hasLength = workflow.params.some(
    (param) => param.id === "duration" || param.id === "source_seconds",
  );
  if (hasLength) return [];

  return [
    `Workflow drives a prompt director but has no "duration" or "source_seconds" param, so the director is never told how long the video is.`,
  ];
}

/**
 * Whether the turbo splice would work on this graph — asked here rather than
 * discovered at generation time, because the mode has no separate definition
 * to check and the failure would otherwise land minutes into a render.
 */
function turboProblems(workflow: WorkflowDef): string[] {
  const spec = workflow.turbo;
  if (!spec) return [];

  const problems: string[] = [];

  try {
    applyTurbo(structuredClone(workflow.graph), spec);
  } catch (error) {
    problems.push(
      `Turbo cannot be applied: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The splice working is not the same as the LoRA belonging on this model.
  const loader = modelLoaderIn(workflow.graph);
  if (spec.requiresModel?.length && loader) {
    const model = workflow.graph[loader].inputs.unet_name;
    const known =
      typeof model === "string" &&
      spec.requiresModel.some((prefix) => model.startsWith(prefix));
    if (!known) {
      problems.push(
        `Turbo's LoRA goes on ${spec.requiresModel.map((prefix) => `${prefix}*`).join(" or ")}, but this graph loads ${String(model)}.`,
      );
    }
  }

  // Each offered LoRA answers the same question the spec-level `requiresModel`
  // does, for itself: a list covering every option at once cannot catch one
  // that belongs on a different UNET from the graph offering it.
  if (spec.loras) {
    const ids = new Set<string>();
    for (const lora of spec.loras.options) {
      if (ids.has(lora.id)) {
        problems.push(`Turbo offers two LoRAs with the id "${lora.id}".`);
      }
      ids.add(lora.id);

      const model = loader ? workflow.graph[loader].inputs.unet_name : undefined;
      if (!lora.requiresModel?.length || typeof model !== "string") continue;
      if (!lora.requiresModel.some((prefix) => model.startsWith(prefix))) {
        problems.push(
          `Turbo's "${lora.id}" LoRA goes on ${lora.requiresModel
            .map((prefix) => `${prefix}*`)
            .join(" or ")}, but this graph loads ${model}.`,
        );
      }
    }

    // The node's own file is what a run with nothing chosen loads, so it has to
    // be one of the things on offer — otherwise the form opens showing a
    // selected option that is not what the graph would actually use.
    if (!defaultLora(spec)) {
      problems.push(
        `Turbo loads ${String(spec.node.inputs[spec.loras.input])} by default, which is not one of the LoRAs it offers.`,
      );
    }
  }

  const steps = workflow.params.find((param) => param.id === spec.steps.param);
  if (!steps) {
    problems.push(
      `Turbo retunes "${spec.steps.param}", which this workflow has no param for.`,
    );
  } else if (steps.type !== "slider" && steps.type !== "number") {
    problems.push(
      `Turbo retunes "${spec.steps.param}", which is a ${steps.type} rather than a numeric control.`,
    );
  } else if (
    spec.steps.default < spec.steps.min ||
    spec.steps.default > spec.steps.max
  ) {
    problems.push(
      `Turbo's default of ${spec.steps.default} steps is outside its own ${spec.steps.min}–${spec.steps.max} range.`,
    );
  }

  return problems;
}
