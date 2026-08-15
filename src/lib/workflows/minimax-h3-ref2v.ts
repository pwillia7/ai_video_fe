import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import type { ParamDef, WorkflowDef } from "./types";
import {
  CLIP_WORDS,
  directorBypassFor,
  directorTarget,
  clipDurationParam,
  h3Bf16Models,
  h3Patches,
  h3StepSampler,
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
 * - 153 splits it into frames and audio, which go to the reference node as
 *   `ref_videos.ref_video_0` and `ref_audios.ref_audio_0`. That pair is the
 *   only visual input the sampler gets.
 * - 155 samples five frames spread evenly across it and 156 turns them back
 *   into images, which go to the prompt director alone — so the rewrite can
 *   see the clip it is editing rather than working blind from the filename.
 *   Nothing from that sample reaches the sampler; an earlier version wired it
 *   into `ref_images.*` as well, which is kept under archive/ for comparison.
 * - 163 measures the clip's own frames and supplies all three dimensions of
 *   the output: width, height, and length as a frame count. So a remix comes
 *   back the same shape and the same length as what went in, and there is
 *   neither a ResolutionSelector nor a duration node in this graph.
 *
 * So the clip is the one input the form offers, with one exception: **Words in
 * the clip**. That is not a second input to the graph — it writes no node the
 * clip does not already fill — but the audio at 153 is a recording H3 is asked
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
const VIDEO_PARAM = "reference_video";
const WORDS_PARAM = "clip_words";

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
      "ref_videos.ref_video_0": ["153", 0],
      "ref_audios.ref_audio_0": ["153", 1],
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
  // else to the source — which is the whole point of the workflow.
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
      // Overwritten per run by `source_seconds` below, which appends how long
      // the clip runs — measured in the browser, since nothing here knows it
      // until ComfyUI decodes the file.
      system_prompt: REMIX_DIRECTOR,
      client: ["144", 0],
      // The sampled frames, and the only place they are used.
      images: ["156", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },

  "153": {
    class_type: "GetVideoComponents",
    inputs: { video: ["154", 0] },
    _meta: { title: "Get Video Components" },
  },
  "154": {
    class_type: "LoadVideo",
    // `video-preview` is a ComfyUI editor widget with no bearing on execution.
    // Kept because the graph stays verbatim from the export.
    inputs: { file: "", "video-preview": "" },
    _meta: { title: "Load Video" },
  },

  // Five frames spread evenly across the clip, for the director to look at.
  //
  // `seed` is carried from the export rather than exposed. It should not
  // select anything while `strategy` is "uniform" — evenly spaced frames are
  // not a random draw — but it is the one widget value here that no param
  // overwrites, so it is kept in step with the export rather than guessed at.
  "155": {
    class_type: "VideoFrameSample",
    inputs: {
      num_frames: 5,
      strategy: "uniform",
      seed: 249656790861689,
      video: ["154", 0],
    },
    _meta: { title: "Sample Video Frame" },
  },
  "156": {
    class_type: "GetVideoComponents",
    inputs: { video: ["155", 0] },
    _meta: { title: "Get Video Components" },
  },

  // Reads the clip's full frame sequence, not the five-frame sample: the count
  // has to be the length of the source, not the size of the director's peek.
  "163": {
    class_type: "GetImageSizeAndCount",
    inputs: { image: ["153", 0] },
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
 * The clip's own audio is wired straight into `ref_audios.ref_audio_0`, so this
 * graph hands H3 a recording to work over exactly as Reference to Video does
 * with an attached track — and nothing here can hear either of them. Same
 * problem, same pair of blocks, different noun for where the sound came from.
 */
const words = wordsBlocks({
  sourceParam: VIDEO_PARAM,
  wordsParam: WORDS_PARAM,
  source: CLIP_WORDS,
});

const director = directorTarget(ids, REMIX_DIRECTOR, [words.director]);

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
    targets: [{ node: VIDEO_NODE, input: "file" }],
    // The clip is the only thing that knows how long the output will be, so
    // the control that loads it reports that onward to the param below.
    measures: "source_seconds",
  },

  // No control of its own: filled in by the clip above, and read only by the
  // prompt director. See clipDurationParam for why it exists at all.
  clipDurationParam(director),

  wordsParam({
    id: WORDS_PARAM,
    label: "Words in the clip",
    help: "Optional. What is said or sung in the clip's own audio. Nothing here can hear it, so without this the model writes its own words over the ones already there.",
    // Beside the clip they belong to rather than in a section of their own.
    group: "Source",
    revealedBy: VIDEO_PARAM,
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

  // No output controls at all on this one. Size and length come from the clip,
  // and the frame rate is fixed at the 24 the model works in.
  //
  // Far fewer steps than the generating graphs: a remix is holding to a source
  // rather than inventing from noise, so it converges quickly. This is the
  // number that ships; node 124's literal is whatever the export happened to
  // carry and never reaches ComfyUI.
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
   * No `turbo` here, though the model would now allow it — see minimax-h3-ref,
   * which runs the same `ref2va` UNET and does carry the switch. This graph
   * already samples at 8, the top of the LoRA's range, so turning it on would
   * buy no time at all and spend quality per step for the privilege.
   *
   * That argument covers the graph as it ships and not the whole of the steps
   * control. Anyone who moves it to 4 now gets the pack's four-step form —
   * distilled sampler, bf16 weights, no Spectrum — with no distilled LoRA under
   * it, and four steps without one is not a usable take. Adding `h3Turbo` here
   * is what would finish that end of the range; it is left off rather than
   * turned on quietly because the shared spec defaults to *on*, and that would
   * change what every ordinary remix is without anyone asking for it.
   */
  /**
   * The patches do apply, though, and for the reason turbo does not: they
   * change how a step is arrived at rather than how many there are, so a low
   * step count is no argument against either of them.
   */
  patches: h3Patches(),
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
