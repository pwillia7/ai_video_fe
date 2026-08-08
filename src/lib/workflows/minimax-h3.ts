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
 * MiniMax H3 text-to-video, with audio.
 *
 * Exported from ComfyUI verbatim. The node ids come from a flattened subgraph,
 * which is why most of them look like "105:104" — colons are fine, they are
 * just object keys.
 *
 * Two things about this graph are worth knowing before changing it:
 *
 * 1. The class is `MiniMaxH3ImageToVideo` but no image is wired in, so it runs
 *    in text-to-video mode. Leave the image input absent.
 * 2. Frame count is computed, not set. Node 105:111 holds a duration in
 *    seconds, and 105:107 converts it to frames via a formula that snaps to
 *    the nearest valid length. See FRAME_EXPRESSION below.
 */

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      "video-preview": "",
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
      prompt: "",
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

const DEFAULT_PROMPT = `Realistic live-action cinematic look, action movie trailer: practical film photography style, a post-rain dusk metropolis, anamorphic lens, shallow depth of field, film grain, city volumetric fog, flying-car traffic between the towers, restrained grading for a premium feel, powerful natural movement.

Scene overview: at dusk on a cluster of skyscrapers, the protagonist is being chased, sprinting and leaping across rooftops, jumping from one building's roof to the next with pursuers closing in behind. This is the escape sequence of an action movie trailer: every leap is life-or-death, thrilling and fluid.

Storyboard (each shot a separate scene, rapid cuts, all landing on the musical beats):
[0s-1.5s] Shot 1: high side angle: the protagonist sprinting at the roof edge, pursuers appearing in the rooftop doorway behind him, wind catching his coat.
[1s-2.5s] Shot 2: the protagonist leaps across the gap between buildings, body stretching mid-air, towers and flying-car light trails behind him, a slight slow-motion feel.
[2.5s-4s] Shot 3: he lands, rolls and rises, low-angle shot, tower shadows and fog behind him, he keeps running.
[4s-5s] Shot 4: freeze: the instant he hits the edge of the next roof and launches into the jump, silhouette, holding.

Camera: each shot its own angle, cuts clean and hard, no dissolves, a slight frame jitter on the jumps.

Audio: wind, rapid footsteps, city ambience, low score underneath, an accent hit on each leap, the score bursting at 4s, closing the last 1s.

No text, subtitles, logos or watermarks of any kind, no animation or cartoon rendering, no overly-CG look, keep the live-action texture.`;

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
  promptParam(
    ids,
    DEFAULT_PROMPT,
    "This model takes direction well: name the lens, the grade, the cuts, and the audio. There is no negative prompt on this graph.",
  ),

  durationParam(ids),
  {
    id: "aspect_ratio",
    label: "Aspect ratio",
    type: "select",
    default: "16:9 (Widescreen)",
    options: [{ value: "16:9 (Widescreen)", label: "16:9 (Widescreen)" }],
    optionsFrom: { node: "115", input: "aspect_ratio" },
    group: "Output",
    targets: [{ node: "115", input: "aspect_ratio" }],
  },
  {
    id: "megapixels",
    label: "Frame size",
    type: "slider",
    default: 0.4,
    min: 0.1,
    max: 2,
    step: 0.05,
    unit: "MP",
    help: "Total pixels per frame. The aspect ratio decides the shape, this decides the scale. Higher is slower and heavier on VRAM.",
    group: "Output",
    targets: [{ node: "115", input: "megapixels" }],
  },
  fpsParam(ids),
  {
    id: "multiple",
    label: "Size rounding",
    type: "slider",
    default: 32,
    min: 8,
    max: 64,
    step: 8,
    unit: "px",
    help: "Rounds width and height to a multiple of this. Leave at 32 unless the model complains.",
    group: "Output",
    advanced: true,
    targets: [{ node: "115", input: "multiple" }],
  },

  ...samplingParams(ids),
  ...encodingParams(ids),
];

export const minimaxH3: WorkflowDef = {
  id: "minimax-h3",
  name: "MiniMax H3 · Text to Video",
  description: "Video from a text prompt.",
  tags: ["text-to-video", "audio", "16:9"],
  estimatedSeconds: 180,
  hasAudio: true,
  graph,
  params,
};
