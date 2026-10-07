import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";

/**
 * SeedVR2 upscale: a finished clip, made larger and sharper, sound untouched.
 *
 * Flattened from Comfy-Org's "SeedVR2 3B Int8: Upscale Video" template — core
 * nodes only, no custom pack for the model — with three changes, each of which
 * was measured on the 3090 before it went in:
 *
 * 1. **Fixed temporal chunks.** The template's `SeedVR2TemporalChunk` is on
 *    "auto", which sizes chunks to the VRAM that happens to be free. Straight
 *    after an H3 run that is about 9 GB, and auto answered with *one frame per
 *    chunk* — which samples every frame on its own, so nothing holds the
 *    upscale steady from one frame to the next. 21 frames (SeedVR2 wants 4n+1)
 *    is what the template's manual mode defaults to, and fits beside anything.
 * 2. **1024 px VAE tiles**, not 512. The SeedVR2 VAE is the whole cost of this
 *    graph — the sampler is one step and takes seconds; encode and decode take
 *    minutes — and at 512 a 3-second test spent 851 s in it against 399 s at
 *    1024. Larger again, or untiled, measured no faster.
 * 3. **The clip's own frame rate and audio** go back on at the end, so the
 *    result plays exactly as long as the source and keeps its soundtrack.
 *
 * The loader is VHS rather than core for the same reason as Extend's: it reads
 * the fragmented MP4 a browser's recorder writes, which the core loader
 * measures as a single frame. `force_rate: 0` leaves the rate as it is.
 *
 * Decode time grows faster than the clip does (Comfy-Org/ComfyUI#15782), so a
 * long source costs disproportionately more. Nothing here splits it up; the
 * app's own clips stop at 20 seconds.
 */

const VIDEO_NODE = "1";

const graph: ComfyGraph = {
  "1": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: 0,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },
  "2": {
    class_type: "VHS_VideoInfoLoaded",
    inputs: { video_info: ["1", 3] },
    _meta: { title: "Video Info (Loaded)" },
  },

  // The size is set here, in pixels, before the model sees anything: SeedVR2
  // restores detail at whatever size it is given rather than choosing one. The
  // same resized frames are the reference the colour correction matches.
  "3": {
    class_type: "ResizeImageMaskNode",
    inputs: {
      input: ["1", 0],
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 800,
      scale_method: "lanczos",
    },
    _meta: { title: "Resize Image/Mask" },
  },
  "4": {
    class_type: "SeedVR2Preprocess",
    inputs: { resized_images: ["3", 0] },
    _meta: { title: "SeedVR2 Preprocess" },
  },

  "5": {
    class_type: "VAELoader",
    inputs: { vae_name: "seedvr2_ema_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "seedvr2_7b_sharp_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },

  "7": {
    class_type: "VAEEncodeTiled",
    inputs: {
      pixels: ["4", 0],
      vae: ["5", 0],
      tile_size: 1024,
      overlap: 128,
      temporal_size: 64,
      temporal_overlap: 8,
    },
    _meta: { title: "VAE Encode (Tiled)" },
  },
  "8": {
    class_type: "SeedVR2TemporalChunk",
    inputs: {
      latent: ["7", 0],
      temporal_overlap: 1,
      chunking_mode: "manual",
      "chunking_mode.frames_per_chunk": 21,
    },
    _meta: { title: "Split SeedVR2 Latent" },
  },
  "9": {
    class_type: "SeedVR2Conditioning",
    inputs: { model: ["6", 0], vae_conditioning: ["8", 0] },
    _meta: { title: "Apply SeedVR2 Conditioning" },
  },
  // One step at full denoise is the model's design, not a speed setting.
  "10": {
    class_type: "KSampler",
    inputs: {
      model: ["6", 0],
      positive: ["9", 0],
      negative: ["9", 1],
      latent_image: ["8", 0],
      seed: 0,
      steps: 1,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    },
    _meta: { title: "KSampler" },
  },
  "11": {
    class_type: "SeedVR2TemporalMerge",
    inputs: { latents: ["10", 0], temporal_overlap: ["8", 1] },
    _meta: { title: "Merge SeedVR2 Latents" },
  },
  "12": {
    class_type: "VAEDecodeTiled",
    inputs: {
      samples: ["11", 0],
      vae: ["5", 0],
      tile_size: 1024,
      overlap: 128,
      temporal_size: 64,
      temporal_overlap: 8,
    },
    _meta: { title: "VAE Decode (Tiled)" },
  },
  "13": {
    class_type: "SeedVR2PostProcessing",
    inputs: {
      images: ["12", 0],
      original_resized_images: ["3", 0],
      color_correction_method: "lab",
    },
    _meta: { title: "Post-Process SeedVR2 Output" },
  },

  "14": {
    class_type: "CreateVideo",
    inputs: {
      images: ["13", 0],
      audio: ["1", 2],
      fps: ["2", 0],
      bit_depth: 8,
    },
    _meta: { title: "Create Video" },
  },
  "15": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/upscale",
      format: "auto",
      codec: "auto",
      video: ["14", 0],
    },
    _meta: { title: "Save Video" },
  },
};

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to upscale",
    type: "video",
    default: "",
    required: true,
    help: "Its frame rate and soundtrack carry straight through.",
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "video" }],
  },
  {
    id: "shorter_side",
    label: "Output size",
    type: "slider",
    default: 800,
    min: 720,
    max: 1080,
    step: 8,
    unit: "px",
    // The shorter side, so one number means the same thing in any aspect.
    help: "Height of a landscape clip, width of a portrait one. Time grows with the pixels: 1080 has 1.8× as many as 800.",
    group: "Output",
    targets: [{ node: "3", input: "resize_type.shorter_size" }],
  },
  {
    id: "upscale_model",
    label: "Model",
    type: "select",
    default: "seedvr2_7b_sharp_int8_convrot.safetensors",
    options: [
      {
        value: "seedvr2_7b_sharp_int8_convrot.safetensors",
        label: "7B sharp",
        help: "The more natural of the two: finer text, no halos.",
      },
      {
        value: "seedvr2_3b_int8_convrot.safetensors",
        label: "3B",
        help: "Less VRAM. Crisper, but harsher contrast and halos around edges.",
      },
    ],
    group: "Output",
    targets: [{ node: "6", input: "unet_name" }],
  },
  {
    id: "color_correction",
    label: "Colour match",
    type: "select",
    default: "lab",
    options: [
      { value: "lab", label: "LAB", help: "Most faithful to the source." },
      {
        value: "wavelet",
        label: "Wavelet",
        help: "Matches broad colour, keeps all the new detail.",
      },
      { value: "adain", label: "AdaIN", help: "A global tint match." },
      { value: "none", label: "None", help: "Whatever the model returns." },
    ],
    help: "How the upscale's colours are pulled back to the source's.",
    group: "Output",
    advanced: true,
    targets: [{ node: "13", input: "color_correction_method" }],
  },
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    help: "One step from the clip itself, so this changes very little.",
    group: "Output",
    advanced: true,
    targets: [{ node: "10", input: "seed" }],
  },
];

export const seedvr2Upscale: WorkflowDef = {
  id: "seedvr2-upscale",
  name: "Upscale",
  description: "Makes a finished clip larger and sharper, keeping its sound.",
  // A 15-second H3 clip at 800 px on the 3090, 7B sharp: 1258 s. The client
  // replaces it with this machine's median once a run has finished.
  estimatedSeconds: 1260,
  hasAudio: true,
  graph,
  params,
  // No turbo, patches or director: there is no prompt and no H3 anywhere in
  // this graph, and the sampler is already a single step.
  clipTarget: {
    action: "upscale",
    accepts: "video",
    sourceParam: "source_video",
  },
};
