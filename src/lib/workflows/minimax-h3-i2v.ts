import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  durationParam,
  IMAGE_DIRECTOR,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 image-to-video, with audio. Exported from ComfyUI verbatim.
 *
 * Two things about this graph differ from the text-to-video variant and drive
 * how the controls are wired:
 *
 * 1. Output size comes from the *image*, not from a size picker. Node 119
 *    scales the upload to a target megapixel count, node 120 reads the result,
 *    and those dimensions feed MiniMaxH3ImageToVideo. So `119.megapixels` is
 *    the real resolution control here. There is no ResolutionSelector at all —
 *    an earlier export carried an orphaned one, and this one drops it.
 *
 * 2. The prompt is not written to the video node. What the user types goes to
 *    node 125, an LLM expands it (121/123) with the uploaded image in view,
 *    and only that expanded text reaches 105:104.
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
  "114": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },
  "119": {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 32,
      image: ["114", 0],
    },
    _meta: { title: "Scale Image to Total Pixels" },
  },
  "120": {
    class_type: "GetImageSize",
    inputs: { image: ["119", 0] },
    _meta: { title: "Get Image Size" },
  },

  // The prompt-rewrite stage. 125 holds what the user typed, 123 expands it
  // with the upload in view, and 105:104 reads the result. Note that 123 is
  // given node 114 rather than the rescaled 119 — the rewrite reads the
  // original, at whatever size it arrived. The api_key is "-" as exported: the
  // ComfyUI host supplies the real one.
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
      // Overwritten per run by the duration param, which appends the finished
      // video's length — H3's format needs it to place shot cut times.
      system_prompt: IMAGE_DIRECTOR,
      client: ["121", 0],
      images: ["114", 0],
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
    inputs: { noise_seed: 940982408154912 },
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
      first_frame: ["119", 0],
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

const ids: MinimaxNodeIds = {
  // Node 125, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "125", input: "value" },
  director: "123",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

const params: ParamDef[] = [
  {
    id: "image",
    label: "First frame",
    type: "image",
    default: "",
    required: true,
    help: "The first frame. Its shape decides the video's.",
    group: "Image",
    targets: [{ node: "114", input: "image" }],
  },
  {
    id: "image_megapixels",
    label: "Working resolution",
    type: "slider",
    default: 0.5,
    min: 0.1,
    max: 2,
    step: 0.05,
    unit: "MP",
    help: "Higher is sharper, and slower.",
    group: "Image",
    targets: [{ node: "119", input: "megapixels" }],
  },

  promptParam(
    ids,
    "The subject stands up and starts dancing.",
    "Say what happens next, not what the image already shows. One line is enough.",
    6,
  ),

  durationParam(ids, IMAGE_DIRECTOR),

  ...samplingParams(ids),
];

export const minimaxH3ImageToVideo: WorkflowDef = {
  id: "minimax-h3-i2v",
  name: "Image to Video",
  description: "Your image becomes the first frame of the video.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  params,
};
