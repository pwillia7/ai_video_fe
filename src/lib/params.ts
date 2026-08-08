import type { ComfyGraph } from "@/lib/comfy";
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

    case "image": {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        if (param.required) {
          throw new ParamError(
            `${param.label} is required — upload an image first.`,
            param.id,
          );
        }
        return "";
      }
      // The value is a filename destined for a LoadImage node, so it must not
      // be able to escape ComfyUI's input directory.
      if (value.includes("..") || value.startsWith("/") || value.includes("\\")) {
        throw new ParamError(`Invalid image reference.`, param.id);
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
): AppliedParams {
  // structuredClone would choke on the transform functions, but those live on
  // the param definitions rather than the graph, so the graph clones cleanly.
  const graph = structuredClone(workflow.graph);
  const resolved: Record<string, ParamValue> = {};

  for (const param of workflow.params) {
    const value = coerce(
      param,
      submitted[param.id],
      allowedValues ? allowedValues[param.id] : undefined,
    );
    resolved[param.id] = value;

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
        ? target.transform(value)
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

  return problems;
}
