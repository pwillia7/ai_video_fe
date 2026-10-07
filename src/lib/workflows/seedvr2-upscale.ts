import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * SeedVR2 upscale: a finished clip, made larger and sharper, sound untouched.
 *
 * Flattened from Comfy-Org's "SeedVR2 3B Int8: Upscale Video" template — core
 * nodes for the model, VHS for the video either side of it — with changes
 * each of which was measured on the 3090 before it went in:
 *
 * 1. **It runs in batches.** Every node between the loader and the save holds
 *    its whole input as fp32 frames at the output size, and ComfyUI keeps each
 *    one's output until the run ends. At 1080 px a 15-second clip is about 9 GB
 *    per copy, and the colour match alone makes five or six more while it
 *    works, so a whole clip at once ran a 64 GB box out of RAM — at 1080 even
 *    straight after freeing it, 45 minutes in. VHS's Meta Batch Manager (node
 *    0) instead loads BATCH_FRAMES at a time, runs the graph on them, and
 *    appends the result to one file node 14 holds open, re-queueing the graph
 *    itself until the clip runs out. RAM then follows the batch, not the clip.
 *    The app follows the run across those re-queued prompts by the combine
 *    node's filename prefix, which `finalize` makes unique; see meta-batch.ts.
 * 2. **Fixed temporal chunks.** The template's `SeedVR2TemporalChunk` is on
 *    "auto", which sizes chunks to the VRAM that happens to be free. Straight
 *    after an H3 run that is about 9 GB, and auto answered with *one frame per
 *    chunk* — which samples every frame on its own, so nothing holds the
 *    upscale steady from one frame to the next. 21 frames (SeedVR2 wants 4n+1)
 *    is what the template's manual mode defaults to, and fits beside anything.
 * 3. **1024 px VAE tiles**, not 512. The SeedVR2 VAE is the whole cost of this
 *    graph — the sampler is one step and takes seconds; encode and decode take
 *    minutes — and at 512 a 3-second test spent 851 s in it against 399 s at
 *    1024. Larger again, or untiled, measured no faster.
 * 4. **The clip's own frame rate and audio** go back on at the end, so the
 *    result plays exactly as long as the source and keeps its soundtrack. The
 *    loader hands the combine node the whole file's audio on every pass, and
 *    the combine node muxes it once, when the last batch closes the file.
 *
 * 5. **Optional frame interpolation** after the upscale (nodes 15–20): RIFE
 *    puts new frames between the upscaled ones, and the combine writes at the
 *    raised rate. It runs per batch like everything else, which leaves one gap
 *    at each join: a batch's last frame and the next batch's first are never
 *    seen together, so nothing is made between them. Each batch is padded with
 *    copies of its last frame to fill that slot, which keeps the frame count —
 *    and so the sync with the audio — exact, at the cost of one held frame per
 *    join instead of a skipped one. See `finalize` for the switch.
 *
 * The loader is VHS rather than core for the same reason as Extend's: it reads
 * the fragmented MP4 a browser's recorder writes, which the core loader
 * measures as a single frame — and it is the loader the batch manager drives.
 * `force_rate: 0` leaves the rate as it is.
 */

const MANAGER_NODE = "0";
const VIDEO_NODE = "1";
const SIZE_NODE = "3";
const POST_NODE = "13";
const COMBINE_NODE = "14";
const INTERP_MODEL_NODE = "15";
const INTERP_NODE = "16";
const PAD_REPEAT_NODE = "18";
const FPS_NODE = "20";
/** Every node that exists only for frame interpolation. */
const INTERP_NODES = ["15", "16", "17", "18", "19", "20"];
const RATE_PARAM = "frame_rate";

/** The multiplier a submission asked for: 1 when interpolation is off. */
function multiplierOf(values: Record<string, ParamValue>): number {
  const multiplier = Number(values[RATE_PARAM]);
  return Number.isInteger(multiplier) && multiplier >= 1 ? multiplier : 1;
}

/**
 * Frames per batch: about four seconds of a 24 fps clip, so a 15-second H3
 * clip is four passes.
 *
 * 4n+1, which is the length SeedVR2's VAE takes without padding. Larger
 * batches mean fewer joins between independently upscaled stretches; smaller
 * ones mean less RAM per pass. At 1080 px a batch of this size is about 2.5 GB
 * per copy, which leaves room for every copy the graph makes and then some.
 */
const BATCH_FRAMES = 97;

/** Unique per submission, so the run's re-queued passes can be told apart. */
const PREFIX = "video/upscale";

const graph: ComfyGraph = {
  "0": {
    class_type: "VHS_BatchManager",
    inputs: { frames_per_batch: BATCH_FRAMES },
    _meta: { title: "Meta Batch Manager" },
  },
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
      meta_batch: [MANAGER_NODE, 0],
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

  // Frame interpolation, removed by `finalize` when it is off. The loader is
  // core ComfyUI's, which reads RIFE and FILM checkpoints alike.
  "15": {
    class_type: "FrameInterpolationModelLoader",
    inputs: { model_name: "rife_v4.26.safetensors" },
    _meta: { title: "Load Frame Interpolation Model" },
  },
  // N frames in, (N − 1) × multiplier + 1 out: nothing after the last frame.
  "16": {
    class_type: "FrameInterpolate",
    inputs: { interp_model: ["15", 0], images: ["13", 0], multiplier: 2 },
    _meta: { title: "Run Frame Interpolation Model" },
  },
  // The batch's last frame, repeated multiplier − 1 times and appended, so
  // the batch comes out at exactly N × multiplier frames. The slots it fills
  // are the ones the next batch's first frame would have been blended into.
  "17": {
    class_type: "ImageFromBatch",
    inputs: { image: ["13", 0], batch_index: -1, length: 1 },
    _meta: { title: "Last Frame" },
  },
  "18": {
    class_type: "RepeatImageBatch",
    inputs: { image: ["17", 0], amount: 1 },
    _meta: { title: "Repeat Last Frame" },
  },
  "19": {
    class_type: "ImageBatch",
    inputs: { image1: ["16", 0], image2: ["18", 0] },
    _meta: { title: "Pad Batch" },
  },
  // The source's rate times the multiplier, for the combine to write at.
  "20": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "a * b", "values.a": ["2", 0], "values.b": 2 },
    _meta: { title: "Output Frame Rate" },
  },

  // VHS's combine rather than core SaveVideo: it is the one that can hold a
  // file open across the batch manager's passes. H.264 at CRF 17, near enough
  // lossless at these sizes, since this is the copy someone keeps.
  "14": {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: ["19", 0],
      audio: ["1", 2],
      frame_rate: [FPS_NODE, 0],
      loop_count: 0,
      filename_prefix: PREFIX,
      format: "video/h264-mp4",
      pix_fmt: "yuv420p",
      crf: 17,
      save_metadata: false,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
      meta_batch: [MANAGER_NODE, 0],
    },
    _meta: { title: "Video Combine" },
  },
};

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to upscale",
    type: "video",
    default: "",
    required: true,
    help: "Its frame rate and soundtrack carry straight through. Up to 1080×1920 and a minute.",
    group: "Source",
    // Not H3's 768×1344: the source is resized to the output size before the
    // model sees it, so a phone's 1080p clip is fine. Past that it would only
    // be scaled down — and at 4K a batch of frames is ~10 GB of RAM.
    maxShortEdge: 1080,
    maxLongEdge: 1920,
    // Batched, so length costs time, not memory: about 80 seconds of work per
    // second of clip at 800 px. A minute is over an hour.
    maxSeconds: 60,
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
    targets: [{ node: SIZE_NODE, input: "resize_type.shorter_size" }],
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
    // LAB, measured over a whole 15-second clip at 800 px: frame-to-frame
    // colour drift against the source of 0.22 levels on average and 2.4 at
    // worst, against 1.62 and 16 with it off — SeedVR2 on its own lets colour
    // wander from frame to frame, which reads as blips in playback. A single
    // frame side by side shows none of that, which is how Off was briefly the
    // default. Per batch it costs about 20 seconds a clip and no RAM to speak
    // of; on a whole clip at once its copies were what ran the box out.
    default: "lab",
    options: [
      {
        value: "lab",
        label: "LAB",
        help: "Holds every frame's colour to the source's, so it doesn't drift or blip. The default.",
      },
      {
        value: "wavelet",
        label: "Wavelet",
        help: "Matches the broad colour and keeps all the new detail.",
      },
      {
        value: "adain",
        label: "AdaIN",
        help: "One overall tint match per frame — the lightest touch.",
      },
      {
        value: "none",
        label: "Off",
        help: "The model's own colours. They wander a little from frame to frame, which shows as colour blips.",
      },
    ],
    help: "Re-matches the upscale's colours to the source's, frame by frame, after upscaling.",
    group: "Output",
    targets: [{ node: POST_NODE, input: "color_correction_method" }],
  },
  {
    id: RATE_PARAM,
    label: "Frame rate",
    type: "select",
    default: "1",
    options: [
      {
        value: "1",
        label: "Keep the clip's",
        help: "No new frames — 24 fps for an H3 clip.",
      },
      {
        value: "2",
        label: "Double it",
        help: "A new frame between every pair: 48 fps from H3's 24. Smoother motion, and adds a few minutes.",
      },
    ],
    help: "Smooths motion by adding in-between frames after the upscale. The soundtrack is unchanged.",
    group: "Output",
    targets: [
      {
        node: INTERP_NODE,
        input: "multiplier",
        transform: (_value, values) => Math.max(2, multiplierOf(values)),
      },
      {
        node: PAD_REPEAT_NODE,
        input: "amount",
        transform: (_value, values) => Math.max(1, multiplierOf(values) - 1),
      },
      {
        node: FPS_NODE,
        input: "values.b",
        transform: (_value, values) => multiplierOf(values),
      },
    ],
  },
  {
    id: "interpolation_model",
    label: "Interpolation model",
    type: "select",
    default: "rife_v4.26.safetensors",
    options: [
      {
        value: "rife_v4.26.safetensors",
        label: "RIFE 4.26",
        help: "Fast, and the usual choice.",
      },
      {
        value: "film_net_fp16.safetensors",
        label: "FILM",
        help: "Better through big, fast movement, and much slower.",
      },
    ],
    group: "Output",
    advanced: true,
    hiddenBy: { param: RATE_PARAM, is: "1" },
    targets: [{ node: INTERP_MODEL_NODE, input: "model_name" }],
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
  //
  // RAM is what this graph runs short of, and an earlier H3 run leaves about
  // 23 GB of it holding models and cached results: 24.5 GB free on the box
  // before a free, 47.4 GB after. Batching bounds what a pass needs; this
  // gives the pass everything else.
  freesMemory: true,
  clipTarget: {
    action: "upscale",
    accepts: "video",
    sourceParam: "source_video",
    // Every press of Upscale starts at the defaults, as it was asked to.
    fresh: true,
  },
  /**
   * A filename prefix of the run's own. VHS re-queues this graph under new
   * prompt ids, and the prefix is what the status and cancel routes find
   * those passes by — so two upscales queued together must not share one.
   */
  finalize: (graph, values) => {
    graph[COMBINE_NODE].inputs.filename_prefix =
      `${PREFIX}_${crypto.randomUUID().slice(0, 8)}`;

    // Frame interpolation off: the combine takes the upscale straight, at the
    // source's own rate, and the interpolation nodes go — a loader left in
    // would still be validated, and fail on a box without the model file.
    if (multiplierOf(values) === 1) {
      graph[COMBINE_NODE].inputs.images = [POST_NODE, 0];
      graph[COMBINE_NODE].inputs.frame_rate = ["2", 0];
      for (const node of INTERP_NODES) delete graph[node];
    }
  },
  finalizeCases: [
    { name: "frame rate kept", values: { source_video: "clip.mp4" } },
    {
      name: "frame rate doubled",
      values: { source_video: "clip.mp4", [RATE_PARAM]: "2" },
    },
    {
      name: "frame rate doubled with FILM",
      values: {
        source_video: "clip.mp4",
        [RATE_PARAM]: "2",
        interpolation_model: "film_net_fp16.safetensors",
      },
    },
  ],
};
