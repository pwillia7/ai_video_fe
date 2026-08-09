import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  encodingParams,
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
 * - 163 measures the clip's own frames and supplies all three dimensions of
 *   the output: width, height, and length as a frame count. So a remix comes
 *   back the same shape and the same length as what went in, and there is
 *   neither a ResolutionSelector nor a duration node in this graph.
 * - 156 also feeds the rewrite stage, so the director sees what the clip looks
 *   like rather than working blind from the filename.
 *
 * So the clip is the one input the form offers. The reference images, the
 * reference audio and the output size are consequences of it rather than
 * choices, and controls for them would misrepresent what this graph does. It
 * can be filled either by the Remix button (`remixTarget` below) or by an
 * upload — see video-upload.tsx for the limits that keeps within, which matter
 * more here than elsewhere because the clip decides what gets generated.
 */
const ids: Omit<MinimaxNodeIds, "duration" | "frameExpression"> = {
  prompt: { node: "138", input: "value" },
  video: "130",
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
    inputs: { noise_seed: 432597392404604 },
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
      seed: 222561866641859,
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

  // Reads the clip's full frame sequence, not the five-frame sample: the count
  // has to be the length of the source, not the size of the reference set.
  "163": {
    class_type: "GetImageSizeAndCount",
    inputs: { image: ["153", 0] },
    _meta: { title: "Get Image Size & Count" },
  },
};

const params: ParamDef[] = [
  {
    id: "reference_video",
    label: "Clip to remix",
    type: "video",
    default: "",
    required: true,
    help: "Remix on a finished generation fills this in, or drop in a clip of your own. Its size and length become the output's, so the control holds it to what the model can render.",
    group: "Source",
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
    group: "Source",
    advanced: true,
    targets: [{ node: REFERENCE_NODE, input: "ref_image_size" }],
  },

  promptParam(
    ids,
    "Make it snow, and dress the man in a heavy winter coat.",
    "Say only what should change — a remix director turns it into explicit hold-everything-else instructions, so the performance, camera, cuts and dialogue survive.",
    6,
  ),

  /**
   * The only output control left, and it means something different here than
   * on the other graphs.
   *
   * Elsewhere fps is paired with a duration: the frame count is rebuilt from
   * both, so the clip stays the length you asked for. Here the frame count is
   * the source's, fixed, so fps divides into it — the same frames played
   * faster or slower. It is a speed control, and the help says so.
   *
   * Left adjustable rather than pinned to the source's own rate because Remix
   * carries fps over from the generation being remixed, so it already matches
   * unless someone changes it on purpose.
   */
  {
    id: "fps",
    label: "Frame rate",
    type: "number",
    default: 24,
    min: 8,
    max: 60,
    step: 1,
    unit: "fps",
    help: "The remix has as many frames as the clip it came from, so this sets how fast they play — and with it the length. Match the source to keep the timing.",
    group: "Output",
    targets: [{ node: ids.video, input: "fps" }],
  },

  // Half what the generating graphs use: a remix is holding to a source rather
  // than inventing from noise, so it converges in fewer steps. This is the
  // number that ships; node 124's literal is whatever the export happened to
  // carry and never reaches ComfyUI.
  ...samplingParams(ids, { steps: 10 }),
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
