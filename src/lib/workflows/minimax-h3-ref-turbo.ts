import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  durationParam,
  REFERENCE_DIRECTOR,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 reference-to-video, distilled: the same graph as minimax-h3-ref
 * with a turbo LoRA between the diffusion model and the sampler.
 *
 * The only structural difference is node 150. `MiniMaxH3TurboLoRA` takes the
 * UNET from 127 and everything downstream reads *its* output instead —
 * BasicScheduler (124) and BasicGuider (126) both point at 150 rather than 127.
 * That is the whole of it; the reference wiring, the rewrite stage and the
 * frame maths are unchanged.
 *
 * What it buys is step count. The base graph wants 12 and the ComfyUI export
 * ships 20; this one is distilled to converge in 4 to 8, so the steps control
 * has a different *range* here rather than merely a lower default — see the
 * sampling params below.
 *
 * **This graph needs a node pack the others do not.** `MiniMaxH3TurboLoRA` is
 * not a ComfyUI built-in — core ships only EmptyMiniMaxH3LatentAV,
 * MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo and MiniMaxH3SigmaShift. It
 * comes from Larryvrh/ComfyUI-MiniMax-H3-Turbo, and the LoRA file belongs in
 * `models/loras/`. An install without both fails at generation time, several
 * minutes in. `pnpm check:nodes` catches it before that.
 *
 * Kept as its own file rather than folded into minimax-h3-ref behind a flag,
 * for the reason every graph here is: each one stays verbatim from its ComfyUI
 * export so it can be diffed against a re-export. A shared builder would make
 * both undiffable to save a hundred lines.
 */
const ids: MinimaxNodeIds = {
  prompt: { node: "138", input: "value" },
  director: "145",
  duration: "132",
  noise: "129",
  scheduler: "124",
};

/** As in minimax-h3-ref: the optional second reference feeds two consumers. */
const SECOND_REF_NODE = "139";
const SECOND_REF_INPUT = "ref_images.ref_image_1";
const REFERENCE_NODE = "136";
const BATCH_NODE = "146";
const SECOND_BATCH_INPUT = "images.image1";

/** The turbo LoRA node, and the reason this workflow exists. */
const LORA_NODE = "150";

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      // A ComfyUI editor widget with no bearing on execution. Kept because the
      // graph stays verbatim from the export.
      "video-preview": "",
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
      // Overwritten by the steps param. The literal is the export's.
      steps: 8,
      denoise: 1,
      // The LoRA, not the raw UNET.
      model: [LORA_NODE, 0],
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
    // Also the LoRA. Both consumers of the model have to move, or the sigmas
    // would be scheduled against the distilled model while the guider ran the
    // base one.
    inputs: { model: [LORA_NODE, 0], conditioning: ["136", 0] },
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
    inputs: { noise_seed: 825299019924587 },
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

  // The prompt-rewrite stage, identical to minimax-h3-ref: 138 holds what the
  // user typed, 146 batches the references so the rewrite can see them, 145
  // expands the two into the description node 136 actually reads. The api_key
  // is "-" as exported: the ComfyUI host supplies the real one.
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
      // video's length — H3's format needs it to place shot cut times. The
      // director is the same one the non-turbo graph runs: the LoRA changes
      // how many steps the sampler needs, not what a good prompt looks like.
      system_prompt: REFERENCE_DIRECTOR,
      client: ["144", 0],
      images: ["146", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },
  "146": {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["137", 0],
      "images.image1": ["139", 0],
    },
    _meta: { title: "Batch Images" },
  },

  // The distillation. `strength` and `low_vram` are left as the export set
  // them rather than exposed: 1 is what the LoRA was trained to be applied at,
  // and low_vram is a property of the machine rather than of the shot.
  [LORA_NODE]: {
    class_type: "MiniMaxH3TurboLoRA",
    inputs: {
      lora_name: "minimax_h3_turbo_v4_step600_ema.safetensors",
      strength: 1,
      low_vram: false,
      model: ["127", 0],
    },
    _meta: { title: "MiniMax-H3 Turbo LoRA" },
  },
};

const params: ParamDef[] = [
  {
    id: "reference_image_1",
    label: "Reference image",
    type: "image",
    default: "",
    required: true,
    help: "The subject the video is built around.",
    group: "References",
    targets: [{ node: "137", input: "image" }],
  },
  {
    id: "reference_image_2",
    label: "Second reference",
    type: "image",
    default: "",
    help: "Optional. Refer to it as <Picture 2>.",
    group: "References",
    targets: [{ node: SECOND_REF_NODE, input: "image" }],
  },
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
    "One line is enough. Name your references as <Picture 1> and <Picture 2>, in upload order.",
    6,
  ),

  durationParam(ids, REFERENCE_DIRECTOR),
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

  // The one control that differs from the non-turbo graph. 4 to 8 rather than
  // 4 to 60: above that range the LoRA is being asked for something it was not
  // distilled to do, and the extra steps buy nothing for the time they cost.
  ...samplingParams(ids, {
    steps: 8,
    minSteps: 4,
    maxSteps: 8,
    stepsHelp: "The turbo LoRA converges here. 4 is fastest, 8 is safest.",
  }),
];

export const minimaxH3ReferenceTurbo: WorkflowDef = {
  id: "minimax-h3-ref-turbo",
  name: "Reference to Video (Turbo)",
  description: "The same, distilled to a handful of sampling steps.",
  /**
   * Scaled from minimax-h3-ref's 300s rather than measured: the same work at
   * 8 steps instead of 12, with the rewrite, the model load and the decode
   * unchanged. Only paces the progress hint, so being out by a bit is cheap —
   * worth correcting once there is a real run to correct it against.
   */
  estimatedSeconds: 220,
  hasAudio: true,
  graph,
  params,

  /** Identical to minimax-h3-ref — see the note there for why both consumers
   *  have to be cleared before the loader is dropped. */
  finalize(graph, values) {
    if (values.reference_image_2) return;
    delete graph[REFERENCE_NODE].inputs[SECOND_REF_INPUT];
    delete graph[BATCH_NODE].inputs[SECOND_BATCH_INPUT];
    delete graph[SECOND_REF_NODE];
  },
};
