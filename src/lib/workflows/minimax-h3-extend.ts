import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  directorTarget,
  FRAME_EXPRESSION,
  durationParam,
  EXTEND_DIRECTOR,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 extend: keep a clip running past where it stopped.
 *
 * Structurally this is the image-to-video graph with the clip's own last frame
 * standing in for an upload, plus a join on the way out. Three parts:
 *
 * 1. **The seam.** 126 loads the clip, 127 splits it into frames and audio, and
 *    128 takes the last frame of that sequence (`start_index: -1`). That single
 *    frame is the whole bridge: 105:104 receives it as `first_frame`, 120
 *    measures it for the output size, and 123 shows it to the prompt director.
 *    So the new segment starts on the exact image the source ended on, at the
 *    source's own dimensions — nothing else could line the two up.
 * 2. **The generation.** The 105:* nodes are the same sampler stack as the
 *    other generating graphs, and the same duration → frame-count expression.
 *    That duration times the *new segment only*, which is the one thing about
 *    this workflow that reliably surprises people: ask for 10 seconds on a
 *    12-second clip and 22 seconds come back.
 * 3. **The join.** 131 concatenates the source frames with the generated ones
 *    and 135 does the same to the two audio tracks, so 137/138 save the whole
 *    video rather than the addition on its own. That is what makes extending an
 *    extension work: the output is always a complete clip, so it can go
 *    straight back in through the Extend button.
 *
 * Which also means the file grows with each pass, and so does the time spent
 * decoding and re-encoding it — the sampling cost stays flat, since only the
 * new segment is ever generated.
 */
const ids: MinimaxNodeIds = {
  // Node 125, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "125", input: "value" },
  director: "123",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

const VIDEO_NODE = "126";

const graph: ComfyGraph = {
  "126": {
    class_type: "LoadVideo",
    // `video-preview` is a ComfyUI editor widget with no bearing on execution.
    // Kept because the graph stays verbatim from the export.
    inputs: { file: "", "video-preview": "" },
    _meta: { title: "Load Video" },
  },
  "127": {
    class_type: "GetVideoComponents",
    inputs: { video: ["126", 0] },
    _meta: { title: "Get Video Components" },
  },

  // The last frame of the clip, and the only frame anything downstream sees.
  //
  // `start_index: -1` with `num_frames: 1` is what picks it; the randomness and
  // distance widgets are carried from the export and do nothing at that index.
  "128": {
    class_type: "RandomImageFromBatch",
    inputs: {
      start_index: -1,
      end_index: -1,
      num_frames: 1,
      randomness: 0,
      min_distance: 0,
      max_distance: 0,
      seed: 0,
      input: ["127", 0],
    },
    _meta: { title: "Random Image From Batch" },
  },
  // Reading the frame rather than the clip: same numbers either way, and this
  // is the image the continuation is actually generated against.
  "120": {
    class_type: "GetImageSize",
    inputs: { image: ["128", 0] },
    _meta: { title: "Get Image Size" },
  },

  // The prompt-rewrite stage: 125 holds what the user typed and 123 turns it
  // into what node 105:104 reads, with the last frame in view.
  //
  // EXTEND_DIRECTOR is what makes this a continuation rather than a new scene
  // sharing an opening image — it reads the input as what happens next and
  // spends most of its instructions on not resetting at the seam. The api_key
  // is "-" as exported: the ComfyUI host supplies the real one.
  "121": {
    class_type: "OAIAPI_Client",
    inputs: {
      base_url: "https://api.openai.com/v1",
      max_retries: 2,
      timeout: 600,
      api_key: "-",
    },
    _meta: { title: "OpenAI API - Client" },
  },
  "123": {
    class_type: "OAIAPI_ChatCompletion",
    inputs: {
      model: "gpt-5.6-terra",
      force_regen: false,
      prompt: ["125", 0],
      // Overwritten per run by the duration param, which appends the length of
      // the segment being generated — not of the video that comes out, since
      // the source is concatenated on afterwards and never reaches the model.
      system_prompt: EXTEND_DIRECTOR,
      client: ["121", 0],
      images: ["128", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },
  "125": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  "105:11": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:24": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:23": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["105:14", 0], vae: ["105:24", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "105:10": {
    class_type: "VAEDecode",
    inputs: { samples: ["105:14", 0], vae: ["105:11", 0] },
    _meta: { title: "VAE Decode" },
  },
  "105:17": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
    _meta: { title: "KSamplerSelect" },
  },
  "105:9": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["105:6", 0],
    },
    _meta: { title: "BasicScheduler" },
  },
  "105:14": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["105:15", 0],
      guider: ["105:16", 0],
      sampler: ["105:17", 0],
      sigmas: ["105:9", 0],
      latent_image: ["105:104", 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "105:16": {
    class_type: "BasicGuider",
    inputs: { model: ["105:6", 0], conditioning: ["105:104", 0] },
    _meta: { title: "Basic Guider" },
  },
  "105:6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "105:13": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "105:15": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 689734481905865 },
    _meta: { title: "RandomNoise" },
  },
  "105:91": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["105:10", 0],
      audio: ["105:23", 0],
    },
    _meta: { title: "Create Video" },
  },
  "105:104": {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      prompt: ["123", 0],
      width: ["120", 0],
      height: ["120", 1],
      length: ["105:107", 1],
      clip: ["105:13", 0],
      vae: ["105:11", 0],
      first_frame: ["128", 0],
    },
    _meta: { title: "MiniMax H3 Image to Video" },
  },
  "105:107": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: FRAME_EXPRESSION(24),
      "values.a": ["105:111", 0],
    },
    _meta: { title: "Math Expression" },
  },
  "105:111": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
    _meta: { title: "Float (duration)" },
  },

  // The join. 132 splits the generated segment back into frames and audio so
  // both can be appended to the source's own — pictures in 131, sound in 135 —
  // and 137 re-encodes the pair as one video at the same 24fps.
  "132": {
    class_type: "GetVideoComponents",
    inputs: { video: ["105:91", 0] },
    _meta: { title: "Get Video Components" },
  },
  "131": {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["127", 0],
      "images.image1": ["132", 0],
    },
    _meta: { title: "Batch Images" },
  },
  "135": {
    class_type: "AudioConcatenate",
    inputs: {
      direction: "right",
      audio1: ["127", 1],
      audio2: ["132", 1],
    },
    _meta: { title: "AudioConcatenate" },
  },
  "137": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["131", 0],
      audio: ["135", 0],
    },
    _meta: { title: "Create Video" },
  },
  "138": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/minimax_extend",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["137", 0],
    },
    _meta: { title: "Save Video" },
  },
};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
const director = directorTarget(ids, EXTEND_DIRECTOR);

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to continue",
    type: "video",
    default: "",
    required: true,
    help: "Its last frame is where the new footage starts, and sets the size. Up to 768×1344, 20s, 4 MB.",
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "file" }],
  },

  promptParam(
    ids,
    "He turns to her and says we need to leave.",
    "Say what happens next, not what the clip already showed. It can see the last frame.",
    6,
  ),

  // Times the addition, not the result — the source's own length is whatever it
  // already was, and the two are concatenated afterwards. Worth saying on the
  // control itself, because every other workflow's duration is the duration of
  // the file that comes back.
  durationParam(ids, director, {
    label: "Added time",
    help: "How much new footage to generate. The result is the source clip plus this.",
    default: 5,
  }),

  ...samplingParams(ids),
];

export const minimaxH3Extend: WorkflowDef = {
  id: "minimax-h3-extend",
  name: "Extend",
  description: "Carries on from where a clip you already have left off.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  params,
  turbo: h3Turbo(220),
  patches: h3Patches(),
  stepSampler: h3StepSampler(),
  /**
   * No `carry`, unlike Remix. The prompt that made the source describes the
   * source, and this graph reads what you type as what happens *next* — so
   * carrying it across would ask the director to continue the clip by doing
   * again what it just did.
   */
  clipTarget: { action: "extend", videoParam: "source_video" },
};
