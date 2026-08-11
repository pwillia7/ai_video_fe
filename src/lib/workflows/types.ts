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

/**
 * A video living in ComfyUI's input directory, which is where a LoadVideo node
 * looks. Like an image, the stored value is only the filename.
 *
 * Two things put one here: an upload, and the clip hand-offs below — which
 * never send the file through the browser at all, they ask the server to copy a
 * finished generation out of ComfyUI's output directory into its input one.
 */
export interface VideoParam extends ParamBase {
  type: "video";
  default: "";
  /** Block submission until a video is chosen. */
  required?: boolean;
  /**
   * Id of a `measured` param this control fills in with the loaded clip's
   * running time. Named here rather than the other way round because the video
   * control is what has the clip in hand.
   */
  measures?: string;
}

/**
 * A number the UI observes rather than the user setting it — today, only the
 * running time of the clip a `video` param has loaded.
 *
 * It is a param rather than something bolted onto the video control because
 * what it is *for* is writing into the graph, and that is what params do: it
 * gets targets, coercion and storage like everything else. It renders no
 * control of its own.
 */
export interface MeasuredParam extends ParamBase {
  type: "measured";
  /**
   * What the value is before anything has been measured. Targets have to mean
   * something sensible at this value, because a graph can be submitted before
   * the clip's metadata has loaded.
   */
  default: number;
}

export type ParamDef =
  | TextParam
  | NumberParam
  | SelectParam
  | ToggleParam
  | SeedParam
  | ImageParam
  | VideoParam
  | MeasuredParam;

export type ParamValue = string | number | boolean;

/**
 * The ways a finished generation can be sent onward into another workflow.
 * One button on the result for each, in this order.
 */
export const CLIP_ACTIONS = ["remix", "extend"] as const;
export type ClipAction = (typeof CLIP_ACTIONS)[number];

/**
 * Marks a workflow as where one of those buttons sends the clip, and names the
 * video param it is written into.
 *
 * Declared here rather than hardcoded in the UI so the buttons follow the
 * registry: swap the workflow behind Remix for another one and the button goes
 * with it, and a workflow that declares nothing is simply not a destination.
 * Only the first workflow declaring a given action is used.
 */
export interface ClipTarget {
  action: ClipAction;
  videoParam: string;
  /**
   * Param ids copied across from the generation the clip came from, where the
   * source workflow happens to declare the same id — so the new run starts out
   * matching it rather than reverting to whatever was last used here.
   *
   * Per workflow rather than global because what should travel depends on what
   * the destination does with it: Remix wants the prompt that made the source,
   * Extend very much does not. Nothing carries the seed; reusing it would pin
   * the new take to the old one's noise.
   */
  carry?: string[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
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
  /** Which clip hand-off, if any, lands on this workflow. */
  clipTarget?: ClipTarget;
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
