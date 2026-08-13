import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  directorTarget,
  FRAME_EXPRESSION,
  durationParam,
  TEXT_DIRECTOR,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 text-to-video, with audio.
 *
 * Exported from ComfyUI verbatim. The node ids come from a flattened subgraph,
 * which is why most of them look like "105:104" — colons are fine, they are
 * just object keys.
 *
 * Three things about this graph are worth knowing before changing it:
 *
 * 1. The class is `MiniMaxH3ImageToVideo` but no image is wired in, so it runs
 *    in text-to-video mode. Leave the image input absent.
 * 2. Frame count is computed, not set. Node 105:111 holds a duration in
 *    seconds, and 105:107 converts it to frames via a formula that snaps to
 *    the nearest valid length. See FRAME_EXPRESSION below.
 * 3. The prompt is not written to the video node. What the user types goes to
 *    node 123, an LLM rewrites it into a shot-by-shot description (120/121),
 *    and only that expanded text reaches 105:104. So a one-line idea is a
 *    perfectly good prompt here — see TEXT_DIRECTOR in minimax-common.
 */

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      video: ["105:91", 0],
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
    _meta: { title: "Resolution Selector" },
  },

  // The prompt-rewrite stage. 123 holds what the user typed, 121 expands it,
  // and 105:104 reads 121's output. The api_key is "-" as exported: the key
  // comes from the ComfyUI host's own environment, not from this app.
  "120": {
    class_type: "OAIAPI_Client",
    inputs: {
      base_url: "https://api.openai.com/v1",
      max_retries: 2,
      timeout: 600,
      api_key: "-",
    },
    _meta: { title: "OpenAI API - Client" },
  },
  "121": {
    class_type: "OAIAPI_ChatCompletion",
    inputs: {
      model: "gpt-5.6-terra",
      force_regen: false,
      prompt: ["123", 0],
      // Overwritten per run by the duration param, which appends the finished
      // video's length — H3's format needs it to place shot cut times.
      system_prompt: TEXT_DIRECTOR,
      client: ["120", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },
  "123": {
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
    inputs: { noise_seed: 368623947151307 },
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
      prompt: ["121", 0],
      width: ["115", 0],
      height: ["115", 1],
      length: ["105:107", 1],
      clip: ["105:13", 0],
      vae: ["105:11", 0],
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
};

/**
 * Short on purpose. The rewrite stage turns a one-liner into the shot list,
 * camera and audio, so a fully storyboarded default would just be showing
 * users work they no longer have to do.
 */
const DEFAULT_PROMPT =
  "A courier sprints across a rain-slick rooftop at dusk and leaps the gap to the next tower, drones closing in behind her.";

const ids: MinimaxNodeIds = {
  // Node 123, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "123", input: "value" },
  director: "121",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
const director = directorTarget(ids, TEXT_DIRECTOR);

const params: ParamDef[] = [
  promptParam(
    ids,
    DEFAULT_PROMPT,
    "One line is enough. A director model fills in the shots, camera and sound, and keeps whatever you do specify.",
    6,
  ),

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

  ...samplingParams(ids),
];

export const minimaxH3: WorkflowDef = {
  id: "minimax-h3",
  name: "Text to Video",
  description: "Video from a text prompt.",
  estimatedSeconds: 180,
  hasAudio: true,
  graph,
  params,
  turbo: h3Turbo(130),
  patches: h3Patches(),
  stepSampler: h3StepSampler(),
};
