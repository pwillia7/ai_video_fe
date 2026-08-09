import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
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
 * MiniMax H3 reference-to-video, driven by a clip.
 *
 * The same reference node as minimax-h3-ref, with a video wired into it: node
 * 154 loads the clip, 153 splits it into frames and audio, and both halves go
 * to the reference node as `ref_videos.ref_video_0` and `ref_audios.ref_audio_0`.
 * Reference images still work and are additive, so this graph carries them too
 * — optional here, where they are the whole point of the image-only workflow.
 *
 * This is where the Remix button sends a finished generation (`remixTarget`
 * below). ComfyUI keeps produced files in its output directory and only reads
 * loaders from its input directory, so /api/remix copies the clip across
 * first; by the time the value reaches node 154 it is an ordinary input
 * filename, indistinguishable from an upload.
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
const BATCH_NODE = "146";
const REWRITE_NODE = "145";
const VIDEO_NODE = "154";

/**
 * The two reference-image slots, in the order the model numbers them. Both the
 * reference node and the batch that shows the images to the rewrite stage read
 * from the same LoadImage, so dropping a slot means clearing it in both places
 * before the loader itself can go.
 */
const IMAGE_SLOTS = [
  {
    param: "reference_image_1",
    node: "137",
    referenceInput: "ref_images.ref_image_0",
    batchInput: "images.image0",
  },
  {
    param: "reference_image_2",
    node: "139",
    referenceInput: "ref_images.ref_image_1",
    batchInput: "images.image1",
  },
] as const;

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
      height: ["115", 1],
      length: ["131", 1],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["137", 0],
      "ref_images.ref_image_1": ["139", 0],
      "ref_videos.ref_video_0": ["153", 0],
      "ref_audios.ref_audio_0": ["153", 1],
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

  // The prompt-rewrite stage, as in the other MiniMax graphs: 138 holds what
  // the user typed and 145 expands it into what node 136 actually reads. 146
  // shows it any reference images; it cannot see the clip, so the prompt is
  // the only place the video's contents can be described.
  //
  // The system prompt is the one thing here that differs from the other
  // graphs. REMIX_DIRECTOR treats what the user typed as a change to an
  // existing video rather than a scene to invent, which is the whole point of
  // this workflow — and it knows the rewrite is blind to the clip, so it
  // writes preservation instructions against <Video 1> and <Audio 1> instead
  // of describing contents it cannot see.
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
};

const params: ParamDef[] = [
  {
    id: "reference_video",
    label: "Reference video",
    type: "video",
    default: "",
    required: true,
    help: "The clip the new video is built from — its motion, framing and audio. Remix on a finished generation fills this in for you.",
    group: "References",
    targets: [{ node: VIDEO_NODE, input: "file" }],
  },
  {
    id: "reference_image_1",
    label: "Reference image",
    type: "image",
    default: "",
    help: "Optional. A subject to carry into the scene, as <Picture 1>.",
    group: "References",
    targets: [{ node: IMAGE_SLOTS[0].node, input: "image" }],
  },
  {
    id: "reference_image_2",
    label: "Second reference",
    type: "image",
    default: "",
    help: "Optional. Becomes <Picture 2> in the prompt.",
    group: "References",
    targets: [{ node: IMAGE_SLOTS[1].node, input: "image" }],
  },
  {
    id: "ref_image_size",
    label: "Reference handling",
    type: "select",
    default: "match",
    options: [{ value: "match", label: "match" }],
    optionsFrom: { node: REFERENCE_NODE, input: "ref_image_size" },
    help: "match is faster; max preserves identity better, up to a 2048px short edge.",
    group: "References",
    advanced: true,
    targets: [{ node: REFERENCE_NODE, input: "ref_image_size" }],
  },

  promptParam(
    ids,
    "Make it snow, and dress the man in a heavy winter coat.",
    "Say only what should change — a remix director turns it into explicit hold-everything-else instructions, so the performance, camera, cuts and dialogue survive. Reference images still need naming by tag in upload order (<Picture 1>, <Picture 2>).",
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
  name: "MiniMax H3 · Video to Video",
  description: "Rebuilds a clip you already have into a new take.",
  tags: ["video-to-video", "remix", "audio"],
  estimatedSeconds: 180,
  hasAudio: true,
  graph,
  params,
  remixTarget: { videoParam: "reference_video" },

  /**
   * Prune the reference-image slots that went unused.
   *
   * A blank slot is not the same as an absent one: leaving a LoadImage with an
   * empty filename fails validation, and leaving the link in place would tell
   * the model to expect a subject that is not there. Both consumers have to be
   * cleared before the loader goes, or the queued graph would point at a node
   * that no longer exists — which ComfyUI rejects outright.
   *
   * The used images are compacted into the low slots rather than left where
   * they were declared, so that supplying only the second one still yields a
   * <Picture 1>. Otherwise the prompt's tags would silently be off by one.
   */
  finalize(graph, values) {
    const supplied = IMAGE_SLOTS.map((slot) => values[slot.param])
      .map((value: ParamValue | undefined) =>
        typeof value === "string" ? value.trim() : "",
      )
      .filter(Boolean);

    IMAGE_SLOTS.forEach((slot, index) => {
      const image = supplied[index];
      if (image) {
        graph[slot.node].inputs.image = image;
        return;
      }
      delete graph[REFERENCE_NODE].inputs[slot.referenceInput];
      delete graph[BATCH_NODE].inputs[slot.batchInput];
      delete graph[slot.node];
    });

    // With no images at all there is nothing to batch. The rewrite stage's
    // `images` input is optional — the text-to-video graph omits it entirely —
    // so it goes too rather than pointing at a node that has been removed.
    if (supplied.length === 0) {
      delete graph[BATCH_NODE];
      delete graph[REWRITE_NODE].inputs.images;
    }
  },
};
