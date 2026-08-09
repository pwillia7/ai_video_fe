import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  durationParam,
  encodingParams,
  fpsParam,
  promptParam,
  REMIX_DIRECTOR,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 remix: rebuild a clip you already have.
 *
 * The reference node is the same one the image-driven workflow uses, but
 * nothing here is supplied by hand. The clip goes in at node 154 and the graph
 * derives everything else from it:
 *
 * - 153 splits the clip into frames and audio, which become the video and
 *   audio references.
 * - 155 samples five frames spread evenly across it, 156 turns that sample
 *   back into images, and 157-161 peel off one frame each to fill the five
 *   reference-image slots.
 * - 156 also feeds the rewrite stage, so the director sees what the clip looks
 *   like rather than working blind from the filename.
 *
 * That is why the form has no image controls and no video picker: those inputs
 * are consequences of the clip, not choices. The clip arrives from the Remix
 * button (`remixTarget` below), which is the only way into this workflow.
 */
const ids: MinimaxNodeIds = {
  prompt: { node: "138", input: "value" },
  duration: "132",
  video: "130",
  frameExpression: "131",
  noise: "129",
  scheduler: "124",
  sampler: "123",
  save: "92",
};

const REFERENCE_NODE = "136";
const VIDEO_NODE = "154";

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
    inputs: { noise_seed: 940146333185580 },
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
      // Linked, where the export carried a literal 768 with width still wired
      // to the selector. That pairing cannot produce the aspect the control
      // promises — 0.4 MP at 16:9 is about 848x480, and 848x768 is nearly
      // square. Reconnected on the assumption the link was dropped by
      // accident; pin it back to 768 if it was not.
      height: ["115", 1],
      length: ["131", 1],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["157", 0],
      "ref_images.ref_image_1": ["158", 0],
      "ref_images.ref_image_2": ["159", 0],
      "ref_images.ref_image_3": ["160", 0],
      "ref_images.ref_image_4": ["161", 0],
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
      system_prompt: REMIX_DIRECTOR,
      client: ["144", 0],
      // The sampled frames, so the rewrite can see the clip it is editing.
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

  // Five evenly-spaced frames, one per reference slot below. `num_frames` is
  // not a knob: 157-161 index this batch by position, so asking for fewer
  // frames would leave ImageFromBatch reading past the end of it.
  "155": {
    class_type: "VideoFrameSample",
    inputs: {
      num_frames: 5,
      strategy: "uniform",
      seed: 0,
      video: ["154", 0],
    },
    _meta: { title: "Sample Video Frame" },
  },
  "156": {
    class_type: "GetVideoComponents",
    inputs: { video: ["155", 0] },
    _meta: { title: "Get Video Components" },
  },
  "157": {
    class_type: "ImageFromBatch",
    inputs: { batch_index: 0, length: 1, image: ["156", 0] },
    _meta: { title: "Get Image from Batch" },
  },
  "158": {
    class_type: "ImageFromBatch",
    inputs: { batch_index: 1, length: 1, image: ["156", 0] },
    _meta: { title: "Get Image from Batch" },
  },
  "159": {
    class_type: "ImageFromBatch",
    inputs: { batch_index: 2, length: 1, image: ["156", 0] },
    _meta: { title: "Get Image from Batch" },
  },
  "160": {
    class_type: "ImageFromBatch",
    inputs: { batch_index: 3, length: 1, image: ["156", 0] },
    _meta: { title: "Get Image from Batch" },
  },
  "161": {
    class_type: "ImageFromBatch",
    inputs: { batch_index: 4, length: 1, image: ["156", 0] },
    _meta: { title: "Get Image from Batch" },
  },
};

const params: ParamDef[] = [
  {
    id: "reference_video",
    label: "Reference video",
    type: "video",
    default: "",
    required: true,
    // Plumbing, not a control. Remix writes the clip here; the form never
    // shows it, because every other input this graph has is derived from it
    // and offering a picker would imply otherwise.
    hidden: true,
    group: "References",
    targets: [{ node: VIDEO_NODE, input: "file" }],
  },
  {
    id: "ref_image_size",
    label: "Reference handling",
    type: "select",
    default: "match",
    options: [{ value: "match", label: "match" }],
    optionsFrom: { node: REFERENCE_NODE, input: "ref_image_size" },
    help: "How the frames sampled from your clip are fed back in. match is faster; max preserves detail better, up to a 2048px short edge.",
    group: "References",
    advanced: true,
    targets: [{ node: REFERENCE_NODE, input: "ref_image_size" }],
  },

  promptParam(
    ids,
    "Make it snow, and dress the man in a heavy winter coat.",
    "Say only what should change — a remix director turns it into explicit hold-everything-else instructions, so the performance, camera, cuts and dialogue survive.",
    6,
  ),

  durationParam(ids),
  {
    id: "aspect_ratio",
    label: "Aspect ratio",
    type: "select",
    default: "16:9 (Widescreen)",
    options: [{ value: "16:9 (Widescreen)", label: "16:9 (Widescreen)" }],
    optionsFrom: { node: "115", input: "aspect_ratio" },
    help: "Not inherited from the clip — set it to match, or crop deliberately.",
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
    help: "Total pixels per frame. The aspect ratio decides the shape, this decides the scale.",
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
    help: "Rounds width and height to a multiple of this.",
    group: "Output",
    advanced: true,
    targets: [{ node: "115", input: "multiple" }],
  },

  ...samplingParams(ids),
  ...encodingParams(ids),
];

export const minimaxH3ReferenceVideo: WorkflowDef = {
  id: "minimax-h3-ref2v",
  name: "MiniMax H3 · Remix",
  description: "Rebuilds a clip you have already made into a new take.",
  tags: ["video-to-video", "remix", "audio"],
  estimatedSeconds: 180,
  hasAudio: true,
  graph,
  params,
  remixTarget: { videoParam: "reference_video" },
};
