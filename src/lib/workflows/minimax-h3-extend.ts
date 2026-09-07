import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
import {
  MAX_CHUNKS,
  MAX_CHUNK_SECONDS,
  CHUNK_FPS,
  chunkPlan,
  directorBypassFor,
  effectiveSeconds,
  directorTarget,
  FRAME_EXPRESSION,
  durationParam,
  EXTEND_DIRECTOR,
  h3Patches,
  h3ContentLora,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 extend: keep a clip running past where it stopped.
 *
 * Structurally this is the image-to-video graph with the clip's own last frame
 * standing in for an upload, plus a join on the way out. Three parts:
 *
 * 1. **The seam.** 126 loads the clip at 24 fps — frames on output 0, sound on
 *    output 2 — and 128 takes the last frame of that sequence
 *    (`start_index: -1`). That single
 *    frame is the whole bridge: 105:104 receives it as `first_frame`, 120
 *    measures it for the output size, and 123 shows it to the prompt director.
 *    So the new segment starts on the exact image the source ended on, at the
 *    source's own dimensions — nothing else could line the two up.
 * 2. **The generation.** The 105:* nodes are the same sampler stack as the
 *    other generating graphs, and the same duration → frame-count expression.
 *    That duration times the *new segment only*, which is the one thing about
 *    this workflow that reliably surprises people: ask for 10 seconds on a
 *    12-second clip and 22 seconds come back.
 * 3. **The join.** 131 concatenates the source frames with the generated ones
 *    and 135 does the same to the two audio tracks, so 137/138 save the whole
 *    video rather than the addition on its own. That is what makes extending an
 *    extension work: the output is always a complete clip, so it can go
 *    straight back in through the Extend button.
 *
 * Which also means the file grows with each pass, and so does the time spent
 * decoding and re-encoding it — the sampling cost stays flat, since only the
 * new segment is ever generated.
 *
 * ## Past fifteen seconds of added time
 *
 * The model generates at most 362 frames in a pass, so a longer addition is
 * generated in several and chained. This is the *chain* rather than the slice:
 * the other two graphs that chunk cut a source that already exists and give
 * each pass its own span, and there is nothing to cut here — the whole point is
 * footage that does not exist yet. So pass 2 starts from the last frame pass 1
 * produced, exactly as pass 1 starts from the last frame of the clip, and the
 * seam between two passes is the same kind this graph was built to survive.
 *
 * **The sound is the honest weakness.** Remix and Reference to Video can throw
 * away what the model invented and put a continuous source track over the top;
 * there is no such track here past the source's own, which covers only the part
 * that already existed. Every new segment writes its own score, so a four-pass
 * extension has four unrelated ones after the first join. That is the trade
 * this graph makes to generate at all rather than rebuild, and there is no
 * arrangement of these nodes that avoids it.
 */
const ids: MinimaxNodeIds = {
  // Node 125, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "125", input: "value" },
  director: "123",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

const VIDEO_NODE = "126";
const FIRST_FRAME_NODE = "128";
const I2V_NODE = "105:104";
const SAMPLER_NODE = "105:14";
const GUIDER_NODE = "105:16";
const DECODE_NODE = "105:10";
const DECODE_AUDIO_NODE = "105:23";
const FRAMES_NODE = "105:107";
const DURATION_NODE = "105:111";
/** The pass repackaged as a video, and split back into frames and sound. */
const SEGMENT_NODE = "105:91";
const SPLIT_NODE = "132";
/** Where the source and every pass are put back together. */
const BATCH_NODE = "131";
const AUDIO_JOIN_NODE = "135";
const VIDEO_OUT_NODE = "137";

/**
 * The rate the source is read at, and the rate the join is written at.
 *
 * One constant because the two must agree: this graph concatenates the source's
 * own frames with the generated ones and writes the result as a single video,
 * so a source read at another rate plays its half at the wrong speed inside the
 * finished file.
 */
const SOURCE_FPS = 24;

/**
 * The nodes each pass past the first needs its own copy of.
 *
 * Chunking here is a *chain*, not a slice, which is the one place this differs
 * from the other two graphs that do it. Remix and Reference to Video cut a
 * source that already exists into spans and hand each pass its own; there is no
 * such source here — the whole point is footage that does not exist yet. So
 * pass 2 is conditioned on the last frame pass 1 produced, exactly as pass 1 is
 * conditioned on the last frame of the clip. The seam between two passes is the
 * same kind of seam this graph already puts between the source and its
 * extension, which is the one it was built to survive.
 *
 * Sampling cost stays flat per pass: only the new segment is ever generated,
 * and the source is concatenated on at the end however many passes there were.
 */
const CHUNK_NODES = [
  FIRST_FRAME_NODE,
  I2V_NODE,
  SAMPLER_NODE,
  GUIDER_NODE,
  DECODE_NODE,
  DECODE_AUDIO_NODE,
  FRAMES_NODE,
  DURATION_NODE,
  SEGMENT_NODE,
  SPLIT_NODE,
  AUDIO_JOIN_NODE,
];

/** Ids for pass i. Pass 0 keeps the ids the exported graph already used. */
const chunkId = (base: string, index: number) =>
  index === 0 ? base : `${base}k${index}`;

/**
 * One pass's stack, cloned from the ids the export already used.
 *
 * Read from the stored nodes rather than written out again, so the copy cannot
 * drift from the wiring `check:workflows` validates. Links pointing inside the
 * stack are renamed; everything else — the model, the seed, the prompt, the
 * frame size — keeps pointing at the single shared copy.
 *
 * Two links are then rewired by the caller, and they are the chain itself: what
 * this pass starts from, and what its sound is appended to.
 */
function chunkNodes(base: ComfyGraph, index: number): ComfyGraph {
  const owned = new Set(CHUNK_NODES);
  const out: ComfyGraph = {};
  for (const id of CHUNK_NODES) {
    const node = base[id];
    const inputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      inputs[name] =
        Array.isArray(value) && typeof value[0] === "string" && owned.has(value[0])
          ? [chunkId(value[0], index), value[1]]
          : value;
    }
    out[chunkId(id, index)] = {
      class_type: node.class_type,
      inputs: inputs as ComfyGraph[string]["inputs"],
      _meta: { title: `${node._meta?.title ?? node.class_type} (pass ${index + 1})` },
    };
  }
  // The chain. This pass carries on from the last frame the one before it
  // produced, and its sound goes on the end of what has accumulated so far.
  out[chunkId(FIRST_FRAME_NODE, index)].inputs.input = [
    chunkId(SPLIT_NODE, index - 1),
    0,
  ];
  out[chunkId(AUDIO_JOIN_NODE, index)].inputs.audio1 = [
    chunkId(AUDIO_JOIN_NODE, index - 1),
    0,
  ];
  return out;
}

const baseGraph: ComfyGraph = {
  // The clip, read at 24 fps.
  //
  // VHS's loader, forcing the rate, because this graph *joins* the source to
  // what it generates: 131 batches the source's frames ahead of the new ones
  // and 137 writes the pair out at 24 fps. A source at any other rate has its
  // own half of the finished video replayed at the wrong speed — a 30 fps clip
  // plays a quarter slow before the extension starts, inside one file, which
  // is worse than being uniformly wrong. Nothing noticed because the usual
  // source is a generation from this app, already at 24.
  //
  // It also reads the fragmented MP4 a browser's MediaRecorder writes, which
  // ComfyUI's own loader measures as a single frame. See minimax-h3-ref.ts.
  //
  // No `frame_load_cap`: an extension carries the whole source through to the
  // output. Outputs are 0 frames, 1 frame count, 2 audio.
  "126": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: SOURCE_FPS,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },

  // The last frame of the clip, and the only frame anything downstream sees.
  //
  // `start_index: -1` with `num_frames: 1` is what picks it; the randomness and
  // distance widgets are carried from the export and do nothing at that index.
  "128": {
    class_type: "RandomImageFromBatch",
    inputs: {
      start_index: -1,
      end_index: -1,
      num_frames: 1,
      randomness: 0,
      min_distance: 0,
      max_distance: 0,
      seed: 0,
      input: ["126", 0],
    },
    _meta: { title: "Random Image From Batch" },
  },
  // Reading the frame rather than the clip: same numbers either way, and this
  // is the image the continuation is actually generated against.
  "120": {
    class_type: "GetImageSize",
    inputs: { image: ["128", 0] },
    _meta: { title: "Get Image Size" },
  },

  // The prompt-rewrite stage: 125 holds what the user typed and 123 turns it
  // into what node 105:104 reads, with the last frame in view.
  //
  // EXTEND_DIRECTOR is what makes this a continuation rather than a new scene
  // sharing an opening image — it reads the input as what happens next and
  // spends most of its instructions on not resetting at the seam. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the
  // ComfyUI host.
  //
  // The `system_prompt` is overwritten per run by the duration param, which
  // appends the length of the segment being generated — not of the video that
  // comes out, since the source is concatenated on afterwards and never
  // reaches the model.
  "123": rewriteNode({
    prompt: ["125", 0],
    system: EXTEND_DIRECTOR,
    images: ["128", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),
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
    inputs: { noise_seed: 689734481905865 },
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
      first_frame: ["128", 0],
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

  // The join. 132 splits the generated segment back into frames and audio so
  // both can be appended to the source's own — pictures in 131, sound in 135 —
  // and 137 re-encodes the pair as one video at the same 24fps.
  "132": {
    class_type: "GetVideoComponents",
    inputs: { video: ["105:91", 0] },
    _meta: { title: "Get Video Components" },
  },
  "131": {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["126", 0],
      "images.image1": ["132", 0],
    },
    _meta: { title: "Batch Images" },
  },
  "135": {
    class_type: "AudioConcatenate",
    inputs: {
      direction: "right",
      audio1: ["126", 2],
      audio2: ["132", 1],
    },
    _meta: { title: "AudioConcatenate" },
  },
  "137": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["131", 0],
      audio: ["135", 0],
    },
    _meta: { title: "Create Video" },
  },
  "138": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/minimax_extend",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["137", 0],
    },
    _meta: { title: "Save Video" },
  },
};

/**
 * The stored graph plus every pass past the first, and the slots that join them
 * on to the source.
 *
 * All MAX_CHUNKS declared rather than cloned at run time: `finalize` deletes
 * what a submission does not reach, and a graph that stands still is one
 * `check:workflows` can validate.
 */
const graph: ComfyGraph = {
  ...baseGraph,
  ...Object.assign(
    {},
    ...Array.from({ length: MAX_CHUNKS - 1 }, (_, i) => chunkNodes(baseGraph, i + 1)),
  ),
  // The source first, then every pass in order. Slot 0 is the clip itself and
  // slot 1 is what the stored graph already wired; the rest are the passes that
  // only exist past fifteen seconds of added time.
  [BATCH_NODE]: {
    ...baseGraph[BATCH_NODE],
    inputs: {
      ...baseGraph[BATCH_NODE].inputs,
      ...Object.fromEntries(
        Array.from({ length: MAX_CHUNKS - 1 }, (_, i) => [
          `images.image${i + 2}`,
          [chunkId(SPLIT_NODE, i + 1), 0],
        ]),
      ),
    },
  },
};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
const director = directorTarget(ids, EXTEND_DIRECTOR);

/**
 * How the added time is divided into passes.
 *
 * Off the duration control, which on this graph times the *addition* rather
 * than the finished video — the source is concatenated on afterwards and never
 * goes near the model, so it costs nothing and counts for nothing here.
 */
const addedPlan = (values: Record<string, ParamValue>) =>
  chunkPlan(effectiveSeconds(Number(values.duration ?? 5)));

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to continue",
    type: "video",
    default: "",
    required: true,
    help: "Its last frame is where the new footage starts, and sets the size. Up to 768×1344, 20s, 4 MB.",
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "video" }],
  },

  promptParam(
    ids,
    "He turns to her and says we need to leave.",
    "Say what happens next, not what the clip already showed. It can see the last frame.",
    6,
  ),
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // Times the addition, not the result — the source's own length is whatever it
  // already was, and the two are concatenated afterwards. Worth saying on the
  // control itself, because every other workflow's duration is the duration of
  // the file that comes back.
  durationParam(ids, director, {
    label: "Added time",
    max: MAX_CHUNK_SECONDS,
    help: "How much new footage to generate. The result is the source clip plus this. Past about 15s it is generated in passes, each carrying on from the last — every pass costs its own render, and each writes its own soundtrack.",
    default: 5,
  }),

  ...samplingParams(ids),
];

export const minimaxH3Extend: WorkflowDef = {
  id: "minimax-h3-extend",
  name: "Extend",
  description: "Carries on from where a clip you already have left off.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  turbo: h3Turbo(220),
  // The content LoRA first, matching the order they stack in: it is a LoRA on
  // the model, and the other two wrap whatever weights are in play by then.
  // Only the fl2va graphs offer it — see h3ContentLora, and the ref2va bases
  // its LoRAs are not made for.
  patches: [h3ContentLora(), ...h3Patches()],
  stepSampler: h3StepSampler(),
  /**
   * No `carry`, unlike Remix. The prompt that made the source describes the
   * source, and this graph reads what you type as what happens *next* — so
   * carrying it across would ask the director to continue the clip by doing
   * again what it just did.
   */
  clipTarget: { action: "extend", accepts: "video", sourceParam: "source_video" },

  /**
   * One per pass. Four passes is four renders, so it is both the estimate's
   * multiplier and the bucket the learned median groups by.
   */
  passes: (values) => addedPlan(values).count,

  /**
   * Cut the chain down to the passes this run needs.
   *
   * Up to fifteen seconds of added time this queues exactly the graph the
   * workflow always queued: one segment, joined to the source. Everything here
   * is what happens past that.
   */
  finalize(graph, values) {
    const { count: chunks, frames } = addedPlan(values);

    for (let index = chunks; index < MAX_CHUNKS; index += 1) {
      for (const base of CHUNK_NODES) delete graph[chunkId(base, index)];
      delete graph[BATCH_NODE].inputs[`images.image${index + 1}`];
    }

    // Each pass generates its own share of the added time rather than all of
    // it. The param writes the whole request into pass 0's float, which is
    // right for one pass and four times too long for four.
    if (chunks > 1) {
      const share = frames / CHUNK_FPS;
      for (let index = 0; index < chunks; index += 1) {
        graph[chunkId(DURATION_NODE, index)].inputs.value = share;
      }
    }

    // The sound is whatever the chain accumulated: the source's own track with
    // every pass appended in order. Nothing here is continuous the way Remix's
    // audio is — each pass invents its score from nothing, so the joins are
    // audible. There is no source to fall back on, which is exactly why this
    // graph gets the chain and not the mux.
    graph[VIDEO_OUT_NODE].inputs.audio = [chunkId(AUDIO_JOIN_NODE, chunks - 1), 0];
  },

  /**
   * Every pass count, because each one is a different chain. The last two hold
   * the bypass sweep and the pruning to the same account of what is reachable.
   */
  finalizeCases: [
    { name: "one pass", values: { source_video: "clip.mp4", duration: 5 } },
    { name: "one pass at the ceiling", values: { source_video: "clip.mp4", duration: 15 } },
    { name: "two passes", values: { source_video: "clip.mp4", duration: 20 } },
    { name: "three passes", values: { source_video: "clip.mp4", duration: 40 } },
    { name: "four passes", values: { source_video: "clip.mp4", duration: 58 } },
    {
      name: "one pass with the rewrite off",
      values: { source_video: "clip.mp4", duration: 5, literal_prompt: true },
    },
    {
      name: "four passes with the rewrite off",
      values: { source_video: "clip.mp4", duration: 58, literal_prompt: true },
    },
  ],
};
