import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
import {
  CLIP_WORDS,
  directorBypassFor,
  directorTarget,
  audioKeep,
  audioKeepHidesWords,
  audioKeepParam,
  audioKeepReusesWords,
  clipDurationParam,
  h3Bf16Models,
  h3ContentLora,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  promptTarget,
  REMIX_DIRECTOR,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 remix: rebuild a clip you already have.
 *
 * The clip goes in at node 154 and everything else follows from it:
 *
 * - 154 is VHS's loader, reading the clip at 24 fps. Its frames and its
 *   soundtrack go to the reference node as `ref_videos.ref_video_0` and
 *   `ref_video_audios.ref_video_audio_0` — the soundtrack slot that pairs by
 *   index with the video, not the standalone one. That pair is the only visual
 *   input the sampler gets.
 * - 155 takes every nth frame for the prompt director alone, at a stride 157
 *   works out from the frame count the loader reports — so the rewrite can see
 *   the clip it is editing rather than working blind from the filename. Nothing
 *   from that sample reaches the sampler; an earlier version wired it into
 *   `ref_images.*` as well, which is kept under archive/ for comparison.
 * - 163 measures the clip's own frames and supplies all three dimensions of
 *   the output: width, height, and length as a frame count. So a remix comes
 *   back the same shape and the same length as what went in, and there is
 *   neither a ResolutionSelector nor a duration node in this graph. That is
 *   also why the loader forces a frame rate: a count taken at one rate and
 *   written out at another is a remix that comes back the wrong length.
 *
 * So the clip is the one input the form offers, with one exception: **Words in
 * the clip**. That is not a second input to the graph — it writes no node the
 * clip does not already fill — but the clip's audio is a recording H3 is asked
 * to work over, and nothing on this side can hear it. Typing the words out is
 * the only way they reach either the director or the model. Same control, same
 * two blocks and the same reasoning as Reference to Video's attached track;
 * see `wordsBlocks`.
 *
 * Otherwise the reference audio and the output size are consequences of the clip
 * rather than choices, and controls for them would misrepresent what this graph
 * does. It can be filled either by the
 * Remix button (`clipTarget` below) or by an upload — see video-upload.tsx
 * for the limits that keeps within, which matter more here than elsewhere
 * because the clip decides what gets generated.
 */
const ids: Omit<MinimaxNodeIds, "duration"> = {
  prompt: { node: "138", input: "value" },
  director: "145",
  noise: "129",
  scheduler: "124",
};

const VIDEO_NODE = "154";

/**
 * The rate the clip is read at, and the rate the result is written at.
 *
 * One constant because the two must agree: this graph takes the output's frame
 * count from the source, so a source read at any other rate comes back the
 * wrong length. 24 is what `CreateVideo` writes and what H3 reads a reference
 * video at.
 */
const SOURCE_FPS = 24;

/** Roughly how many frames the director is shown. See node 157. */
const DIRECTOR_FRAMES = 5;
const VIDEO_PARAM = "reference_video";
const WORDS_PARAM = "clip_words";
const AUDIO_KEEP_PARAM = "clip_audio_keep";
/** A remix keeps its clip whole unless told otherwise. */
const AUDIO_KEEP_DEFAULT = "exact" as const;

/**
 * Whether this run reuses the speech that is already in the clip.
 *
 * Only the answer that keeps the recording whole does. "Voices only" keeps how
 * it is spoken and replaces what is said, and the three below it keep less than
 * that — so on any of them the words the user typed out describe audio that is
 * not being carried over.
 */
const keepsClipSpeech = (values: Record<string, ParamValue>): boolean =>
  audioKeepReusesWords(values, AUDIO_KEEP_PARAM, AUDIO_KEEP_DEFAULT);

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["130", 0],
    },
    _meta: { title: "Save Video" },
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
      steps: 16,
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
    inputs: { noise_seed: 147913421715932 },
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
  "136": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      prompt: ["145", 0],
      // All three measured off the clip: outputs 1, 2 and 3 of node 163 are
      // width, height and frame count.
      width: ["163", 1],
      height: ["163", 2],
      length: ["163", 3],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      // No ref_images here — the clip is the only reference the sampler gets.
      //
      // The soundtrack goes in `ref_video_audios`, not `ref_audios`, because it
      // is this clip's own audio rather than a second reference that happens to
      // be sound. The node pairs `ref_video_audio_N` with `ref_video_N` by
      // index and emits one fused `video_audio` conditioning block for the two;
      // `ref_audios` would emit a `video` block and an unrelated `audio` one,
      // which is a different thing to hand the model — a clip and a sound
      // beside it, rather than a clip that sounds like this.
      //
      // The labels are the same either way. References are presented as images,
      // then each video preceded by its own soundtrack, then standalone audio,
      // numbered 1-based per type — so with one video and nothing else this is
      // <Video 1> and <Audio 1> in both wirings, and REMIX_DIRECTOR's names for
      // them still hold.
      "ref_videos.ref_video_0": ["154", 0],
      "ref_video_audios.ref_video_audio_0": ["154", 2],
    },
    _meta: { title: "MiniMax H3 Reference to Video" },
  },
  "138": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  // The prompt-rewrite stage: 138 holds what the user typed and 145 expands it
  // into what node 136 actually reads.
  //
  // The system prompt is what sets this graph apart from the other three.
  // REMIX_DIRECTOR reads the input as a change to an existing video rather
  // than a scene to invent, and writes out instructions to hold everything
  // else to the source — which is the whole point of the workflow. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the ComfyUI
  // host.
  //
  // The `system_prompt` is overwritten per run by `source_seconds` below, which
  // appends how long the clip runs — measured in the browser, since nothing
  // here knows it until ComfyUI decodes the file. The sampled frames at 156 are
  // used here and nowhere else.
  "145": rewriteNode({
    prompt: ["138", 0],
    system: REMIX_DIRECTOR,
    images: ["155", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),

  // The clip, read at 24 fps.
  //
  // VHS's loader rather than ComfyUI's own, for the two reasons the reference
  // workflow moved to it. `force_rate` matters more here than anywhere: this
  // graph takes the output's *frame count* from the source (node 163) and
  // writes the result at 24 fps, so a clip at any other rate came back the
  // wrong length — a 30 fps ten-second clip is 300 frames, and 300 frames at 24
  // fps is a twelve-and-a-half-second remix, a quarter long and slowed to
  // match. Nothing noticed because the usual source is a generation from this
  // app, which is already 24.
  //
  // And VHS reads a file the core loader cannot measure: a browser's
  // MediaRecorder writes a fragmented MP4 whose header says duration 0 and
  // whose sample tables are empty. See minimax-h3-ref.ts, where that is what
  // reduced a fifteen-second clip to a single frame.
  //
  // No `frame_load_cap`: a remix is the whole clip by definition, which is what
  // separates it from a clip attached as a reference.
  //
  // Outputs: 0 is the frames, 1 is how many there are, 2 is the soundtrack.
  "154": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: SOURCE_FPS,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },

  // A handful of frames spread across the clip, for the director to look at.
  //
  // By stride over the decoded batch rather than by sampling the video, because
  // every node that selects frames from a VIDEO asks the container how many it
  // has — the question a MediaRecorder file answers wrongly. 157 works the
  // stride out from the frame count the loader actually returned.
  "155": {
    class_type: "VHS_SelectEveryNthImage",
    inputs: {
      images: ["154", 0],
      select_every_nth: ["157", 1],
      skip_first_images: 0,
    },
    _meta: { title: "Select Every Nth Image" },
  },
  "157": {
    class_type: "ComfyMathExpression",
    // Output 1 is the INT.
    inputs: {
      expression: `max(1, round(a / ${DIRECTOR_FRAMES}))`,
      "values.a": ["154", 1],
    },
    _meta: { title: "Math Expression" },
  },

  // Reads the clip's full frame sequence, not the five-frame sample: the count
  // has to be the length of the source, not the size of the director's peek.
  "163": {
    class_type: "GetImageSizeAndCount",
    inputs: { image: ["154", 0] },
    _meta: { title: "Get Image Size & Count" },
  },
};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
/**
 * The words heard in the source clip, in the prompt and in the director's brief.
 *
 * The clip's own audio is wired straight into the reference node, so this graph
 * hands H3 a recording to work over exactly as Reference to Video does with an
 * attached track — and nothing here can hear either of them. Same problem, same
 * pair of blocks, different noun for where the sound came from.
 */
const words = wordsBlocks({
  sourceParam: VIDEO_PARAM,
  wordsParam: WORDS_PARAM,
  source: CLIP_WORDS,
  // Only while the clip's own speech is being reused. Every other answer
  // replaces it, and a transcript of the old lines would then be the prompt
  // carrying exactly what the rest of the brief says to write anew.
  when: (values) => keepsClipSpeech(values),
});

const director = directorTarget(ids, REMIX_DIRECTOR, [
  words.director,
  // Last, so it lands after the standing preservation rules it overrides.
  audioKeep({
    param: AUDIO_KEEP_PARAM,
    // A remix keeps the clip's sound unless told otherwise, which is what the
    // director already assumed before this control existed.
    fallback: AUDIO_KEEP_DEFAULT,
    // The clip is required here, so its audio is always attached.
    attached: () => true,
  }),
]);

/** Written by the prompt and by the words below. See `promptTarget`. */
const promptText = promptTarget(ids, [words.prompt]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip to remix",
    type: "video",
    default: "",
    required: true,
    help: "Its size and length become the new video's. Up to 768×1344, 20s, 4 MB.",
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "video" }],
    // The clip is the only thing that knows how long the output will be, so
    // the control that loads it reports that onward to the param below.
    measures: "source_seconds",
  },

  // No control of its own: filled in by the clip above, and read only by the
  // prompt director. See clipDurationParam for why it exists at all.
  clipDurationParam(director),

  audioKeepParam(director, {
    id: AUDIO_KEEP_PARAM,
    label: "What to keep from the clip's sound",
    fallback: AUDIO_KEEP_DEFAULT,
    group: "Source",
    help: "The clip's own audio is given to the model whatever this says. This decides what the new soundtrack owes it — turn it down to have the sound change with the picture.",
  }),

  wordsParam({
    id: WORDS_PARAM,
    label: "Words in the clip",
    help: "What is said or sung in the clip's own audio. Nothing here can hear it, so without this the model writes its own words over the ones already there — and with the voices being replaced, these are the only copy of the lines there is.",
    // Beside the clip they belong to rather than in a section of their own.
    group: "Source",
    // And only while they are wanted: the answers that write new words have no
    // use for the old ones. See `keepsClipSpeech`.
    revealedBy: VIDEO_PARAM,
    hiddenBy: audioKeepHidesWords(AUDIO_KEEP_PARAM),
    targets: [promptText, director],
  }),

  promptParam(
    ids,
    "Make it snow, and dress the man in a heavy winter coat.",
    "Say only what should change. Everything you leave out is held to the clip.",
    6,
    promptText,
  ),
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // No output controls at all on this one. Size and length come from the clip,
  // and the frame rate is fixed at the 24 the model works in.
  //
  // Far fewer steps than the generating graphs: a remix is holding to a source
  // rather than inventing from noise, so it converges quickly. This is the
  // number that ships; node 124's literal is whatever the export happened to
  // carry and never reaches ComfyUI.
  //
  // It is also the number turbo retunes this control to, so switching modes on
  // this graph moves the range without moving the value.
  ...samplingParams(ids, { steps: 8 }),
];

export const minimaxH3ReferenceVideo: WorkflowDef = {
  id: "minimax-h3-ref2v",
  name: "Remix",
  description: "Rebuilds a clip you have already made into a new take.",
  estimatedSeconds: 480,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  /**
   * The same switch as every other video graph, on the same `ref2va` UNET
   * Reference to Video applies it to.
   *
   * It was withheld here for a while on the argument that this graph already
   * samples at 8, the top of the LoRA's range, so the LoRA would spend quality
   * per step and save no time. That was only ever an argument about the number
   * this workflow ships at, and it left the other end of the range broken: at 4
   * steps the graph takes the pack's four-step form — distilled sampler, bf16
   * weights, no Spectrum — and the sampler in that form exists to be paired with
   * the distilled LoRA. Four steps without one is not a usable take, so the
   * cheap end of the control was reachable and worthless.
   *
   * **It starts at four steps**, not at the eight this graph ships at with the
   * switch off. Four is where the node pack's own form is complete — its
   * four-step sampler, the bf16 pair, no Spectrum — and with the LoRA under it
   * that form is the fast one and the intended one at once. Eight is still a
   * drag of the control away for a take worth the extra minutes.
   *
   * 270s is scaled from this graph's own 480 on the fit Reference to Video's
   * numbers imply: about 60s of everything that is not sampling, and the rest
   * per step — so 480 at eight steps puts a step near 52s, and four of them at
   * 60 + 210. Measured on nothing; the first finished run in this combination
   * replaces it with this machine's median.
   */
  turbo: h3Turbo(270, 4),
  /**
   * The patches do apply, though, and for the reason turbo does not: they
   * change how a step is arrived at rather than how many there are, so a low
   * step count is no argument against either of them.
   */
  // The content LoRA first, matching the order they stack in. Same ref2va
  // backbone and same caveat as Reference to Video — see h3ContentLora.
  patches: [h3ContentLora(), ...h3Patches()],
  /**
   * The same four-step form as Reference to Video, because it is the same model
   * under the same node class: `minimax_h3_ref2va` through
   * `MiniMaxH3ReferenceToVideo`, given a reference to work over — pictures and a
   * track there, a clip and its audio here.
   *
   * So at four steps this graph is the pack's four-step form and nothing else:
   * the distilled sampler, the bf16 diffusion model and text encoder in place of
   * the quantised pair, and no Spectrum. The evidence for each is in
   * minimax-h3-ref.ts, where it was worked out; carried across on the strength
   * of the model rather than of a failure seen here, which is the honest account
   * — nothing has run *this* graph at four steps on the quantised pair to find
   * out whether it breaks the same way. If it turns out to run fine on them,
   * that is an argument for dropping the swap here, not for having guessed.
   *
   * What is *not* carried across is the pin. On Reference to Video a track holds
   * the steps at four, because the bf16 pair is loaded only there and the
   * quantised one failed on a track. This graph has audio on every run and ships
   * at eight steps, which is evidence the quantised pair takes a clip's audio
   * perfectly well — so pinning it here would fix a problem this workflow does
   * not have, at the cost of every remix it makes.
   */
  stepSampler: h3StepSampler({
    models: h3Bf16Models({ unet: "127", clip: "128" }),
    suppresses: ["spectrum"],
    note: "It also loads the bf16 diffusion model and text encoder, and leaves Spectrum out, which the four-step form does not use.",
  }),
  /**
   * The prompt is the one thing the clip cannot supply, so it comes across
   * from the generation being remixed. See ClipTarget for what deliberately
   * does not.
   */
  clipTarget: {
    action: "remix",
    accepts: "video",
    sourceParam: "reference_video",
    carry: ["prompt"],
  },
};
