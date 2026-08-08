import type { ComfyGraph } from "@/lib/comfy";

/**
 * A workflow is a ComfyUI API-format graph plus a declaration of which node
 * inputs the UI is allowed to drive. The graph stays verbatim from ComfyUI;
 * all the app-specific knowledge lives in `params[].targets`.
 */

/** Points at one node input, e.g. { node: "6", input: "width" }. */
export interface ParamTarget {
  node: string;
  input: string;
  /**
   * Derives what actually gets written from the submitted value. Without this
   * a control writes the same value to every target, which breaks when one
   * node needs the raw number and another needs it baked into a string —
   * see the fps/expression coupling in minimax-h3.ts.
   */
  transform?: (value: ParamValue) => unknown;
}

/**
 * Sources a select's options from the live ComfyUI schema instead of hardcoding
 * them. Resolved server-side from /object_info against the node's class_type,
 * so the dropdown always matches what that install actually supports.
 */
export interface OptionsFrom {
  node: string;
  input: string;
}

interface ParamBase {
  /** Stable key used in the API payload and as the form field name. */
  id: string;
  label: string;
  /** Shown under the control. Keep it to one line. */
  help?: string;
  /** Every node input this control writes to. One control can drive several. */
  targets: ParamTarget[];
  /** Section heading in the sidebar. Defaults to "Settings". */
  group?: string;
  /** Hidden behind the "Advanced" disclosure. */
  advanced?: boolean;
}

export interface TextParam extends ParamBase {
  type: "text" | "textarea";
  default: string;
  placeholder?: string;
  maxLength?: number;
  /** Rows for a textarea. Ignored for single-line text. */
  rows?: number;
}

export interface NumberParam extends ParamBase {
  type: "number" | "slider";
  default: number;
  min: number;
  max: number;
  step?: number;
  /** Rendered after the value, e.g. "px" or "frames". */
  unit?: string;
}

export interface SelectParam extends ParamBase {
  type: "select";
  default: string;
  /**
   * Fallback options, used as-is when `optionsFrom` is absent and as the
   * degraded list when ComfyUI cannot be reached. Always include at least the
   * default so the control still renders if the lookup fails.
   */
  options: Array<{ value: string; label: string; help?: string }>;
  optionsFrom?: OptionsFrom;
}

export interface ToggleParam extends ParamBase {
  type: "toggle";
  default: boolean;
}

/** A seed with a randomise affordance. `-1` means "pick a fresh one". */
export interface SeedParam extends ParamBase {
  type: "seed";
  default: number;
}

/**
 * An image the user uploads. The stored value is the reference ComfyUI returns
 * from /upload/image, which is what a LoadImage node expects — the file itself
 * lives in ComfyUI's input directory, not in this payload.
 */
export interface ImageParam extends ParamBase {
  type: "image";
  default: "";
  /** Block submission until something is uploaded. */
  required?: boolean;
}

export type ParamDef =
  | TextParam
  | NumberParam
  | SelectParam
  | ToggleParam
  | SeedParam
  | ImageParam;

export type ParamValue = string | number | boolean;

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  /** Short labels shown on the card, e.g. ["text-to-video", "720p"]. */
  tags?: string[];
  /** Rough wall-clock estimate, used only to pace the progress hint. */
  estimatedSeconds?: number;
  /**
   * Set when the graph produces a soundtrack. Browsers only permit autoplay on
   * muted media, so an audio workflow must not autoplay — otherwise the sound
   * it just spent minutes generating is silently thrown away.
   */
  hasAudio?: boolean;
  graph: ComfyGraph;
  params: ParamDef[];
  /**
   * Structural adjustment after the params are written in, on the cloned graph.
   *
   * Params can only set values on inputs that already exist. Some graphs need
   * more than that — an optional second reference image means both the link
   * and its LoadImage node have to disappear when unused, not merely be blank.
   */
  finalize?: (graph: ComfyGraph, values: Record<string, ParamValue>) => void;
}

/**
 * What the client is allowed to see. The graph is withheld because it names
 * local model files, and `targets` because they are wiring details the UI has
 * no use for — and because a target may carry a `transform` function, which
 * would not survive JSON anyway.
 */
/**
 * Distributes over the union so each member is omitted separately. A plain
 * Omit<ParamDef, ...> collapses the union into one shape and destroys the
 * `type` discriminant the form relies on to pick a control.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type ClientParam = DistributiveOmit<ParamDef, "targets" | "optionsFrom">;

export type WorkflowSummary = Omit<WorkflowDef, "graph" | "params"> & {
  params: ClientParam[];
};

export function toSummary(workflow: WorkflowDef): WorkflowSummary {
  const { graph: _graph, params, ...rest } = workflow;
  return {
    ...rest,
    params: params.map((param) => {
      const { targets: _targets, ...clientParam } = param;
      if ("optionsFrom" in clientParam) {
        delete (clientParam as { optionsFrom?: unknown }).optionsFrom;
      }
      return clientParam as ClientParam;
    }),
  };
}

export function defaultValuesFor(
  workflow: WorkflowSummary,
): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of workflow.params) values[param.id] = param.default;
  return values;
}
