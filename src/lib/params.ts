import type { ComfyGraph } from "@/lib/comfy";
import {
  applyBypass,
  bypassApplies,
  bypassProblems,
  promptConsumers,
} from "@/lib/workflows/director";
import { modelLoaderIn } from "@/lib/workflows/model-chain";
import {
  modelsFor,
  REWRITE_CLASSES,
  REWRITE_MODEL,
  REWRITE_MODELS,
  VISION_CLASS,
} from "@/lib/workflows/rewrite-model";
import type { RunModes } from "@/lib/workflows/modes";
import {
  applyPatch,
  enabledPatches,
  patchBaseFor,
  patchBaseProblems,
  patchChoice,
  type AppliedPatch,
} from "@/lib/workflows/patches";
import type { SpliceId } from "@/lib/workflows/model-chain";
import {
  applyStepSampler,
  modelProblems,
  samplerNodeIn,
  suppressedPatches,
} from "@/lib/workflows/step-sampler";
import { applyTurbo, turboParams } from "@/lib/workflows/turbo";
import {
  pinnedValue,
  pinTriggers,
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
  /**
   * What each switch that carries a LoRA list actually applied, by patch id:
   * which entry, which file, at what strength, on which checkpoint.
   *
   * One record per switch rather than three parallel maps, because they answer
   * for different readers and must not be able to disagree. It is reported
   * rather than assumed for the same reason `patches` is: an id that no longer
   * names an entry resolves to the default, so what ran is not always what was
   * asked for.
   */
  loras: Record<string, AppliedPatch>;
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
    applyTurbo(graph, workflow.turbo, mode.lowVram === true);
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
  // Keyed by the entry's id rather than the switch's, because the strength and
  // the checkpoint belong to the LoRA: switching to another one should find its
  // own numbers rather than inherit the last one's, whose range may not even
  // contain them.
  const loras: Record<string, AppliedPatch> = {};
  // Where a trigger would go, worked out once from the same link the bypass
  // rewires. Undefined on a graph with no director, which refuses a LoRA that
  // needs one rather than applying its weights with nothing to activate them.
  const promptInputs = workflow.directorBypass
    ? promptConsumers(graph, workflow.directorBypass)
    : undefined;
  for (const patch of patches) {
    // Resolved here rather than read straight off the request, because the
    // per-entry settings below are keyed by the entry that will actually run.
    // Keying them off the *requested* id instead would drop every one of them
    // whenever the id was absent or stale — which is the common case, since a
    // request need not name a LoRA at all to get the default one.
    const chosen = patchChoice(patch, mode.lora?.[patch.id])?.id;
    loras[patch.id] = applyPatch(graph, patch, {
      choice: chosen,
      strength: chosen ? mode.strengths?.[chosen] : undefined,
      alternateBase: chosen ? mode.alternateBase?.[chosen] : undefined,
      tier: chosen ? mode.tier?.[chosen] : undefined,
      promptInputs,
    });
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

  return {
    graph,
    resolved,
    patches: patches.map((patch) => patch.id),
    // What was actually written onto the spliced nodes, not what was asked for
    // — the rule `patches` already follows. A strength submitted for a switch
    // the run did not have would otherwise be recorded on a take that shows no
    // sign of it, and send someone off to compare two identical clips.
    // Only the switches that actually carry a list; the plain ones report an
    // empty record, which is nothing worth storing on a job.
    loras: Object.fromEntries(
      Object.entries(loras).filter(([, applied]) => applied.choice !== undefined),
    ),
  };
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
  problems.push(...stepSamplerBaseProblems(workflow));
  problems.push(...stepSamplerProblems(workflow));
  problems.push(...directorProblems(workflow));
  problems.push(...rewriteModelProblems(workflow));
  problems.push(...finalizeProblems(workflow));

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
/**
 * Every link in a graph that points at a node the graph does not have.
 *
 * The failure a queued graph dies of, and the one thing a workflow's `finalize`
 * can produce that nothing else can: params only ever set values on inputs that
 * already exist, so a dangling link means something was deleted while something
 * else was still reading it.
 */
function danglingLinks(graph: ComfyGraph): string[] {
  const bad: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && !graph[value[0]]) {
        bad.push(`${id}.${input} reads node ${value[0]}, which is not there`);
      }
    }
  }
  return bad;
}

/**
 * Runs the combinations a workflow declares its `finalize` has to survive, and
 * checks each one queues a graph ComfyUI would accept. See `finalizeCases`.
 *
 * The graph is built the same way a real run builds it — through `applyParams`,
 * so coercion, pins, splices and the bypass all happen in the order they do at
 * generation time. A case that is meant to be refused has to be refused with
 * the message it says; any other throw is the failure, not the test.
 */
function finalizeProblems(workflow: WorkflowDef): string[] {
  const problems: string[] = [];

  for (const testCase of workflow.finalizeCases ?? []) {
    const where = `Finalize case "${testCase.name}"`;
    try {
      const { graph } = applyParams(workflow, testCase.values);

      if (testCase.rejects) {
        problems.push(`${where} was expected to be refused and was not.`);
        continue;
      }
      for (const link of danglingLinks(graph)) {
        problems.push(`${where} queues a broken graph: ${link}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!testCase.rejects) {
        problems.push(`${where} failed: ${message}`);
      } else if (!message.includes(testCase.rejects)) {
        problems.push(
          `${where} was refused with "${message}", which does not mention "${testCase.rejects}".`,
        );
      }
    }
  }

  return problems;
}

function pinProblems(workflow: WorkflowDef): string[] {
  const problems: string[] = [];

  for (const param of workflow.params) {
    const pin = param.pinnedBy;
    if (!pin) continue;

    // Every trigger, not just the first: a pin naming two params is wrong in
    // exactly the same way if either one of them has been renamed away.
    for (const trigger of pinTriggers(pin)) {
      if (!workflow.params.some((other) => other.id === trigger)) {
        problems.push(
          `Param "${param.id}" is pinned by "${trigger}", which this workflow has no param for.`,
        );
      }
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

  // The same place a run would put a trigger, so the checks below fail for a
  // graph that genuinely has nowhere to put one rather than for not being told.
  const promptInputs = workflow.directorBypass
    ? promptConsumers(workflow.graph, workflow.directorBypass)
    : undefined;

  for (const patch of patches) {
    attempt(patch.label, " on its own", (graph) =>
      applyPatch(graph, patch, { promptInputs }),
    );
    problems.push(...patchBaseProblems(patch, workflow.graph));
  }

  attempt("The switches", " together", (graph) => {
    if (workflow.turbo) applyTurbo(graph, workflow.turbo);
    for (const patch of patches) applyPatch(graph, patch, { promptInputs });
  });

  return problems;
}

/**
 * Whether the step sampler's weight swap and a content LoRA's base agree.
 *
 * Both write the same input. The splices run before the step sampler does, so
 * at the swapping step count the sampler's file wins — and if the two named
 * different checkpoints, a run at that count would load the one the LoRA was
 * not made for while the form said otherwise. Nothing would fail; the take
 * would just come out wrong in the way the whole `base` declaration exists to
 * prevent.
 *
 * Checked rather than fixed by reordering, because the two agreeing is the
 * honest state: the four-step form loads the non-rotated weights *because* they
 * are the ones that work, which is the same reason the LoRA asks for them. A
 * disagreement means one of the two declarations is wrong, and that is a
 * question for whoever wrote it rather than something to paper over.
 */
function stepSamplerBaseProblems(workflow: WorkflowDef): string[] {
  const swaps = workflow.stepSampler?.models?.filter(
    (model) => model.input === "unet_name",
  );
  if (!swaps?.length) return [];

  const problems: string[] = [];
  for (const patch of workflow.patches ?? []) {
    for (const option of patch.choices?.options ?? []) {
      const base = patchBaseFor(option.bases, workflow.graph);
      if (!base) continue;
      const named = base.alternate
        ? [base.value, base.alternate.value]
        : [base.value];
      for (const swap of swaps) {
        for (const file of named) {
          if (file === swap.value) continue;
          problems.push(
            `At ${workflow.stepSampler!.atValue} steps this graph loads ${swap.value}, which would override ${option.label}'s ${file}.`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Whether every rewrite node in the graph is one the picker can actually reach,
 * and is set to a model the picker offers.
 *
 * Both halves fail the same way if they are wrong, and it is a bad way. The
 * gateway node's `model` is a live dropdown built from the gateway's own
 * catalog, and ComfyUI validates a combo against that list before it runs
 * anything — so a graph carrying a model id that is not in the offered list is
 * a graph that is one retired model away from being rejected outright, with the
 * user reading "value not in list" and no way to change it from the form.
 *
 * The second half catches the subtler one: a graph that grows a second rewrite
 * node — the music workflow already has two — and does not add it to the
 * picker's targets. That node would keep whatever model was baked in when it
 * was written, while the form says something else is being used.
 */
function rewriteModelProblems(workflow: WorkflowDef): string[] {
  const problems: string[] = [];
  const offered = new Set(REWRITE_MODELS.map((model) => model.id));

  const rewrites = Object.entries(workflow.graph).filter(([, node]) =>
    REWRITE_CLASSES.includes(node.class_type),
  );
  if (rewrites.length === 0) return problems;

  /**
   * Whether this graph shows its director a picture, which decides which models
   * it may be given: `DescribeImage` is handed an image and a model that cannot
   * be shown one fails the run, where `GenerateText` is happy with any of them.
   *
   * Checked rather than trusted because the answer is derived in two places —
   * `rewriteNode` picks the class from whether it was handed images, and
   * `rewriteModelParam` reads that class back off the graph — and a graph
   * carrying one node of each kind would make the second answer depend on which
   * node was asked.
   */
  const needsVision = rewrites.some(([, node]) => node.class_type === VISION_CLASS);
  const usable = new Set(modelsFor(needsVision).map((model) => model.id));

  for (const [id, node] of rewrites) {
    const model = node.inputs.model;
    if (typeof model !== "string" || !offered.has(model)) {
      problems.push(
        `Rewrite node ${id} is set to "${String(model)}", which the model picker does not offer. Run \`pnpm sync:models\`.`,
      );
      continue;
    }
    if (node.class_type === VISION_CLASS && !usable.has(model)) {
      problems.push(
        `Rewrite node ${id} is shown a picture but is set to "${model}", which cannot be shown one.`,
      );
    }
  }

  const picker = workflow.params.find((param) => param.id === REWRITE_MODEL);
  if (!picker) {
    problems.push(
      `Workflow runs ${rewrites.length} rewrite node(s) but declares no "${REWRITE_MODEL}" param, so the model cannot be changed from the form.`,
    );
    return problems;
  }

  // And the same of every option the form can put there. A picker offering a
  // text-only model to a node that is shown a picture is a rejected run one
  // click away.
  if (picker.type === "select") {
    for (const option of picker.options) {
      if (!usable.has(option.value)) {
        problems.push(
          `The model picker offers "${option.value}", which this workflow's rewrite node cannot use.`,
        );
      }
    }
  }

  const driven = new Set(
    picker.targets
      .filter((target) => target.input === "model")
      .map((target) => target.node),
  );
  for (const [id] of rewrites) {
    if (!driven.has(id)) {
      problems.push(
        `Rewrite node ${id} is not a target of "${REWRITE_MODEL}", so it would keep the model baked into the graph whatever the form says.`,
      );
    }
  }

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
        REWRITE_CLASSES.includes(
          workflow.graph[target.node]?.class_type ?? "",
        ),
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
