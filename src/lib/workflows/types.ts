import type { ComfyGraph } from "@/lib/comfy";
import { toClientPatch, type ClientPatch, type PatchDef } from "./patches";
import type { DirectorBypass } from "./director";
import type { StepSampler } from "./step-sampler";
import type { ClientTurbo, TurboSpec } from "./turbo";

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
   *
   * The whole submission is passed as well, because one input can depend on
   * more than one control: the prompt director's `system_prompt` is assembled
   * from the duration *and* the reference facet controls. Values are fully
   * resolved before any target is written, so what a transform sees does not
   * depend on where its param sits in the array — see applyParams.
   */
  transform?: (
    value: ParamValue,
    values: Record<string, ParamValue>,
  ) => unknown;
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
  /**
   * What this control waits on: it is left out of the form entirely until the
   * condition holds. For the chain of optional reference slots, where offering
   * all of them at once would be a wall of empty upload boxes for a workflow
   * most runs use one image on.
   *
   * A bare id asks whether that param has a value at all. `{ param, is }` asks
   * whether it has one particular value, which is what a control belonging to
   * one option of a select needs — the reference trim's length, which is only
   * the user's while the trim is set to a length. A list means *all* of them
   * have to hold, so a control can wait on a track being attached and on a
   * choice made about it.
   *
   * Presentation only. A hidden control still submits its stored value, and the
   * graph still has the input it targets — what a hidden slot must not do is
   * reach ComfyUI, which is the job of the workflow's `finalize`, not of this.
   */
  revealedBy?: ParamCondition | ParamCondition[];
  /**
   * The other way round: the control is left out while a named param *does*
   * have a value. For a control something else has taken over — the music
   * workflow's lyrics box, once the lyricist is switched on.
   *
   * Several means any one of them hides it, which is how a control that belongs
   * to one particular case is expressed: the instrumental section plan is
   * hidden by both the lyrics box and the lyricist switch, so it appears only
   * when neither is supplying words. Takes the same `{ param, is }` form as
   * `revealedBy` for a condition on a value rather than on there being one.
   *
   * Presentation only, on the same terms as `revealedBy`. The value is kept and
   * comes back when the switch goes off; what stops it reaching ComfyUI is the
   * workflow's `finalize`.
   */
  hiddenBy?: ParamCondition | ParamCondition[];
  /**
   * A line shown under the control only while the value matches — for a
   * consequence of a particular setting that would be noise at every other one.
   *
   * Not written by hand on a param. `toSummary` fills it in from whatever
   * declares the consequence, so the note cannot say something the graph does
   * not do; today that is the workflow's `stepSampler`.
   */
  noteAt?: { value: ParamValue; text: string };
  /**
   * A value this control is held at while another param is set, and the line
   * that says so. The third of the same family as `revealedBy` and `hiddenBy`,
   * for the case where a control neither waits nor stands down but stops being
   * the user's to choose.
   *
   * Unlike those two this is *not* presentation only: `applyParams` overwrites
   * the submitted value with the pinned one after coercion, so what runs is the
   * pinned value whatever the form did. It has to be, because the things that
   * read a value downstream — the step sampler, the model swap that comes with
   * it — would otherwise act on a number the user cannot see and did not pick.
   * The form shows the pinned value and disables the control so that the two
   * agree.
   *
   * The stored value is untouched, so removing whatever pinned it hands the
   * control straight back with the number that was in it.
   */
  pinnedBy?: ParamPin;
}

/**
 * A question about another control, for `revealedBy` and `hiddenBy`.
 *
 * A bare id is "does that param have a value"; the object form is "does it have
 * *this* value". Two shapes rather than one because the first is what almost
 * every use wants, and writing `{ param: "reference_image_1" }` four times over
 * would be ceremony around the common case.
 */
export type ParamCondition = string | { param: string; is: ParamValue };

/** See `pinnedBy`. */
export interface ParamPin {
  /** Id of the param whose being set pins this one. */
  whenSet: string;
  /** What this control is held at while it is. */
  value: ParamValue;
  /** The line shown under the control while it is pinned. */
  note: string;
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
 * A track in ComfyUI's input directory, which is where a LoadAudio node looks.
 * Same shape of value as an image or a video — the filename, never the bytes.
 *
 * It reaches the graph the same two ways a video does: an upload, or the
 * hand-off from a finished generation, which asks the server to copy a track
 * out of ComfyUI's output directory into its input one. The second is the one
 * that matters here, because a generated track is usually past the size limit
 * a browser upload has to stay inside.
 */
export interface AudioParam extends ParamBase {
  type: "audio";
  default: "";
  /** Block submission until something is chosen. */
  required?: boolean;
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
  | AudioParam
  | MeasuredParam;

export type ParamValue = string | number | boolean;

/**
 * The ways a finished generation can be sent onward into another workflow.
 * One button on the result for each, in this order.
 */
export const CLIP_ACTIONS = ["remix", "extend", "illustrate"] as const;
export type ClipAction = (typeof CLIP_ACTIONS)[number];

/**
 * Marks a workflow as where one of those buttons sends the finished file, and
 * names the param it is written into.
 *
 * Declared here rather than hardcoded in the UI so the buttons follow the
 * registry: swap the workflow behind Remix for another one and the button goes
 * with it, and a workflow that declares nothing is simply not a destination.
 * Only the first workflow declaring a given action is used.
 */
export interface ClipTarget {
  action: ClipAction;
  /**
   * Which kind of result this hand-off is offered on. A video result offers the
   * video actions, a finished track offers the audio ones, and the stage checks
   * the file that actually came back rather than the workflow that made it —
   * the same rule `isAudioOnly` follows in the history list.
   */
  accepts: "video" | "audio";
  /** The param the copied file's reference is written into. */
  sourceParam: string;
  /**
   * Param ids copied across from the generation the clip came from, where the
   * source workflow happens to declare the same id — so the new run starts out
   * matching it rather than reverting to whatever was last used here.
   *
   * Per workflow rather than global because what should travel depends on what
   * the destination does with it: Remix wants the prompt that made the source,
   * Extend very much does not. Nothing carries the seed; reusing it would pin
   * the new take to the old one's noise.
   *
   * Mind the ranges when adding one. A carried value is written straight into
   * the destination's form without being clamped to that control's own limits,
   * so an id the two workflows share for genuinely different quantities — the
   * music graph's `duration` counts minutes, every video graph's counts a
   * handful of seconds — would arrive out of range and be rejected at submit.
   */
  carry?: string[];
}

/**
 * A hand-off as the result view needs to know it: which button, and what kind
 * of file it belongs on. The param it writes and what travels with it are the
 * studio's business, not the stage's.
 */
export type ClipHandoff = Pick<ClipTarget, "action" | "accepts">;

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
  /**
   * The noun for what comes out, used where the UI has to name it — the
   * Generate button. Defaults to "video", which is what every graph here made
   * until the music one.
   *
   * A word rather than a medium ("audio") because the only place it is read is
   * a sentence shown to someone, and "Generate music" is what they are doing.
   * The history list does not use this: it reads the file that came back, which
   * still answers after a workflow has been renamed or removed. See isAudioOnly.
   */
  makes?: "video" | "music";
  graph: ComfyGraph;
  params: ParamDef[];
  /**
   * Set when this graph can also be run with the distilled LoRA spliced in —
   * the "Turbo" switch in the sidebar. A mode rather than a second workflow:
   * the two differ by one node and a step count, and nothing a user types
   * means anything different in one than the other. See turbo.ts.
   */
  turbo?: TurboSpec;
  /**
   * The single-node switches this graph offers — SageAttention, Spectrum — in
   * the order they stack in the model's path. Independent of turbo and of each
   * other: a run can have any combination of them, or none. See patches.ts.
   */
  patches?: PatchDef[];
  /**
   * Set when one step count wants a different sampler from the rest. Follows
   * from a control rather than from a switch of its own, so it has no entry in
   * `RunModes` and nothing to remember between runs. See step-sampler.ts.
   */
  stepSampler?: StepSampler;
  /**
   * Set when this graph's prompt-rewrite stage can be skipped, sending what the
   * user typed to the model unedited. A control rather than a mode, because it
   * is about what this particular prompt is rather than how the run is made —
   * so it sits with the prompt box. See director.ts.
   */
  directorBypass?: DirectorBypass;
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

export type WorkflowSummary = Omit<
  WorkflowDef,
  "graph" | "params" | "turbo" | "patches" | "stepSampler" | "directorBypass"
> & {
  params: ClientParam[];
  /** Present when the workflow offers the mode. Minus the node it splices in. */
  turbo?: ClientTurbo;
  /** Always present, empty where the workflow offers none. Minus their nodes. */
  patches: ClientPatch[];
  // No `stepSampler` and no `directorBypass`. All the browser needs of the
  // first is the note, which lands on the control it belongs to below; the rest
  // of both is node ids.
};

export function toSummary(workflow: WorkflowDef): WorkflowSummary {
  const {
    graph: _graph,
    params,
    turbo,
    patches,
    stepSampler,
    // Withheld like the graph itself: which node the switch unwires is server
    // wiring, and the form needs only the toggle, which is a param like any
    // other.
    directorBypass: _directorBypass,
    ...rest
  } = workflow;
  return {
    ...rest,
    // Their nodes are withheld for the same reason as turbo's below: they are
    // server-side wiring the form has no use for. What they gain is the rule
    // that refuses them at a particular step count, copied off the same
    // `stepSampler` the note below comes from — so the switch and the control
    // that overrides it cannot describe different runs.
    patches: (patches ?? []).map((patch) => {
      const client = toClientPatch(patch);
      if (stepSampler?.suppresses?.includes(patch.id)) {
        client.suppressedAt = {
          param: stepSampler.param,
          value: stepSampler.atValue,
          note: stepSampler.note,
        };
      }
      return client;
    }),
    // Withheld for the same reason as the graph: the node names a model file
    // that exists on the ComfyUI box and nowhere else.
    turbo: turbo
      ? {
          steps: turbo.steps,
          estimatedSeconds: turbo.estimatedSeconds,
          defaultOn: turbo.defaultOn,
          help: turbo.help,
          // Minus the node input it writes to, for the same reason a param
          // sheds its targets — see ClientTurbo.
          lowVram: turbo.lowVram
            ? { label: turbo.lowVram.label, help: turbo.lowVram.help }
            : undefined,
        }
      : undefined,
    params: params.map((param) => {
      const { targets: _targets, ...clientParam } = param;
      if ("optionsFrom" in clientParam) {
        delete (clientParam as { optionsFrom?: unknown }).optionsFrom;
      }
      // The step sampler's note lands on the control that triggers it, so the
      // form has nothing to know about the rule beyond what to say and when.
      if (stepSampler && param.id === stepSampler.param) {
        clientParam.noteAt = {
          value: stepSampler.atValue,
          text: stepSampler.note,
        };
      }
      return clientParam as ClientParam;
    }),
  };
}

/**
 * What "set" means for every control that keys off another one — a value that
 * is neither empty nor false. Shared so `revealedBy`, `hiddenBy` and `pinnedBy`
 * cannot disagree about whether the same param counts as answered.
 */
function isSet(value: ParamValue | undefined): boolean {
  return value !== undefined && value !== "" && value !== false;
}

/**
 * The value this control is held at right now, or undefined when it is the
 * user's to set. See `pinnedBy`.
 *
 * Read by the form, which shows it and disables the control, and by
 * `applyParams`, which writes it over whatever was submitted. Both call this
 * rather than testing the trigger themselves, so the number on screen is the
 * number that runs.
 */
export function pinnedValue(
  param: Pick<ParamBase, "pinnedBy">,
  values: Record<string, ParamValue>,
): ParamValue | undefined {
  if (!param.pinnedBy) return undefined;
  return isSet(values[param.pinnedBy.whenSet])
    ? param.pinnedBy.value
    : undefined;
}

/**
 * The submission as it will actually run: every pinned control at its pinned
 * value, everything else as it was.
 *
 * What the form has to read before deciding anything downstream of a value —
 * which switches a step count refuses, say — because a pinned control still
 * *stores* whatever was under it. `applyParams` does the same thing on its way
 * past, so the two agree by construction rather than by both remembering to.
 */
export function pinnedValues(
  params: Array<Pick<ParamBase, "id" | "pinnedBy">>,
  values: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const resolved = { ...values };
  for (const param of params) {
    const pinned = pinnedValue(param, values);
    if (pinned !== undefined) resolved[param.id] = pinned;
  }
  return resolved;
}

/**
 * Whether a control is in play at these values — see `revealedBy` and
 * `hiddenBy`, which are the same question asked in opposite directions.
 *
 * "Set" means a value that is neither empty nor false, which reads correctly
 * for both users: a reference slot waits on the picture before it, and the
 * music workflow's lyrics box stands down while its switch is on.
 *
 * Shared between the form and the record of a past generation on purpose. A
 * control the form was not showing is a control that had no part in the run,
 * and reading back a lyric sheet that was sitting in a hidden box while an LLM
 * wrote the words that were actually sung is worse than showing nothing.
 */
export function paramVisible(
  param: Pick<ParamBase, "revealedBy" | "hiddenBy">,
  values: Record<string, ParamValue>,
): boolean {
  // Every condition has to hold to reveal, and any one of them hides. Those are
  // not symmetrical on purpose: waiting is a chain of things that must be true,
  // and standing down is a list of reasons any of which is enough.
  if (!conditions(param.revealedBy).every((held) => holds(held, values))) {
    return false;
  }
  if (conditions(param.hiddenBy).some((held) => holds(held, values))) {
    return false;
  }
  return true;
}

function conditions(
  declared: ParamCondition | ParamCondition[] | undefined,
): ParamCondition[] {
  if (declared === undefined) return [];
  return Array.isArray(declared) ? declared : [declared];
}

function holds(
  condition: ParamCondition,
  values: Record<string, ParamValue>,
): boolean {
  return typeof condition === "string"
    ? isSet(values[condition])
    : values[condition.param] === condition.is;
}

export function defaultValuesFor(
  workflow: WorkflowSummary,
): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of workflow.params) values[param.id] = param.default;
  return values;
}
