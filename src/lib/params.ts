import type { ComfyGraph } from "@/lib/comfy";
import { applyTurbo, modelLoaderIn, turboParams } from "@/lib/workflows/turbo";
import type { ParamDef, ParamValue, WorkflowDef } from "@/lib/workflows/types";

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

    // LoadImage and LoadVideo both take a filename in ComfyUI's input
    // directory rather than the file itself, so the two carry the same shape
    // of value and the same escape risk.
    case "image":
    case "video": {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        if (param.required) {
          throw new ParamError(
            `${param.label} is required — add ${param.type === "image" ? "an image" : "a video"} first.`,
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
  /** Run with the distilled LoRA spliced in. See turbo.ts. */
  turbo = false,
): AppliedParams {
  // structuredClone would choke on the transform functions, but those live on
  // the param definitions rather than the graph, so the graph clones cleanly.
  const graph = structuredClone(workflow.graph);
  const resolved: Record<string, ParamValue> = {};

  if (turbo) {
    if (!workflow.turbo) {
      throw new ParamError(`Workflow "${workflow.id}" has no turbo mode.`);
    }
    // Before the values are written, so `finalize` sees the graph that will
    // actually be queued. Nothing targets the loader or the LoRA either way.
    applyTurbo(graph, workflow.turbo);
  }

  // The steps control has a different range in turbo, so the range a value is
  // checked against has to be the one the form was showing.
  const params = turbo
    ? turboParams(workflow.params, workflow.turbo)
    : workflow.params;

  // Two passes. Everything is coerced before anything is written, so a
  // transform can read the whole submission and not merely its own value.
  //
  // The director's `system_prompt` is why: several controls contribute to it —
  // the duration, and on the reference graph the per-reference facet selects —
  // and each of them rebuilds the entire instruction from the same inputs. That
  // is only safe if they all see the same complete values, which in a single
  // pass they would not: what each could read would depend on where it sat in
  // the params array, and the last one to run would win with a partial view.
  for (const param of params) {
    resolved[param.id] = coerce(
      param,
      submitted[param.id],
      allowedValues ? allowedValues[param.id] : undefined,
    );
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

  // Runs last so it sees the resolved values and can prune anything they made
  // redundant — an unused optional input, and the node that fed it.
  workflow.finalize?.(graph, resolved);

  return { graph, resolved };
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

    if (param.targets.length === 0) {
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

  problems.push(...turboProblems(workflow));
  problems.push(...directorProblems(workflow));

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
