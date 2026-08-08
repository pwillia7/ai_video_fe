import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";

/**
 * LTX-Video 2B text-to-video, built against the models actually present on the
 * instance (verified via /object_info). This is the reference implementation:
 * when you drop in your own workflow, export it from ComfyUI with
 * Workflow -> Export (API) and follow the same shape — a flat map of
 * node id -> { class_type, inputs }, where ["1", 0] means output 0 of node 1.
 *
 * The text encoder is loaded explicitly rather than taken from the checkpoint's
 * CLIP output, so this does not depend on whether the checkpoint bundles one.
 *
 * After any change run `pnpm check:workflows` — it fails on a stale param
 * mapping instead of quietly sending a wrong job to the GPU.
 */
const graph: ComfyGraph = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "ltx-video-2b-v0.9.1.safetensors" },
    _meta: { title: "LTX-Video checkpoint" },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: { clip_name: "t5xxl_fp8_e4m3fn.safetensors", type: "ltxv" },
    _meta: { title: "T5 text encoder" },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["2", 0] },
    _meta: { title: "Positive prompt" },
  },
  "4": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["2", 0] },
    _meta: { title: "Negative prompt" },
  },
  "5": {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width: 768, height: 512, length: 97, batch_size: 1 },
    _meta: { title: "Empty video latent" },
  },
  "6": {
    class_type: "LTXVConditioning",
    inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: 25 },
    _meta: { title: "LTXV conditioning" },
  },
  "7": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 30,
      cfg: 3,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["1", 0],
      positive: ["6", 0],
      negative: ["6", 1],
      latent_image: ["5", 0],
    },
    _meta: { title: "Sampler" },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["7", 0], vae: ["1", 2] },
    _meta: { title: "Decode" },
  },
  "9": {
    class_type: "SaveWEBM",
    inputs: {
      images: ["8", 0],
      filename_prefix: "VideoStudio",
      codec: "vp9",
      fps: 25,
      crf: 32,
    },
    _meta: { title: "Save video" },
  },
};

/** Enum values taken from this instance's /object_info for KSampler. */
const SAMPLERS = [
  "euler",
  "euler_ancestral",
  "heun",
  "dpm_2",
  "dpmpp_2m",
  "dpmpp_sde",
  "ddim",
  "uni_pc",
] as const;

const SCHEDULERS = [
  "normal",
  "simple",
  "sgm_uniform",
  "karras",
  "exponential",
  "ddim_uniform",
  "beta",
  "linear_quadratic",
] as const;

function params(defaults: { steps: number; cfg: number }): ParamDef[] {
  return [
    {
      id: "prompt",
      label: "Prompt",
      type: "textarea",
      rows: 6,
      default:
        "A lone figure in a long coat walks along a rain-slicked city street at night. Neon signs reflect in the puddles. Slow dolly shot, shallow depth of field, cinematic lighting.",
      placeholder: "Describe the shot: subject, action, camera move, lighting.",
      maxLength: 2000,
      help: "LTX-Video responds well to long, concrete descriptions including camera language.",
      group: "Prompt",
      targets: [{ node: "3", input: "text" }],
    },
    {
      id: "negative_prompt",
      label: "Negative prompt",
      type: "textarea",
      rows: 3,
      default:
        "low quality, worst quality, deformed, distorted, disfigured, jpeg artifacts, watermark, text, static, blurry",
      placeholder: "What to steer away from.",
      maxLength: 2000,
      group: "Prompt",
      targets: [{ node: "4", input: "text" }],
    },

    {
      id: "width",
      label: "Width",
      type: "slider",
      default: 768,
      min: 256,
      max: 1280,
      step: 32,
      unit: "px",
      group: "Output",
      targets: [{ node: "5", input: "width" }],
    },
    {
      id: "height",
      label: "Height",
      type: "slider",
      default: 512,
      min: 256,
      max: 1280,
      step: 32,
      unit: "px",
      group: "Output",
      targets: [{ node: "5", input: "height" }],
    },
    {
      id: "length",
      label: "Length",
      type: "slider",
      default: 97,
      min: 25,
      max: 257,
      step: 8,
      unit: "frames",
      help: "LTX-Video expects 8n+1 frames. 97 frames at 25 fps is just under 4 seconds.",
      group: "Output",
      targets: [{ node: "5", input: "length" }],
    },
    {
      id: "fps",
      label: "Frame rate",
      type: "number",
      default: 25,
      min: 8,
      max: 60,
      step: 1,
      unit: "fps",
      help: "Drives both the model's motion conditioning and the encoded playback rate.",
      group: "Output",
      // One control, two node inputs: the model conditions on frame_rate, and
      // the encoder needs a matching fps or playback speed drifts.
      targets: [
        { node: "6", input: "frame_rate" },
        { node: "9", input: "fps" },
      ],
    },

    {
      id: "seed",
      label: "Seed",
      type: "seed",
      default: -1,
      help: "Reuse a seed to reproduce a take. Randomised by default.",
      group: "Sampling",
      targets: [{ node: "7", input: "seed" }],
    },
    {
      id: "steps",
      label: "Steps",
      type: "slider",
      default: defaults.steps,
      min: 4,
      max: 60,
      step: 1,
      help: "30 is a good balance for LTX-Video; more brings diminishing returns.",
      group: "Sampling",
      targets: [{ node: "7", input: "steps" }],
    },
    {
      id: "cfg",
      label: "CFG scale",
      type: "slider",
      default: defaults.cfg,
      min: 1,
      max: 15,
      step: 0.1,
      help: "LTX-Video prefers a low CFG — around 3. High values scorch the image.",
      group: "Sampling",
      targets: [{ node: "7", input: "cfg" }],
    },
    {
      id: "sampler_name",
      label: "Sampler",
      type: "select",
      default: "euler",
      options: SAMPLERS.map((value) => ({ value, label: value })),
      group: "Sampling",
      advanced: true,
      targets: [{ node: "7", input: "sampler_name" }],
    },
    {
      id: "scheduler",
      label: "Scheduler",
      type: "select",
      default: "normal",
      options: SCHEDULERS.map((value) => ({ value, label: value })),
      group: "Sampling",
      advanced: true,
      targets: [{ node: "7", input: "scheduler" }],
    },
    {
      id: "denoise",
      label: "Denoise",
      type: "slider",
      default: 1,
      min: 0.1,
      max: 1,
      step: 0.05,
      group: "Sampling",
      advanced: true,
      targets: [{ node: "7", input: "denoise" }],
    },
    {
      id: "crf",
      label: "Encode quality",
      type: "slider",
      default: 32,
      min: 0,
      max: 63,
      step: 1,
      help: "Lower is higher quality and a bigger file.",
      group: "Sampling",
      advanced: true,
      targets: [{ node: "9", input: "crf" }],
    },
  ];
}

export const textToVideo: WorkflowDef = {
  id: "text-to-video",
  name: "LTX-Video · Text to Video",
  description:
    "Prompt-driven video at full sampling quality. The default choice for a finished take.",
  tags: ["text-to-video", "768x512", "quality"],
  estimatedSeconds: 150,
  graph,
  params: params({ steps: 30, cfg: 3 }),
};

export const textToVideoDraft: WorkflowDef = {
  id: "text-to-video-draft",
  name: "LTX-Video · Draft",
  description:
    "Same graph at a low step count. Audition prompts quickly, then re-run the seed on the quality workflow.",
  tags: ["text-to-video", "fast", "preview"],
  estimatedSeconds: 45,
  graph,
  params: params({ steps: 10, cfg: 3 }),
};
