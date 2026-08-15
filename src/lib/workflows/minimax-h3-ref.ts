import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import { hideDirectorOnly } from "./director";
import type { ParamDef, ParamPin, ParamValue, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  directorBypassFor,
  effectiveSeconds,
  directorTarget,
  durationParam,
  REFERENCE_DIRECTOR,
  TRACK_WORDS,
  h3Bf16Models,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  leadingReferences,
  literalPromptParam,
  promptParam,
  promptTarget,
  referenceFacets,
  referenceSlot,
  referenceTrack,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 reference-to-video: up to four reference images steer the subject,
 * and the prompt says what they do.
 *
 * Notes on this export:
 *
 * - Node ids are flat, not the "105:" subgraph ids the text/image graphs use.
 * - The prompt is not an input on the video node. What the user types goes to
 *   node 138, an LLM expands it (144/145), and only that expanded text reaches
 *   the video node. So 138 is what the prompt control writes to.
 * - The rewrite stage is given the references as well, batched by node 146, so
 *   it can describe what it actually sees rather than guessing. That is the one
 *   structural difference from the text-to-video graph's rewrite stage.
 * - `ref_images.ref_image_0` … `ref_image_3` are ComfyUI's variadic input
 *   form, as are `images.image0` … on the batch. A run with fewer references
 *   must *remove* the unused inputs and their LoadImage nodes rather than leave
 *   them blank — see `finalize` below.
 * - A different UNET from the other two: `ref2va` rather than `fl2va`.
 * - `ref_audios.ref_audio_0` takes a track, through the trim at node 167 and
 *   from the loader at 155. Same variadic form as the images and the same rule:
 *   unused means removed, not blank. It is what the Create video button on a
 *   finished track fills in — see `clipTarget` — and the reason this graph,
 *   alone among the H3 ones, has a LoadAudio in it. What reaches the model is
 *   as many seconds of it as the video is long, from wherever the form says to
 *   start, unless the form says to send all of it.
 * - **A track pins the run to four steps**, and four steps loads a different
 *   diffusion model and text encoder from the rest of the range. See
 *   `FOUR_STEP_MODELS` and `TRACK_PINS_STEPS`.
 */
const ids: MinimaxNodeIds = {
  prompt: { node: "138", input: "value" },
  director: "145",
  duration: "132",
  noise: "129",
  scheduler: "124",
};

/**
 * One LoadImage per reference slot, in the order the form offers them. The
 * first is required; the rest are optional and each is dropped from the graph
 * when unused — see `finalize`.
 *
 * Four rather than two because the node's `ref_images` is variadic and takes as
 * many as it is given: the archived remix graph under archive/ ran five. Four
 * is where the form stops rather than where H3 does, so adding a fifth is a
 * LoadImage node and one more id in this list. Every slot feeds two consumers,
 * the video node and the batch that shows the references to the rewrite stage,
 * so dropping one means clearing a link in both places.
 */
const REF_NODES = ["137", "139", "165", "166"];
const REFERENCE_NODE = "136";
const BATCH_NODE = "146";
const AUDIO_NODE = "155";
const TRIM_NODE = "167";
const AUDIO_INPUT = "ref_audios.ref_audio_0";
const AUDIO_PARAM = "reference_audio";
const TRIM_PARAM = "reference_trim";
const TRIM_SECONDS_PARAM = "reference_trim_seconds";
const TRIM_START_PARAM = "reference_trim_start";
const TRACK_SECONDS_PARAM = "reference_track_seconds";
const LYRICS_PARAM = "reference_lyrics";

/** What the trim select offers, and what each answer means in seconds. */
const TRIM_WHOLE = "whole";
const TRIM_MATCH = "match";
const TRIM_SET = "set";

/** Whether this run has a reference track, which several things turn on. */
const trackAttached = (values: Record<string, ParamValue>): boolean =>
  String(values[AUDIO_PARAM] ?? "").trim() !== "";

/**
 * The weights this graph loads at four steps, in place of the ones the stored
 * graph names.
 *
 * A track and reference images together used to come back from ComfyUI as
 * `RuntimeError: The size of tensor a (3) must match the size of tensor b (2)
 * at non-singleton dimension 0`, and the pair was fenced off in the form
 * because nothing in the reference path — nodes_minimax_h3.py,
 * ldm/minimax/model.py, text_encoders/minimax.py — said it should fail. It was
 * the quantised pair: `minimax_h3_ref2va_pruned_int8_convrot` with
 * `qwen3vl_32b_minimax_h3_nvfp4_awq`. The bf16 diffusion model and the bf16
 * text encoder take the same references, together, at four steps, which is
 * where the fence went and why there is no longer one.
 *
 * The graphs on `fl2va` do not swap. They have never had the failure, so
 * pointing them at weights nobody here has tested would be a change with no
 * evidence behind it — and one more pair of files a fresh install has to
 * download. Remix runs the same `ref2va` UNET through the same node class and
 * does swap; see `h3Bf16Models`, which is where the pair now lives.
 */
const FOUR_STEP_MODELS = h3Bf16Models({ unet: "127", clip: "128" });

/**
 * A reference track holds the step count at four, which is the only step count
 * this graph is known to take one at.
 *
 * The bf16 pair above is loaded at four steps and nowhere else, so any other
 * value would run a track through the quantised models that failed on it. That
 * is a rule about the run rather than a preference, which is why it pins the
 * control instead of nudging its default: a stored 12 from a previous run would
 * otherwise sail straight past it. Removing the track hands the control back
 * with whatever number was in it.
 */
const TRACK_PINS_STEPS: ParamPin = {
  whenSet: AUDIO_PARAM,
  value: 4,
  note: "A reference track pins this to 4 — the step count the bf16 model pair and the pack's own sampler take a track at. Leave Turbo on: four steps without the distilled LoRA is not a usable take.",
};

/**
 * How many seconds of the track the model is given.
 *
 * One function rather than one per control, because both controls write the
 * same node input and a target write is an assignment: each of them has to
 * produce the whole answer or the last one to run would win with half of it.
 * The same rule the director's instructions are assembled under.
 *
 * "As long as the video" is the *snapped* length rather than the number on the
 * slider — the frame grid rounds a request up by as much as two thirds of a
 * second, and the trim should match what actually comes back rather than what
 * was asked for. It is the same number the director is told the video runs to.
 */
const trimSeconds = (values: Record<string, ParamValue>): number => {
  if (String(values[TRIM_PARAM] ?? TRIM_MATCH) === TRIM_SET) {
    return Number(values[TRIM_SECONDS_PARAM] ?? 15);
  }
  // Whole-track runs land here too, and it does not matter: `finalize` has
  // deleted the node this is written to by the time anything is queued.
  return effectiveSeconds(Number(values.duration ?? 10));
};

/**
 * Where in the track the reference starts, in seconds.
 *
 * Written by the start control and by the measurement of the track itself,
 * which both target the same input for the same reason the two length controls
 * do: a target write is an assignment, so each has to produce the whole answer.
 *
 * The measurement is what makes the control safe. `TrimAudioDuration` clamps a
 * start to the length of the audio and then raises if nothing is left — so a
 * start past the end of the track is the one way to fail the node — and the
 * browser reads that length off the loaded track and reports it here. With a
 * length known, `finalize` rejects an impossible start at submit and says how
 * long the track actually is; with none known it is passed through, which is
 * the pre-measurement case and the same risk every run took before.
 */
const startSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[TRIM_START_PARAM] ?? 0));

/** How long the loaded track runs, or 0 for "nothing has measured it". */
const trackSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[TRACK_SECONDS_PARAM] ?? 0));

/** How each slot names its input on those two nodes. Slot 1 is index 0. */
const refInput = (index: number) => `ref_images.ref_image_${index - 1}`;
const batchInput = (index: number) => `images.image${index - 1}`;

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      video: ["130", 0],
    },
    _meta: { title: "Save Video" },
  },
  "115": {
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 0.4,
      multiple: 32,
    },
    _meta: { title: "Resolution Selector (Size)" },
  },
  "119": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "120": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "121": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["125", 0], vae: ["120", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "122": {
    class_type: "VAEDecode",
    inputs: { samples: ["125", 0], vae: ["119", 0] },
    _meta: { title: "VAE Decode" },
  },
  "123": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
    _meta: { title: "KSamplerSelect" },
  },
  "124": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["127", 0],
    },
    _meta: { title: "BasicScheduler" },
  },
  "125": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["129", 0],
      guider: ["126", 0],
      sampler: ["123", 0],
      sigmas: ["124", 0],
      latent_image: ["136", 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "126": {
    class_type: "BasicGuider",
    inputs: { model: ["127", 0], conditioning: ["136", 0] },
    _meta: { title: "Basic Guider" },
  },
  "127": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "128": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "129": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 715435511296592 },
    _meta: { title: "RandomNoise" },
  },
  "130": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["122", 0],
      audio: ["121", 0],
    },
    _meta: { title: "Create Video" },
  },
  "131": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: FRAME_EXPRESSION(24),
      "values.a": ["132", 0],
    },
    _meta: { title: "Math Expression" },
  },
  "132": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
    _meta: { title: "Float (Duration)" },
  },
  "136": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      prompt: ["145", 0],
      width: ["115", 0],
      height: ["115", 1],
      length: ["131", 1],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["137", 0],
      "ref_images.ref_image_1": ["139", 0],
      "ref_images.ref_image_2": ["165", 0],
      "ref_images.ref_image_3": ["166", 0],
      // The one reference that is not a picture. It comes through the trim
      // rather than straight off the loader; both go on every run that has no
      // track — see `finalize`.
      "ref_audios.ref_audio_0": ["167", 0],
    },
    _meta: { title: "MiniMax H3 Reference to Video" },
  },
  "137": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },
  "138": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },
  "139": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },

  // The prompt-rewrite stage. 138 holds what the user typed, 146 batches the
  // references so the rewrite can see them, 145 expands the two into the
  // description node 136 actually reads. The api_key is "-" as exported: the
  // ComfyUI host supplies the real one.
  "144": {
    class_type: "OAIAPI_Client",
    inputs: {
      base_url: "https://api.openai.com/v1",
      max_retries: 2,
      timeout: 600,
      api_key: "-",
    },
    _meta: { title: "OpenAI API - Client" },
  },
  "145": {
    class_type: "OAIAPI_ChatCompletion",
    inputs: {
      model: "gpt-5.6-terra",
      force_regen: false,
      prompt: ["138", 0],
      // Overwritten per run by the duration param, which appends the finished
      // video's length — H3's format needs it to place shot cut times.
      system_prompt: REFERENCE_DIRECTOR,
      client: ["144", 0],
      images: ["146", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },
  "146": {
    class_type: "BatchImagesNode",
    // Variadic, like ref_images above: an unused slot's input is removed
    // outright rather than left pointing at a deleted node.
    inputs: {
      "images.image0": ["137", 0],
      "images.image1": ["139", 0],
      "images.image2": ["165", 0],
      "images.image3": ["166", 0],
    },
    _meta: { title: "Batch Images" },
  },

  // The third and fourth reference loaders. Not in the ComfyUI export — the
  // graph this came from wired two — but a LoadImage carries no state of its
  // own beyond the filename a param writes, so there is nothing here to keep in
  // step with an export.
  "165": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },
  "166": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },

  // The reference track. Not in the ComfyUI export either, and carries no
  // state beyond the filename a param writes.
  //
  // LoadAudio reads ComfyUI's input directory, which is why a generated track
  // has to be copied there before this can see it — /api/remix does that, the
  // same copy Remix and Extend make for a clip.
  "155": {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio" },
  },

  // How much of that track the model is actually given.
  //
  // Pressing Create video on a finished song hands over the whole song, and a
  // reference is not a running time: MiniMax's own model card puts a reference
  // audio at 2–15 seconds, ComfyUI's standalone `ref_audios` path truncates
  // nothing, and a three-minute track is thousands of latent frames of packed
  // sequence for a five-second video. So the trim sits between the loader and
  // the reference node, and the default is the length of the video being made.
  //
  // `TrimAudioDuration` is a ComfyUI built-in (comfy_extras/nodes_audio.py), so
  // this needs no pack the graph did not already need — but it is a recent one,
  // which is why it is in the stored graph rather than spliced in: `pnpm
  // check:nodes` then asks a real ComfyUI whether the class is there.
  //
  // Both inputs are written per run by the trim controls: `duration` for how
  // much, `start_index` for where from. Deleted outright when the whole track
  // is wanted, see `finalize`.
  "167": {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: ["155", 0],
      start_index: 0,
      duration: 15,
    },
    _meta: { title: "Trim Audio Duration" },
  },
};

/**
 * Everything that shapes the director's instructions writes this one target,
 * built once here so the duration and every facet select cannot disagree about
 * what it is. See `directorTarget` for why they all write the whole thing.
 *
 * The appendix is told how many slots this graph wires; it reads the submitted
 * values to find out how many actually have an image in them.
 */
/**
 * The words of the attached track, in the prompt and in the director's brief.
 * One declaration for both, so the block the director is told to look for is
 * the one the prompt actually carries.
 */
const words = wordsBlocks({
  sourceParam: AUDIO_PARAM,
  wordsParam: LYRICS_PARAM,
  source: TRACK_WORDS,
});

const director = directorTarget(ids, REFERENCE_DIRECTOR, [
  referenceFacets(REF_NODES.length),
  referenceTrack(AUDIO_PARAM),
  words.director,
]);

/**
 * The prompt text, which on this graph is written by two controls.
 *
 * The words of an attached track go into the prompt itself rather than only
 * into the director's brief, because the prompt is what reaches H3 either way —
 * see `promptTarget`. One target object, shared by both, so the two cannot
 * disagree about what they are writing.
 */
const promptText = promptTarget(ids, [words.prompt]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  // An upload and a facet select per slot, each slot revealed by the one before
  // it — so the form starts as one image and grows only as far as it is used.
  ...REF_NODES.flatMap((node, position) =>
    // The first picture is not required here, unlike everywhere else this
    // helper is used: a track is a reference too, and a run with one and no
    // pictures is a real thing to want. What replaces the check is in
    // `finalize`, which can see both controls at once.
    referenceSlot({ index: position + 1, node, director, firstRequired: false }),
  ),
  {
    id: AUDIO_PARAM,
    label: "Reference track",
    type: "audio",
    default: "",
    help: "Optional. Pins the run to 4 steps, which is where a track works. A long track is a reference rather than a running time, so only as much of it as the video is long is sent — see below.",
    group: "References",
    // Nothing else knows how long the track runs, and the start control has to
    // land inside it. The browser reads it off the loaded player and reports it
    // to the measured param below.
    measures: TRACK_SECONDS_PARAM,
    targets: [
      { node: AUDIO_NODE, input: "audio" },
      // Also the director's, which is told to stop inventing a score once a
      // real one has been handed to the model. See referenceTrack.
      director,
    ],
  },
  {
    id: TRACK_SECONDS_PARAM,
    label: "Track length",
    type: "measured",
    // Nothing measured yet, which every reader treats as "unknown" rather than
    // as an empty track — a form can be submitted before the player has its
    // metadata.
    default: 0,
    group: "References",
    targets: [
      {
        node: TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => startSeconds(values),
      },
    ],
  },
  {
    id: TRIM_PARAM,
    label: "How much of the track",
    type: "select",
    default: TRIM_MATCH,
    options: [
      { value: TRIM_MATCH, label: "As much as the video is long" },
      { value: TRIM_SET, label: "A set length" },
      { value: TRIM_WHOLE, label: "All of it" },
    ],
    help: "Pressing Create video on a finished song hands over the whole song. MiniMax documents a reference track at 2–15 seconds.",
    group: "References",
    // Only a question about a track that is there.
    revealedBy: AUDIO_PARAM,
    targets: [
      { node: TRIM_NODE, input: "duration", transform: (_value, values) => trimSeconds(values) },
    ],
  },
  {
    id: TRIM_START_PARAM,
    label: "Start at",
    type: "number",
    default: 0,
    min: 0,
    max: 3600,
    step: 0.5,
    unit: "sec",
    help: "Where in the track the reference is taken from. 0 is the opening, which on most songs is the least like the rest of it.",
    group: "References",
    // A question about a track that is there, and only while some of it is
    // being taken: with all of it, the trim node is not in the run at all.
    revealedBy: AUDIO_PARAM,
    hiddenBy: { param: TRIM_PARAM, is: TRIM_WHOLE },
    targets: [
      {
        node: TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => startSeconds(values),
      },
    ],
  },
  {
    id: TRIM_SECONDS_PARAM,
    label: "Seconds to use",
    type: "slider",
    default: 15,
    min: 1,
    max: 60,
    step: 0.5,
    unit: "sec",
    help: "How much to take from the start point. Past the end of the track simply stops there.",
    group: "References",
    // Both conditions, so a stored "a set length" cannot leave this control
    // sitting in a form with no track in it.
    revealedBy: [AUDIO_PARAM, { param: TRIM_PARAM, is: TRIM_SET }],
    targets: [
      { node: TRIM_NODE, input: "duration", transform: (_value, values) => trimSeconds(values) },
    ],
  },
  wordsParam({
    id: LYRICS_PARAM,
    label: "Words in the track",
    help: "Optional, and the single biggest thing you can do for a run with a track. Nothing here can hear the file, so without this the model writes its own words over yours. Section tags are read as structure, not sung.",
    group: "References",
    // Only a question about a track that is there. What was typed is kept and
    // comes back with the next one, the same as every other revealed control.
    revealedBy: AUDIO_PARAM,
    targets: [
      // The model reads this even with the rewrite switched off, which is the
      // reason it is a prompt target and not only a director one.
      promptText,
      // And the director is told what the block at the end of that prompt is,
      // and what to do with it. See wordsBlocks.
      director,
    ],
  }),
  {
    id: "ref_image_size",
    label: "Reference handling",
    type: "select",
    default: "match",
    options: [{ value: "match", label: "match" }],
    optionsFrom: { node: REFERENCE_NODE, input: "ref_image_size" },
    help: "max keeps more likeness, and is slower.",
    group: "References",
    advanced: true,
    targets: [{ node: REFERENCE_NODE, input: "ref_image_size" }],
  },

  promptParam(
    ids,
    "<Picture 1> is a superhero, mid-fight, in the ruins of a city.",
    "One line is enough. Name your references as <Picture 1>, <Picture 2> and so on, in upload order.",
    6,
    promptText,
  ),
  literalPromptParam(),

  durationParam(ids, director),
  {
    id: "aspect_ratio",
    label: "Aspect ratio",
    type: "select",
    default: "9:16 (Portrait Widescreen)",
    options: [
      { value: "9:16 (Portrait Widescreen)", label: "9:16 (Portrait Widescreen)" },
    ],
    optionsFrom: { node: "115", input: "aspect_ratio" },
    group: "Output",
    targets: [{ node: "115", input: "aspect_ratio" }],
  },
  {
    id: "megapixels",
    label: "Frame size",
    type: "slider",
    default: 0.5,
    min: 0.1,
    max: 2,
    step: 0.05,
    unit: "MP",
    help: "Higher is sharper, and slower.",
    group: "Output",
    targets: [{ node: "115", input: "megapixels" }],
  },

  ...samplingParams(ids, { pinSteps: TRACK_PINS_STEPS }),
];

export const minimaxH3Reference: WorkflowDef = {
  id: "minimax-h3-ref",
  name: "Reference to Video",
  description: "Puts people or objects from your images into a new scene.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  /**
   * This graph is where turbo started: the mode's first form in this app was a
   * ComfyUI export of *this* workflow with the LoRA spliced in, and it produced
   * usable takes. The switch was taken off for a while on the strength of the
   * LoRA's author calling `ref2va` unsupported — worth knowing, and the reason
   * to compare a turbo take against a standard one before trusting it for
   * identity work, but not a reason to withhold a mode that had been working.
   * <https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10>
   *
   * **It starts at four steps**, which is the fast end of the range and also the
   * only end of it the node pack has a complete form for: the four-step sampler,
   * the bf16 pair, no Spectrum. Eight is still there for a take worth spending
   * the time on, and a reference track pins the control to four in any case —
   * so four as the shipped number is what the graph was already doing whenever
   * a track was attached, made the default for everything else too.
   *
   * 140s is scaled from this graph's own 300s rather than measured, on the fit
   * the old 220s implied: 300 at twelve steps and 220 at eight puts a step at
   * 20s and everything that is not sampling — the rewrite, the model load, the
   * decode — at about 60s, so four steps is 60 + 80. The first finished turbo
   * run on a machine replaces it with that machine's median.
   */
  turbo: h3Turbo(140, 4),

  patches: h3Patches(),
  stepSampler: h3StepSampler({
    models: FOUR_STEP_MODELS,
    /**
     * Spectrum forecasts sampler steps from the ones already taken, and at four
     * steps there is nothing to forecast from worth having: the ComfyUI export
     * that produced a working four-step take with a reference track has no
     * Spectrum node in it. So the four-step form of this graph is the whole of
     * that export — distilled sampler, bf16 weights, no forecaster — and the
     * switch is refused rather than quietly left on.
     *
     * Which also settles the reference-track case, without a second rule for
     * it: a track pins the steps to 4, and this keys off the pinned value.
     */
    suppresses: ["spectrum"],
    note: "It also loads the bf16 diffusion model and text encoder — the pair that takes a reference track — and leaves Spectrum out, which the four-step form does not use.",
  }),

  /**
   * Where a finished track goes when you press Create video on it.
   *
   * The one hand-off that is not about a clip, which is why `accepts` exists:
   * the button belongs on an audio result and nowhere else, and offering Remix
   * on a track would send an mp3 to a LoadVideo node.
   *
   * Nothing is carried across. The music workflow's `prompt` is a description
   * of a record rather than of a scene, and its `duration` counts minutes while
   * this graph's counts seconds — a carried value is not clamped to the
   * destination's range, so that one would arrive out of bounds and be rejected
   * at submit. See ClipTarget.
   */
  clipTarget: {
    action: "illustrate",
    accepts: "audio",
    sourceParam: AUDIO_PARAM,
  },

  /**
   * Every reference slot past the ones actually filled has its variadic inputs
   * and its loader removed outright. Leaving them pointing at a LoadImage with
   * an empty filename would fail validation, and leaving one blank is not the
   * same as omitting it — the model would be told to expect a subject that was
   * never supplied.
   *
   * Both consumers have to be cleared before the loader goes. Dropping the
   * node while the batch still linked to it would queue a graph referencing a
   * node that no longer exists, which ComfyUI rejects outright.
   *
   * `leadingReferences` rather than "every slot with a value": the kept slots
   * have to be the first N with no hole in the middle, because the variadic
   * names left behind are what tells H3 how many pictures it has and in which
   * order — and it is the same count the director was given.
   */
  finalize(graph, values) {
    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      delete graph[REFERENCE_NODE].inputs[refInput(index)];
      delete graph[BATCH_NODE].inputs[batchInput(index)];
      delete graph[REF_NODES[index - 1]];
    }

    // With no pictures at all there is nothing to batch, and a BatchImagesNode
    // with no inputs is not an empty batch — it is a node that cannot produce
    // the IMAGE its consumer is asking for. So the batch goes and the director
    // loses its `images` input, which is optional on this node class: the music
    // graph's director runs without one.
    //
    // Only reachable because a track can stand in for the first picture. Every
    // other run keeps at least slot 1.
    if (filled === 0) {
      delete graph[ids.director].inputs.images;
      delete graph[BATCH_NODE];
    }

    // The track goes the same way as an unused picture, and for the same
    // reason: a LoadAudio with an empty filename fails validation, and a
    // variadic input left in place tells H3 to expect a reference that was
    // never supplied.
    if (!trackAttached(values)) {
      delete graph[REFERENCE_NODE].inputs[AUDIO_INPUT];
      delete graph[AUDIO_NODE];
      delete graph[TRIM_NODE];
    } else if (String(values[TRIM_PARAM] ?? TRIM_MATCH) === TRIM_WHOLE) {
      // All of it is the trim *removed* rather than the trim set to the track's
      // length: how long the file runs is not a number this app has — nothing
      // has opened it, and the browser never sees the bytes for a track that
      // arrived through Create video.
      graph[REFERENCE_NODE].inputs[AUDIO_INPUT] = [AUDIO_NODE, 0];
      delete graph[TRIM_NODE];
    }

    /**
     * The check that `required` cannot make, because it is about two controls
     * rather than one. Everything downstream of the reference node — the
     * subject definitions, the retention analysis, the sampler itself — is
     * built around something to hold on to, and a run with neither a picture
     * nor a track is a text-to-video run made on the wrong graph.
     *
     * Here rather than in a param because this is the first place both answers
     * are known, and it throws the same ParamError the coercion would, so it
     * reaches the form the same way any other rejected value does.
     */
    if (filled === 0 && !trackAttached(values)) {
      throw new ParamError(
        "Add a reference image or a reference track — this workflow needs at least one to build from.",
        "reference_image_1",
      );
    }

    /**
     * A start past the end of the track, which is the one way the trim node
     * fails: it clamps a start to the length of the audio and then raises
     * because there is nothing between the start and the end.
     *
     * Rejected here rather than clamped, because clamping would silently hand
     * the model a different part of the song than the one that was asked for,
     * and this is a number someone typed. Only decidable when the browser has
     * measured the track — with no measurement it is passed through, which is
     * what every run did before there was a start control at all.
     */
    const start = startSeconds(values);
    const length = trackSeconds(values);
    if (graph[TRIM_NODE] && length > 0 && start >= length) {
      throw new ParamError(
        `The track is ${length.toFixed(1)} seconds long, so it has nothing at ${start}s to start from.`,
        TRIM_START_PARAM,
      );
    }
  },
};
