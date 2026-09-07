import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
import {
  CLIP_WORDS,
  directorBypassFor,
  directorTarget,
  audioKeep,
  audioKeepHidesWords,
  audioKeepParam,
  audioKeepReusesWords,
  clipDurationParam,
  h3Bf16Models,
  h3ContentLora,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  promptTarget,
  REMIX_DIRECTOR,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 remix: rebuild a clip you already have.
 *
 * The clip goes in at node 154 and everything else follows from it:
 *
 * - 154 is VHS's loader, reading the clip at 24 fps. Its frames and its
 *   soundtrack go to the reference node as `ref_videos.ref_video_0` and
 *   `ref_video_audios.ref_video_audio_0` — the soundtrack slot that pairs by
 *   index with the video, not the standalone one. That pair is the only visual
 *   input the sampler gets.
 * - 155 takes every nth frame for the prompt director alone, at a stride 157
 *   works out from the frame count the loader reports — so the rewrite can see
 *   the clip it is editing rather than working blind from the filename. Nothing
 *   from that sample reaches the sampler; an earlier version wired it into
 *   `ref_images.*` as well, which is kept under archive/ for comparison.
 * - 163 measures the clip's own frames and supplies all three dimensions of
 *   the output: width, height, and length as a frame count. So a remix comes
 *   back the same shape and the same length as what went in, and there is
 *   neither a ResolutionSelector nor a duration node in this graph. That is
 *   also why the loader forces a frame rate: a count taken at one rate and
 *   written out at another is a remix that comes back the wrong length.
 *
 * So the clip is the one input the form offers, with one exception: **Words in
 * the clip**. That is not a second input to the graph — it writes no node the
 * clip does not already fill — but the clip's audio is a recording H3 is asked
 * to work over, and nothing on this side can hear it. Typing the words out is
 * the only way they reach either the director or the model. Same control, same
 * two blocks and the same reasoning as Reference to Video's attached track;
 * see `wordsBlocks`.
 *
 * Otherwise the reference audio and the output size are consequences of the clip
 * rather than choices, and controls for them would misrepresent what this graph
 * does. It can be filled either by the
 * Remix button (`clipTarget` below) or by an upload — see video-upload.tsx
 * for the limits that keeps within, which matter more here than elsewhere
 * because the clip decides what gets generated.
 *
 * ## Past fifteen seconds
 *
 * The model takes at most 362 frames in one pass, so a longer clip is cut into
 * pieces, each rebuilt as its own video, and the pieces put back together. The
 * arithmetic is `chunkPlan`; the stacks it prunes are `chunkNodes`; the
 * reassembly is nodes 170 to 173.
 *
 * **The soundtrack is what makes this work rather than merely run.** H3 writes
 * picture and audio together, so four passes invent four unrelated
 * soundtracks — a score that restarts every fifteen seconds is a seam no amount
 * of care at the cut can hide, and it is audible in a way the picture's seam is
 * not. So the generated audio is thrown away and the source's own is muxed over
 * the result: each chunk loader already carries exactly its own span of it,
 * because VHS cuts the audio to the same window it cuts the frames to, and
 * concatenating those spans in order rebuilds the original track with neither
 * gap nor repeat. A track that was continuous before anything was generated
 * stays continuous.
 *
 * Which is also why chunking lives here and not on the graphs that invent a
 * video from nothing: a remix has a real soundtrack to fall back on and they do
 * not. The picture's seams remain, and are the accepted cost.
 */
const ids: Omit<MinimaxNodeIds, "duration"> = {
  prompt: { node: "138", input: "value" },
  director: "145",
  noise: "129",
  scheduler: "124",
};

const VIDEO_NODE = "154";

/**
 * The rate the clip is read at, and the rate the result is written at.
 *
 * One constant because the two must agree: this graph takes the output's frame
 * count from the source, so a source read at any other rate comes back the
 * wrong length. 24 is what `CreateVideo` writes and what H3 reads a reference
 * video at.
 */
const SOURCE_FPS = 24;

/** Roughly how many frames the director is shown. See node 157. */
const DIRECTOR_FRAMES = 5;

/**
 * The longest single pass the model was trained for, in frames at SOURCE_FPS.
 *
 * The node states it: "trained range is ~124-362". 362 frames is 15.08 seconds
 * and sits on the 17k+5 grid the sampler snaps to, so it is both the ceiling
 * and a clean number to cut at.
 */
const CHUNK_FRAMES = 362;

/**
 * How many of those a run may string together.
 *
 * Four is a minute, which is past what the 4 MB upload ceiling can carry at any
 * watchable bitrate — so in practice this bites on clips arriving through the
 * Remix button, where a previous generation is copied server-side and has no
 * size limit. Each chunk is a full sampling pass, so the cost is linear: about
 * five minutes a chunk in turbo.
 */
const MAX_CHUNKS = 4;

/**
 * The longest clip this graph will take, in seconds: every chunk full.
 *
 * Derived rather than typed, so raising MAX_CHUNKS raises the control with it
 * instead of leaving a form that refuses clips the graph could now rebuild.
 */
const MAX_SECONDS = Math.floor((MAX_CHUNKS * CHUNK_FRAMES) / SOURCE_FPS);

/** Ids for chunk i. Chunk 0 keeps the ids the exported graph already used. */
const chunkId = (base: string, index: number) =>
  index === 0 ? base : `${base}c${index}`;

const LOADER = "154";
const SIZE = "163";
const REFERENCE = "136";
const GUIDER = "126";
const SAMPLER = "125";
const DECODE = "122";
/** Where the pieces are put back together. */
const BATCH_NODE = "170";
const audioJoinId = (index: number) => `17${index}`;

/**
 * One chunk's worth of graph: load a slice, condition on it, sample it, decode
 * it.
 *
 * Six nodes, because everything else is genuinely shared. The noise and the
 * scheduler are the interesting ones to share rather than clone: neither reads
 * the latent, so one of each serves every chunk — and one seed across all of
 * them is a small push towards their looking like each other, which is the
 * whole difficulty with cutting a video into pieces. It also means the seed and
 * step controls keep targeting the single node they always did.
 */
function chunkNodes(index: number): ComfyGraph {
  const id = (base: string) => chunkId(base, index);
  return {
    [id(LOADER)]: {
      class_type: "VHS_LoadVideo",
      inputs: {
        video: "",
        force_rate: SOURCE_FPS,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: CHUNK_FRAMES,
        // The only thing that distinguishes one chunk from the next. VHS cuts
        // the audio to the same span — `lazy_get_audio(video, skip/fps,
        // cap/fps)` — which is what lets the soundtrack be reassembled from the
        // pieces rather than decoded again from the whole file.
        skip_first_frames: index * CHUNK_FRAMES,
        select_every_nth: 1,
      },
      _meta: { title: `Load Video (chunk ${index + 1})` },
    },
    [id(SIZE)]: {
      class_type: "GetImageSizeAndCount",
      inputs: { image: [id(LOADER), 0] },
      _meta: { title: "Get Image Size & Count" },
    },
    [id(REFERENCE)]: {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: ["145", 0],
        width: [id(SIZE), 1],
        height: [id(SIZE), 2],
        length: [id(SIZE), 3],
        ref_image_size: "match",
        clip: ["128", 0],
        vae: ["119", 0],
        audio_vae: ["120", 0],
        "ref_videos.ref_video_0": [id(LOADER), 0],
        "ref_video_audios.ref_video_audio_0": [id(LOADER), 2],
      },
      _meta: { title: "MiniMax H3 Reference to Video" },
    },
    [id(GUIDER)]: {
      class_type: "BasicGuider",
      inputs: { model: ["127", 0], conditioning: [id(REFERENCE), 0] },
      _meta: { title: "Basic Guider" },
    },
    [id(SAMPLER)]: {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["129", 0],
        guider: [id(GUIDER), 0],
        sampler: ["123", 0],
        sigmas: ["124", 0],
        latent_image: [id(REFERENCE), 1],
      },
      _meta: { title: "SamplerCustomAdvanced" },
    },
    [id(DECODE)]: {
      class_type: "VAEDecode",
      inputs: { samples: [id(SAMPLER), 0], vae: ["119", 0] },
      _meta: { title: "VAE Decode" },
    },
  };
}

/**
 * The shortest pass worth making, in frames.
 *
 * The other end of the node's "trained range is ~124-362". Nothing enforces it
 * — a shorter pass samples and returns something — but what comes back has left
 * the range the weights were fitted on, and it is the reason chunks are spread
 * rather than packed. See `chunkPlan`.
 */
const MIN_CHUNK_FRAMES = 124;

/**
 * How the clip is divided: how many passes, and how much of it each one loads.
 *
 * **Spread evenly rather than packed to the ceiling**, which is the whole of
 * the arithmetic below. Packing takes 362 frames at a time and gives the last
 * pass the remainder, so a clip that runs a half-second past a boundary ends in
 * a ten-frame chunk — an eighth of the model's trained minimum, sampled as its
 * own video and then batched onto the end of a good one. Dividing the frames
 * across the passes instead puts the worst case at just over half a chunk
 * (a hair past one boundary is two passes of ~7.5s each), which is inside the
 * range everywhere.
 *
 * The frame count comes from the duration the browser measured, which is the
 * one number here that can be wrong — a MediaRecorder file misreports its own
 * length, which is why node 157 works its stride out from what the loader
 * actually returned rather than from this. So this is used only to *place* the
 * cuts, never to decide where the video ends: the last pass keeps the full
 * ceiling as its cap and stops when the file does. An under-measured clip
 * therefore comes back whole, with a last chunk longer than its siblings,
 * rather than truncated at a length nothing verified.
 */
function chunkPlan(values: Record<string, ParamValue>): {
  count: number;
  frames: number;
} {
  const seconds = Math.max(0, Number(values.source_seconds ?? 0));
  // Nothing measured yet: one pass, which is both the safe answer and what
  // every run did before this existed.
  if (seconds <= 0) return { count: 1, frames: CHUNK_FRAMES };

  const total = Math.ceil(seconds * SOURCE_FPS);
  const count = Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(total / CHUNK_FRAMES)));
  if (count === 1) return { count, frames: CHUNK_FRAMES };

  // Rounded up, so the cuts between them cover the measured length rather than
  // stopping a frame or two short of it.
  const frames = Math.ceil(total / count);
  return {
    count,
    // Both ends: a clip past the four-chunk ceiling divides into pieces bigger
    // than a pass, and the floor is there for a measurement that came back
    // absurdly small rather than for any division of a real clip.
    frames: Math.min(CHUNK_FRAMES, Math.max(MIN_CHUNK_FRAMES, frames)),
  };
}
const VIDEO_PARAM = "reference_video";
const WORDS_PARAM = "clip_words";
const AUDIO_KEEP_PARAM = "clip_audio_keep";
/** A remix keeps its clip whole unless told otherwise. */
const AUDIO_KEEP_DEFAULT = "exact" as const;

/**
 * Whether this run reuses the speech that is already in the clip.
 *
 * Only the answer that keeps the recording whole does. "Voices only" keeps how
 * it is spoken and replaces what is said, and the three below it keep less than
 * that — so on any of them the words the user typed out describe audio that is
 * not being carried over.
 */
const keepsClipSpeech = (values: Record<string, ParamValue>): boolean =>
  audioKeepReusesWords(values, AUDIO_KEEP_PARAM, AUDIO_KEEP_DEFAULT);

const graph: ComfyGraph = {
  // Every chunk's stack, all MAX_CHUNKS of them, declared rather than cloned at
  // run time. `finalize` deletes the ones a given clip does not reach, which is
  // the same pruning every optional input in this app goes through — and it
  // means `check:workflows` validates the whole thing standing still.
  ...Object.assign({}, ...Array.from({ length: MAX_CHUNKS }, (_, i) => chunkNodes(i))),

  /**
   * The pieces put back together: pictures end to end, and the source's own
   * sound over the top of them.
   *
   * The sound is the reason chunking works at all. H3 writes picture and audio
   * in one pass, so four passes mean four separately invented soundtracks, and
   * no amount of care at the joins hides a score restarting every fifteen
   * seconds. Taking the audio from the source instead — which each chunk loader
   * already carries for its own span — gives a track that was continuous before
   * anything was generated and stays that way.
   *
   * Which is also why this only applies to a remix: the clip brings its own
   * sound. A workflow inventing audio from nothing has nothing to fall back on.
   */
  "170": {
    class_type: "BatchImagesNode",
    inputs: Object.fromEntries(
      Array.from({ length: MAX_CHUNKS }, (_, i) => [
        `images.image${i}`,
        [chunkId(DECODE, i), 0],
      ]),
    ),
    _meta: { title: "Batch Images" },
  },
  ...Object.fromEntries(
    // One join per seam: the first pairs chunks 1 and 2, and each after it
    // takes what the last one produced. `finalize` picks the one that ends the
    // chain this run needs and drops the rest.
    Array.from({ length: MAX_CHUNKS - 1 }, (_, i) => [
      audioJoinId(i + 1),
      {
        class_type: "AudioConcatenate",
        inputs: {
          direction: "right",
          audio1: i === 0 ? [chunkId(LOADER, 0), 2] : [audioJoinId(i), 0],
          audio2: [chunkId(LOADER, i + 1), 2],
        },
        _meta: { title: "Audio Concatenate" },
      },
    ]),
  ),

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
    inputs: { noise_seed: 147913421715932 },
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
  // else to the source — which is the whole point of the workflow. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the ComfyUI
  // host.
  //
  // The `system_prompt` is overwritten per run by `source_seconds` below, which
  // appends how long the clip runs — measured in the browser, since nothing
  // here knows it until ComfyUI decodes the file. The sampled frames at 156 are
  // used here and nowhere else.
  "145": rewriteNode({
    prompt: ["138", 0],
    system: REMIX_DIRECTOR,
    images: ["155", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),


  // A handful of frames spread across the clip, for the director to look at.
  //
  // By stride over the decoded batch rather than by sampling the video, because
  // every node that selects frames from a VIDEO asks the container how many it
  // has — the question a MediaRecorder file answers wrongly. 157 works the
  // stride out from the frame count the loader actually returned.
  "155": {
    class_type: "VHS_SelectEveryNthImage",
    inputs: {
      images: ["154", 0],
      select_every_nth: ["157", 1],
      skip_first_images: 0,
    },
    _meta: { title: "Select Every Nth Image" },
  },
  "157": {
    class_type: "ComfyMathExpression",
    // Output 1 is the INT.
    inputs: {
      expression: `max(1, round(a / ${DIRECTOR_FRAMES}))`,
      "values.a": ["154", 1],
    },
    _meta: { title: "Math Expression" },
  },

};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
/**
 * The words heard in the source clip, in the prompt and in the director's brief.
 *
 * The clip's own audio is wired straight into the reference node, so this graph
 * hands H3 a recording to work over exactly as Reference to Video does with an
 * attached track — and nothing here can hear either of them. Same problem, same
 * pair of blocks, different noun for where the sound came from.
 */
const words = wordsBlocks({
  sourceParam: VIDEO_PARAM,
  wordsParam: WORDS_PARAM,
  source: CLIP_WORDS,
  // Only while the clip's own speech is being reused. Every other answer
  // replaces it, and a transcript of the old lines would then be the prompt
  // carrying exactly what the rest of the brief says to write anew.
  when: (values) => keepsClipSpeech(values),
});

const director = directorTarget(ids, REMIX_DIRECTOR, [
  words.director,
  // Last, so it lands after the standing preservation rules it overrides.
  audioKeep({
    param: AUDIO_KEEP_PARAM,
    // A remix keeps the clip's sound unless told otherwise, which is what the
    // director already assumed before this control existed.
    fallback: AUDIO_KEEP_DEFAULT,
    // The clip is required here, so its audio is always attached.
    attached: () => true,
  }),
]);

/** Written by the prompt and by the words below. See `promptTarget`. */
const promptText = promptTarget(ids, [words.prompt]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip to remix",
    type: "video",
    default: "",
    required: true,
    help: `Its size and length become the new video's. Up to 768×1344, ${MAX_SECONDS}s, 4 MB. Past ${(CHUNK_FRAMES / SOURCE_FPS).toFixed(0)}s it is rebuilt in passes of about that long and stitched back together, so a long clip costs a pass per piece.`,
    group: "Source",
    // Four passes' worth, which is this graph's own ceiling rather than the
    // upload path's 20s — a clip arriving through the Remix button is copied
    // server-side and is only ever limited by this. Anything longer would be
    // silently truncated at the last chunk, so it is refused instead.
    maxSeconds: MAX_SECONDS,
    targets: [{ node: VIDEO_NODE, input: "video" }],
    // The clip is the only thing that knows how long the output will be, so
    // the control that loads it reports that onward to the param below.
    measures: "source_seconds",
  },

  // No control of its own: filled in by the clip above, and read only by the
  // prompt director. See clipDurationParam for why it exists at all.
  clipDurationParam(director),

  audioKeepParam(director, {
    id: AUDIO_KEEP_PARAM,
    label: "What to keep from the clip's sound",
    fallback: AUDIO_KEEP_DEFAULT,
    group: "Source",
    help: "The clip's own audio is given to the model whatever this says. This decides what the new soundtrack owes it — turn it down to have the sound change with the picture.",
  }),

  wordsParam({
    id: WORDS_PARAM,
    label: "Words in the clip",
    help: "What is said or sung in the clip's own audio. Nothing here can hear it, so without this the model writes its own words over the ones already there — and with the voices being replaced, these are the only copy of the lines there is.",
    // Beside the clip they belong to rather than in a section of their own.
    group: "Source",
    // And only while they are wanted: the answers that write new words have no
    // use for the old ones. See `keepsClipSpeech`.
    revealedBy: VIDEO_PARAM,
    hiddenBy: audioKeepHidesWords(AUDIO_KEEP_PARAM),
    targets: [promptText, director],
  }),

  promptParam(
    ids,
    "Make it snow, and dress the man in a heavy winter coat.",
    "Say only what should change. Everything you leave out is held to the clip.",
    6,
    promptText,
  ),
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // No output controls at all on this one. Size and length come from the clip,
  // and the frame rate is fixed at the 24 the model works in.
  //
  // Far fewer steps than the generating graphs: a remix is holding to a source
  // rather than inventing from noise, so it converges quickly. This is the
  // number that ships; node 124's literal is whatever the export happened to
  // carry and never reaches ComfyUI.
  //
  // It is also the number turbo retunes this control to, so switching modes on
  // this graph moves the range without moving the value.
  ...samplingParams(ids, { steps: 8 }),
];

export const minimaxH3ReferenceVideo: WorkflowDef = {
  id: "minimax-h3-ref2v",
  name: "Remix",
  description: "Rebuilds a clip you have already made into a new take.",
  estimatedSeconds: 480,
  /**
   * One per chunk. 480 is a single pass, so a clip that needs four of them is
   * four times the wait — the number the clock starts from, and the bucket its
   * learned replacement is grouped by. See `chunkPlan`.
   */
  passes: (values) => chunkPlan(values).count,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  /**
   * The same switch as every other video graph, on the same `ref2va` UNET
   * Reference to Video applies it to.
   *
   * It was withheld here for a while on the argument that this graph already
   * samples at 8, the top of the LoRA's range, so the LoRA would spend quality
   * per step and save no time. That was only ever an argument about the number
   * this workflow ships at, and it left the other end of the range broken: at 4
   * steps the graph takes the pack's four-step form — distilled sampler, bf16
   * weights, no Spectrum — and the sampler in that form exists to be paired with
   * the distilled LoRA. Four steps without one is not a usable take, so the
   * cheap end of the control was reachable and worthless.
   *
   * **It starts at four steps**, not at the eight this graph ships at with the
   * switch off. Four is where the node pack's own form is complete — its
   * four-step sampler, the bf16 pair, no Spectrum — and with the LoRA under it
   * that form is the fast one and the intended one at once. Eight is still a
   * drag of the control away for a take worth the extra minutes.
   *
   * 270s is scaled from this graph's own 480 on the fit Reference to Video's
   * numbers imply: about 60s of everything that is not sampling, and the rest
   * per step — so 480 at eight steps puts a step near 52s, and four of them at
   * 60 + 210. Measured on nothing; the first finished run in this combination
   * replaces it with this machine's median.
   */
  turbo: h3Turbo(270, 4),
  /**
   * The patches do apply, though, and for the reason turbo does not: they
   * change how a step is arrived at rather than how many there are, so a low
   * step count is no argument against either of them.
   */
  // The content LoRA first, matching the order they stack in. Same ref2va
  // backbone and same caveat as Reference to Video — see h3ContentLora.
  patches: [h3ContentLora(), ...h3Patches()],
  /**
   * The same four-step form as Reference to Video, because it is the same model
   * under the same node class: `minimax_h3_ref2va` through
   * `MiniMaxH3ReferenceToVideo`, given a reference to work over — pictures and a
   * track there, a clip and its audio here.
   *
   * So at four steps this graph is the pack's four-step form and nothing else:
   * the distilled sampler, the bf16 diffusion model and text encoder in place of
   * the quantised pair, and no Spectrum. The evidence for each is in
   * minimax-h3-ref.ts, where it was worked out; carried across on the strength
   * of the model rather than of a failure seen here, which is the honest account
   * — nothing has run *this* graph at four steps on the quantised pair to find
   * out whether it breaks the same way. If it turns out to run fine on them,
   * that is an argument for dropping the swap here, not for having guessed.
   *
   * What is *not* carried across is the pin. On Reference to Video a track holds
   * the steps at four, because the bf16 pair is loaded only there and the
   * quantised one failed on a track. This graph has audio on every run and ships
   * at eight steps, which is evidence the quantised pair takes a clip's audio
   * perfectly well — so pinning it here would fix a problem this workflow does
   * not have, at the cost of every remix it makes.
   */
  stepSampler: h3StepSampler({
    models: h3Bf16Models({ unet: "127", clip: "128" }),
    suppresses: ["spectrum"],
    note: "It also loads the bf16 diffusion model and text encoder, and leaves Spectrum out, which the four-step form does not use.",
  }),
  /**
   * The prompt is the one thing the clip cannot supply, so it comes across
   * from the generation being remixed. See ClipTarget for what deliberately
   * does not.
   */
  clipTarget: {
    action: "remix",
    accepts: "video",
    sourceParam: "reference_video",
    carry: ["prompt"],
  },

  /**
   * Cut the graph down to the chunks this clip actually needs.
   *
   * A clip inside one chunk queues exactly the graph this workflow always
   * queued: one pass, and the audio the model generated with it. Everything
   * below is what happens past fifteen seconds.
   */
  finalize(graph, values) {
    const { count: chunks, frames } = chunkPlan(values);

    // Where each surviving pass cuts. The stored graph packs them at the
    // ceiling; this is what spreads them. The last one keeps the ceiling as its
    // cap so it runs to the end of the file whatever the measurement said —
    // see `chunkPlan`.
    for (let index = 0; index < chunks; index += 1) {
      const loader = graph[chunkId(LOADER, index)].inputs;
      loader.skip_first_frames = index * frames;
      loader.frame_load_cap = index === chunks - 1 ? CHUNK_FRAMES : frames;
    }

    // Whatever is past the end goes: its stack, its slot in the batch, and the
    // join that would have appended its sound.
    for (let index = chunks; index < MAX_CHUNKS; index += 1) {
      for (const base of [LOADER, SIZE, REFERENCE, GUIDER, SAMPLER, DECODE]) {
        delete graph[chunkId(base, index)];
      }
      delete graph[BATCH_NODE].inputs[`images.image${index}`];
    }
    // A run needs one join per seam, so joins 1 to chunks-1 stay and the chain
    // starts deleting at `chunks`. One chunk has no seams and loses all of
    // them, which is the loop starting at 1.
    for (let join = chunks; join < MAX_CHUNKS; join += 1) {
      delete graph[audioJoinId(join)];
    }

    if (chunks === 1) {
      // Nothing to join. The batch of one and the whole audio chain go, and the
      // output reads the single decode and the generated audio, exactly as it
      // did before any of this existed.
      delete graph[BATCH_NODE];
      graph["130"].inputs.images = [chunkId(DECODE, 0), 0];
      return;
    }

    graph["130"].inputs.images = [BATCH_NODE, 0];
    // The source's own sound, reassembled from the spans each loader carries,
    // in place of the audio the model made. See node 170's note for why.
    graph["130"].inputs.audio = [audioJoinId(chunks - 1), 0];
    // Which leaves nothing reading the audio decode.
    delete graph["121"];
  },
  /**
   * Every chunk count, because each one is a different graph.
   *
   * The lengths are picked to land either side of the boundaries rather than in
   * the middle of a band: 15 is inside one chunk, 15.5 is just past it. What
   * this is really checking is that the pruning and the rewiring agree — that
   * the batch has exactly the slots the surviving decodes fill, that the join
   * `130` reads is the last one still standing, and that the single-chunk case
   * still queues the graph this workflow queued before chunking existed.
   *
   * The last two run with the director switched off, since bypass sweeps
   * unreachable nodes *after* this prunes and the two passes have to agree
   * about what is still reachable — with the director gone, the frames sampled
   * for it are read by nothing and go, and every chunk's reference node has to
   * be left reading the raw prompt instead.
   */
  finalizeCases: [
    {
      name: "a clip inside one chunk",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 8 },
    },
    {
      name: "a clip exactly at the chunk ceiling",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 15 },
    },
    {
      name: "a clip just past one chunk",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 15.5 },
    },
    {
      name: "a clip over three chunks",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 40 },
    },
    {
      name: "a clip past the four-chunk ceiling",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 200 },
    },
    {
      name: "one chunk with the director off",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 8, [bypass.param]: true },
    },
    {
      name: "four chunks with the director off",
      values: { [VIDEO_PARAM]: "clip.mp4", source_seconds: 55, [bypass.param]: true },
    },
  ],
};
