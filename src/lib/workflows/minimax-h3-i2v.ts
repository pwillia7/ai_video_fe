import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  durationParam,
  encodingParams,
  fpsParam,
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
 *    the real resolution control here.
 *
 * 2. Node 115 (ResolutionSelector) is left over from the text-to-video graph
 *    and is wired to nothing — width/height now come from node 120. Exposing
 *    its aspect_ratio or megapixels would give the user controls that do
 *    nothing at all, so they are deliberately absent. The node is kept so the
 *    graph stays a faithful copy of the export; ComfyUI only executes nodes
 *    that an output depends on, so it costs nothing.
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
  "115": {
    // Orphaned — see the note above. Nothing reads its outputs.
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "1:1 (Square)",
      megapixels: 0.4,
      multiple: 32,
    },
    _meta: { title: "Resolution Selector" },
  },
  "119": {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      upscale_method: "nearest-exact",
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
      prompt: "",
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
  prompt: { node: "105:104", input: "prompt" },
  duration: "105:111",
  video: "105:91",
  frameExpression: "105:107",
  noise: "105:15",
  scheduler: "105:9",
  sampler: "105:17",
  save: "92",
};

const params: ParamDef[] = [
  {
    id: "image",
    label: "First frame",
    type: "image",
    default: "",
    required: true,
    help: "The video starts from this image. Its aspect ratio decides the output shape.",
    group: "Image",
    targets: [{ node: "114", input: "image" }],
  },
  {
    id: "image_megapixels",
    label: "Working resolution",
    type: "slider",
    default: 0.6,
    min: 0.1,
    max: 2,
    step: 0.05,
    unit: "MP",
    help: "The upload is rescaled to this many pixels, and the video inherits those dimensions. Higher is slower and heavier on VRAM.",
    group: "Image",
    targets: [{ node: "119", input: "megapixels" }],
  },
  {
    id: "upscale_method",
    label: "Scaling method",
    type: "select",
    default: "nearest-exact",
    options: [{ value: "nearest-exact", label: "nearest-exact" }],
    optionsFrom: { node: "119", input: "upscale_method" },
    group: "Image",
    advanced: true,
    targets: [{ node: "119", input: "upscale_method" }],
  },
  {
    id: "resolution_steps",
    label: "Size rounding",
    type: "slider",
    default: 32,
    min: 8,
    max: 64,
    step: 8,
    unit: "px",
    help: "Rounds the scaled dimensions to a multiple of this.",
    group: "Image",
    advanced: true,
    targets: [{ node: "119", input: "resolution_steps" }],
  },

  promptParam(
    ids,
    "a page of suleiman the magnificent book and he gets up and starts break dancing",
    "Describe what should happen to the image. Motion, camera, and audio all respond to direction.",
  ),

  durationParam(ids),
  fpsParam(ids),

  ...samplingParams(ids),
  ...encodingParams(ids),
];

export const minimaxH3ImageToVideo: WorkflowDef = {
  id: "minimax-h3-i2v",
  name: "MiniMax H3 · Image to Video",
  description: "Your image becomes the first frame of the video.",
  tags: ["image-to-video", "audio"],
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  params,
};
