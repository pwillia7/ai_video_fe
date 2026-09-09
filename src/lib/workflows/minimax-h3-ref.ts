import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import { hideDirectorOnly } from "./director";
import {
  REWRITE_IMAGE_INPUT,
  rewriteModelParam,
  rewriteNode,
} from "./rewrite-model";
import { isSet } from "./types";
import type { ParamDef, ParamPin, ParamValue, WorkflowDef } from "./types";
import {
  CHUNK_FPS,
  LITERAL_PROMPT,
  MAX_CHUNKS,
  MAX_CHUNK_SECONDS,
  chunkPlan,
  FRAME_EXPRESSION,
  directorBypassFor,
  effectiveSeconds,
  directorTarget,
  durationParam,
  REFERENCE_DIRECTOR,
  TRACK_WORDS,
  h3Bf16Models,
  h3ContentLora,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  aspectRatioParam,
  leadingReferences,
  literalPromptParam,
  promptParam,
  promptTarget,
  audioKeep,
  audioKeepParam,
  referenceFacets,
  referenceVideo,
  referenceVideoKeepParam,
  referenceSlot,
  referenceTrack,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 reference-to-video: up to four reference images steer the subject,
 * and the prompt says what they do.
 *
 * ## Past fifteen seconds
 *
 * The model takes at most 362 frames in a pass, so a longer video is built in
 * several and joined. The arithmetic is shared with Remix (`chunkPlan`); what
 * differs is what a pass is conditioned on, and it is worth being precise about
 * because it is the whole reason this graph needed its own answer.
 *
 * Remix cuts one continuous source into spans and gives each pass its own. Here
 * most of the references are **stills** — the same four pictures belong to every
 * second of the video, so passes given only those would be four renders of one
 * conditioning at one seed. Not a long video: the same shot, repeated. So a run
 * past one pass needs something that varies with time, and that is a reference
 * clip or a reference track. Each pass takes its own slice; the pictures, the
 * prompt, the seed and the scheduler are shared, which is what keeps the passes
 * looking like each other. Without either, `finalize` refuses rather than
 * building the stutter.
 *
 * The soundtrack is picked in the same spirit and in this order: a reference
 * track that covers the whole video, else the clip's own sound where it was
 * attached and reaches the end, else the passes' own generated audio joined end
 * to end. Only the last has a seam, and it is audible — each pass invents its
 * audio from nothing, so a score restarts at every join. The first two were
 * continuous before anything was generated and stay that way.
 *
 * Notes on this export:
 *
 * - Node ids are flat, not the "105:" subgraph ids the text/image graphs use.
 * - The prompt is not an input on the video node. What the user types goes to
 *   node 138, an LLM expands it (144/145), and only that expanded text reaches
 *   the video node. So 138 is what the prompt control writes to.
 * - The rewrite stage is given the references as well, batched by node 146, so
 *   it can describe what it actually sees rather than guessing. That is the one
 *   structural difference from the text-to-video graph's rewrite stage.
 * - `ref_images.ref_image_0` … `ref_image_3` are ComfyUI's variadic input
 *   form, as are `images.image0` … on the batch. A run with fewer references
 *   must *remove* the unused inputs and their LoadImage nodes rather than leave
 *   them blank — see `finalize` below.
 * - A different UNET from the other two: `ref2va` rather than `fl2va`.
 * - `ref_audios.ref_audio_0` takes a track, through the trim at node 167 and
 *   from the loader at 155. Same variadic form as the images and the same rule:
 *   unused means removed, not blank. It is what the Create video button on a
 *   finished track fills in — see `clipTarget` — and the reason this graph,
 *   alone among the H3 ones, has a LoadAudio in it. What reaches the model is
 *   as many seconds of it as the video is long, from wherever the form says to
 *   start, unless the form says to send all of it.
 * - **A track pins the run to four steps**, and four steps loads a different
 *   diffusion model and text encoder from the rest of the range. See
 *   `FOUR_STEP_MODELS` and `TRACK_PINS_STEPS`.
 */
const ids: MinimaxNodeIds = {
  prompt: { node: "138", input: "value" },
  director: "145",
  duration: "132",
  noise: "129",
  scheduler: "124",
};

/**
 * One LoadImage per reference slot, in the order the form offers them. The
 * first is required; the rest are optional and each is dropped from the graph
 * when unused — see `finalize`.
 *
 * Four rather than two because the node's `ref_images` is variadic and takes as
 * many as it is given: the archived remix graph under archive/ ran five. Four
 * is where the form stops rather than where H3 does, so adding a fifth is a
 * LoadImage node and one more id in this list. Every slot feeds two consumers,
 * the video node and the batch that shows the references to the rewrite stage,
 * so dropping one means clearing a link in both places.
 */
const REF_NODES = ["137", "139", "165", "166"];


const REFERENCE_NODE = "136";
const REFERENCE_NODE_ID = "136";
const GUIDER_NODE = "126";
const SAMPLER_NODE = "125";
const DECODE_NODE = "122";
const DECODE_AUDIO_NODE = "121";
const FRAMES_NODE = "131";
const DURATION_NODE = "132";
/** Where the finished video is assembled before it is saved. */
const VIDEO_OUT_NODE = "130";
/**
 * The nodes a second and subsequent pass needs its own copy of, and the ids
 * they take.
 *
 * Chunking here is the same idea as Remix's and a different shape, because what
 * a pass is conditioned on is different. Remix cuts one continuous source into
 * spans and hands each span to its own pass; this graph's references are mostly
 * *stills*, which do not vary with time at all — the same four pictures belong
 * to every second of the video.
 *
 * So what a chunk owns here is only the part that moves: its slice of a
 * reference clip, its slice of a reference track, and the sampling stack that
 * turns them into a segment. The pictures, the prompt, the seed, the scheduler
 * and the model loaders are shared, which is both cheaper and the point — four
 * passes that disagreed about any of them would not read as one video.
 *
 * Which is also the rule `finalize` enforces: with neither a clip nor a track
 * there is nothing that varies from pass to pass, so four passes would be four
 * renders of the same conditioning at the same seed. That is not a long video,
 * it is a stutter, and it is refused rather than built.
 */
const CHUNK_NODES = [
  REFERENCE_NODE_ID,
  GUIDER_NODE,
  SAMPLER_NODE,
  DECODE_NODE,
  DECODE_AUDIO_NODE,
  FRAMES_NODE,
  DURATION_NODE,
];
/** Ids for pass i. Pass 0 keeps the ids the exported graph already used. */
const chunkId = (base: string, index: number) =>
  index === 0 ? base : `${base}k${index}`;

/** Where the passes are put back together. */
const JOIN_IMAGES_NODE = "180";
/** The reference track cut to the finished video's length, when it becomes it. */
const JOIN_TRACK_NODE = "184";
/** One per seam, joining the passes' own generated audio when nothing else can. */
const audioJoinId = (index: number) => `18${index + 1}`;

const BATCH_NODE = "146";
const AUDIO_NODE = "155";
const TRIM_NODE = "167";
const AUDIO_INPUT = "ref_audios.ref_audio_0";
const AUDIO_PARAM = "reference_audio";

/**
 * The reference clip: its loader, the split that feeds the model, and the pair
 * that samples frames for the director to look at.
 *
 * Four nodes rather than two because the rewrite stage takes images and there
 * is no such thing as showing it a video. Remix solves that the same way and
 * with the same node classes; what differs here is only that the frames join a
 * batch of reference pictures instead of being the whole of it.
 */
const VIDEO_NODE = "170";
const VIDEO_SCALE_NODE = "171";
const VIDEO_PEEK_NODE = "172";
const VIDEO_STRIDE_NODE = "173";
/** The clip's own per-pass pair: the slice, and that slice scaled. */
const CHUNK_VIDEO_NODES = [VIDEO_NODE, VIDEO_SCALE_NODE];
const VIDEO_INPUT = "ref_videos.ref_video_0";
const VIDEO_AUDIO_INPUT = "ref_video_audios.ref_video_audio_0";
const VIDEO_PARAM = "reference_video";
const VIDEO_AUDIO_PARAM = "reference_video_audio";
const VIDEO_KEEP_PARAM = "reference_video_keep";
const VIDEO_AUDIO_KEEP_PARAM = "reference_video_audio_keep";
/**
 * A clip attached here is a reference rather than the thing being rebuilt, so
 * its sound is atmosphere by default: the room and any music carry, the speech
 * does not. Turning the soundtrack on at all is a choice to use it for
 * something, which is why this is not the answer that keeps nothing.
 */
const VIDEO_AUDIO_KEEP_DEFAULT = "speech" as const;

/**
 * The most detail a reference clip is given, in megapixels.
 *
 * A reference is there to say who someone is and how they move, and neither
 * needs more resolution than the video being made — but the reference node has
 * no opinion about the output's size, only about its own canvas. Left alone it
 * keeps a 1280x720 recording at 1280x704, which is 1.8x the *area* of a frame
 * at the default 0.5 MP: every reference frame then costs more than a generated
 * one, through every sampling step.
 *
 * So the clip is scaled to the output's own frame size, capped here. The cap
 * matters at the top of the Frame size range, where matching a 2 MP output
 * would drag a 2 MP reference through the whole run for no gain.
 */
const REF_MAX_MEGAPIXELS = 0.5;

/**
 * The frame rate H3 reads a reference video at.
 *
 * Not a preference — the node has no resampling in it. Whatever batch reaches
 * `ref_videos.ref_video_0` is *interpreted* as 24 fps, and its own tooltip says
 * so. Hand it a 60 fps clip untouched and the model is told a 5-second
 * reference runs 12.5 seconds, at which point the frames it keeps are the first
 * 40% of what the user attached and everything about the motion is wrong.
 */
const REF_VIDEO_FPS = 24;

/**
 * How much of a clip actually conditions the model, in seconds.
 *
 * MiniMax documents a reference video at 2-15s, and the fifteen is a budget
 * shared with reference audio rather than a per-file limit. Past it is outside
 * what they describe rather than outside what the node takes, so this is where
 * the graph stops handing frames over: `frame_load_cap` counts frames at the
 * forced rate, and anything beyond is never decoded.
 *
 * Not the same number as the upload limit below, deliberately. A longer file is
 * fine to bring — the reference node truncates a clip to the generated video's
 * own frame count in any case, so `min(clip, budget, video)` is what the model
 * ever sees — and refusing one at the door would only send someone away to trim
 * it by hand for no gain.
 */
const REF_BUDGET_SECONDS = 15;

/**
 * The longest clip that may be uploaded, in seconds.
 *
 * Larger than the budget on purpose: what is past it is truncated rather than
 * rejected. Twenty is what Remix and Extend already accept, so a clip that
 * works for those works here.
 *
 * Worth being clear about what neither number protects. The expensive case is
 * not a long clip, it is a clip as long as the video — the reference is encoded
 * to latent frames that ride alongside the generated ones through every
 * sampling step, so a reference matching the output doubles the sequence, and
 * that 2x ceiling is reachable at any length. Six seconds of reference against
 * a five-second video already sits on it.
 */
const MAX_CLIP_SECONDS = 20;

/**
 * How many frames of the clip the director is shown.
 *
 * Five, matching Remix. It is a peek rather than a viewing — enough to see who
 * is in the clip and roughly what they do, few enough that it does not swamp
 * the reference pictures sitting beside it in the same batch. Not a count the
 * graph is given, though: the node that thins the batch without asking the
 * container anything takes every nth image, so this is what the stride is
 * computed to approximate, inside ComfyUI, from the frames actually loaded.
 */
const VIDEO_SAMPLE_FRAMES = 5;
const TRIM_PARAM = "reference_trim";
const TRIM_SECONDS_PARAM = "reference_trim_seconds";
const TRIM_START_PARAM = "reference_trim_start";
const TRACK_SECONDS_PARAM = "reference_track_seconds";
/** Where the browser reports the reference clip's length. See `measures`. */
const CLIP_SECONDS_PARAM = "reference_clip_seconds";
const LYRICS_PARAM = "reference_lyrics";

/** What the trim select offers, and what each answer means in seconds. */
const TRIM_WHOLE = "whole";
const TRIM_MATCH = "match";
const TRIM_SET = "set";

/** Whether this run has a reference track, which several things turn on. */
const trackAttached = (values: Record<string, ParamValue>): boolean =>
  String(values[AUDIO_PARAM] ?? "").trim() !== "";

/** Whether this run has a reference clip. */
const videoAttached = (values: Record<string, ParamValue>): boolean =>
  String(values[VIDEO_PARAM] ?? "").trim() !== "";

/**
 * Whether the clip's own soundtrack goes to the model with it.
 *
 * Only ever true alongside a clip: the toggle keeps its value while the video
 * control is empty, and a soundtrack input left wired to a loader that has been
 * deleted is a graph ComfyUI rejects.
 */
const videoAudioAttached = (values: Record<string, ParamValue>): boolean =>
  videoAttached(values) && isSet(values[VIDEO_AUDIO_PARAM]);

/**
 * The weights this graph loads at four steps, in place of the ones the stored
 * graph names.
 *
 * A track and reference images together used to come back from ComfyUI as
 * `RuntimeError: The size of tensor a (3) must match the size of tensor b (2)
 * at non-singleton dimension 0`, and the pair was fenced off in the form
 * because nothing in the reference path — nodes_minimax_h3.py,
 * ldm/minimax/model.py, text_encoders/minimax.py — said it should fail. It was
 * the quantised pair: `minimax_h3_ref2va_pruned_int8_convrot` with
 * `qwen3vl_32b_minimax_h3_nvfp4_awq`. The bf16 diffusion model and the bf16
 * text encoder take the same references, together, at four steps, which is
 * where the fence went and why there is no longer one.
 *
 * The graphs on `fl2va` do not swap. They have never had the failure, so
 * pointing them at weights nobody here has tested would be a change with no
 * evidence behind it — and one more pair of files a fresh install has to
 * download. Remix runs the same `ref2va` UNET through the same node class and
 * does swap; see `h3Bf16Models`, which is where the pair now lives.
 */
const FOUR_STEP_MODELS = h3Bf16Models({ unet: "127", clip: "128" });

/**
 * A reference that is not a still holds the step count at four, which is the
 * only step count this graph is known to take one at.
 *
 * The bf16 pair above is loaded at four steps and nowhere else, so any other
 * value would run the reference through the quantised models that failed on it.
 * That is a rule about the run rather than a preference, which is why it pins
 * the control instead of nudging its default: a stored 12 from a previous run
 * would otherwise sail straight past it. Removing the reference hands the
 * control back with whatever number was in it.
 *
 * A reference *video* pins it for the same reason a track does, and the reason
 * is the failure the quantised pair had: it was a batch-dimension mismatch on a
 * run carrying more than one kind of reference block, which a clip is as much
 * as a track is. Remix, which is nothing but a video reference through this
 * same node class, already runs on the bf16 pair — so this is the pairing that
 * has actually been seen to take one, rather than a guess about the other.
 */
const TRACK_PINS_STEPS: ParamPin = {
  whenSet: [AUDIO_PARAM, VIDEO_PARAM],
  value: 4,
  note: "A reference track or clip pins this to 4 — the step count the bf16 model pair and the pack's own sampler take one at. Leave Turbo on: four steps without the distilled LoRA is not a usable take.",
};

/**
 * How many seconds of the track the model is given.
 *
 * One function rather than one per control, because both controls write the
 * same node input and a target write is an assignment: each of them has to
 * produce the whole answer or the last one to run would win with half of it.
 * The same rule the director's instructions are assembled under.
 *
 * "As long as the video" is the *snapped* length rather than the number on the
 * slider — the frame grid rounds a request up by as much as two thirds of a
 * second, and the trim should match what actually comes back rather than what
 * was asked for. It is the same number the director is told the video runs to.
 */
const trimSeconds = (values: Record<string, ParamValue>): number => {
  if (String(values[TRIM_PARAM] ?? TRIM_MATCH) === TRIM_SET) {
    return Number(values[TRIM_SECONDS_PARAM] ?? 15);
  }
  // Whole-track runs land here too, and it does not matter: `finalize` has
  // deleted the node this is written to by the time anything is queued.
  return effectiveSeconds(Number(values.duration ?? 10));
};

/**
 * Where in the track the reference starts, in seconds.
 *
 * Written by the start control and by the measurement of the track itself,
 * which both target the same input for the same reason the two length controls
 * do: a target write is an assignment, so each has to produce the whole answer.
 *
 * The measurement is what makes the control safe. `TrimAudioDuration` clamps a
 * start to the length of the audio and then raises if nothing is left — so a
 * start past the end of the track is the one way to fail the node — and the
 * browser reads that length off the loaded track and reports it here. With a
 * length known, `finalize` rejects an impossible start at submit and says how
 * long the track actually is; with none known it is passed through, which is
 * the pre-measurement case and the same risk every run took before.
 */
const startSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[TRIM_START_PARAM] ?? 0));

/** How long the loaded track runs, or 0 for "nothing has measured it". */
const trackSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[TRACK_SECONDS_PARAM] ?? 0));

/** How each slot names its input on those two nodes. Slot 1 is index 0. */
/**
 * How long the finished video runs, snapped to the grid the sampler accepts —
 * the same number the director is told and the trim matches, so the passes are
 * divided by what actually comes back rather than by what was asked for.
 */
const outputSeconds = (values: Record<string, ParamValue>): number =>
  effectiveSeconds(Number(values.duration ?? 10));

/** How long the reference clip runs, or 0 for "nothing has measured it". */
const clipSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[CLIP_SECONDS_PARAM] ?? 0));

/**
 * Whether anything in this submission varies with time.
 *
 * The condition on running more than one pass. Stills do not: the same four
 * pictures belong to every second of the video, so four passes given only those
 * would be four renders of one conditioning at one seed. A clip or a track is
 * the thing that can be sliced, and so the thing that makes pass 2 different
 * from pass 1.
 */
const hasMovingReference = (values: Record<string, ParamValue>): boolean =>
  videoAttached(values) || trackAttached(values);

/**
 * How many passes this submission takes, and what each covers.
 *
 * One whenever nothing varies with time, whatever the duration says — the
 * refusal lives in `finalize`, which is where it can name the control to fix.
 * Reported here as one so that `passes` and the estimate agree with the graph
 * that will actually be queued.
 */
const refChunkPlan = (values: Record<string, ParamValue>) =>
  hasMovingReference(values)
    ? chunkPlan(outputSeconds(values))
    : { count: 1, frames: 0 };

const refInput = (index: number) => `ref_images.ref_image_${index - 1}`;
const batchInput = (index: number) => `images.image${index - 1}`;

/**
 * One pass's worth of graph, cloned from the ids the export already used.
 *
 * Built by reading the stored nodes rather than by writing them out a second
 * time: a copy typed here would be a copy to keep in step, and the thing it
 * would drift from is the very wiring `check:workflows` validates. So the
 * chunk stack is whatever pass 0 is, with its internal links renamed.
 *
 * A link is rewritten only when it points at another node in the same stack.
 * Everything else — the model loaders, the pictures, the prompt, the seed —
 * keeps pointing at the one shared copy, which is what makes the passes look
 * like each other rather than like four separate runs.
 */
function chunkNodes(base: ComfyGraph, index: number, ids: string[]): ComfyGraph {
  const owned = new Set(ids);
  const out: ComfyGraph = {};
  for (const id of ids) {
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
  return out;
}

const baseGraph: ComfyGraph = {
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
    inputs: { noise_seed: 715435511296592 },
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
      "ref_images.ref_image_2": ["165", 0],
      "ref_images.ref_image_3": ["166", 0],
      // A clip as a reference, on the same footing as the pictures.
      //
      // The frames come from 175, which is the clip resampled to 24 fps and
      // capped — *not* from the raw split at 171. The node reads whatever it is
      // given as 24 fps and truncates it to the generated video's length, so
      // handing it the file's own frames both misstates how fast the clip moves
      // and lets the reference grow to the size of the video being made. See
      // REF_VIDEO_FPS and MAX_CLIP_SECONDS.
      //
      // The soundtrack does come off 171, because sampling frames drops the
      // audio: `VideoFrameSample` returns picture and frame rate and nothing
      // else. That is the one thing here that reads every frame of the clip,
      // which is why it is wired only when the sound is actually wanted — with
      // the toggle off, `finalize` removes this input and nothing reads 171 at
      // all, so ComfyUI never decodes the clip in full.
      //
      // `ref_video_audios` pairs with `ref_video_0` by index and fuses the two
      // into one conditioning block — a clip that sounds like this, rather than
      // a clip and an unrelated sound. `ref_audios` below is the other thing,
      // and both can be given at once. All of them go on any run that does not
      // have them; see `finalize`.
      "ref_videos.ref_video_0": ["171", 0],
      "ref_video_audios.ref_video_audio_0": ["170", 2],

      // The one reference that is not a picture. It comes through the trim
      // rather than straight off the loader; both go on every run that has no
      // track — see `finalize`.
      "ref_audios.ref_audio_0": ["167", 0],
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

  // The prompt-rewrite stage. 138 holds what the user typed, 146 batches the
  // references so the rewrite can see them all at once, 145 expands the two
  // into the description node 136 actually reads. Which model does the reading
  // is the `rewrite_model` param below; the key lives on the ComfyUI host.
  //
  // The `system_prompt` is overwritten per run by the duration param, which
  // appends the finished video's length — H3's format needs it to place shot
  // cut times.
  "145": rewriteNode({
    prompt: ["138", 0],
    system: REFERENCE_DIRECTOR,
    images: ["146", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),
  "146": {
    class_type: "BatchImagesNode",
    // Variadic, like ref_images above: an unused slot's input is removed
    // outright rather than left pointing at a deleted node.
    //
    // A reference video's sampled frames are appended here too, in the first
    // slot past the pictures that are actually filled — so they always arrive
    // after them, whatever the run. `finalize` wires that slot rather than this
    // declaration doing it, because which slot it is depends on the submission.
    inputs: {
      "images.image0": ["137", 0],
      "images.image1": ["139", 0],
      "images.image2": ["165", 0],
      "images.image3": ["166", 0],
    },
    _meta: { title: "Batch Images" },
  },

  // The reference clip, and the four nodes it needs.
  //
  // 170 is VHS's loader rather than ComfyUI's own, and that is load-bearing
  // twice over. `force_rate` resamples the clip to 24 fps — the rate the
  // reference node reads a video at, with no resampling of its own anywhere in
  // nodes_minimax_h3.py — so a clip arrives at the speed it was filmed at
  // whatever the camera did, which for a webcam is neither 24 nor 30 but
  // whatever it managed. And it reads a file the core loader cannot measure: a
  // browser's MediaRecorder writes a fragmented MP4 whose header says duration
  // 0 and whose sample tables are empty, which ComfyUI's own frame counting
  // reports as one frame. VHS demuxes it and reports the real 15 seconds.
  //
  // `frame_load_cap` is the budget, in frames at the forced rate. Everything
  // past it is never decoded.
  //
  // Outputs: 0 is the frames, 1 is how many there are, 2 is the soundtrack.
  "170": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: REF_VIDEO_FPS,
      // Left alone: the scaling that matters is by area, below, and a width or
      // height here would set one axis without regard to the other.
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: REF_BUDGET_SECONDS * REF_VIDEO_FPS,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },

  // The clip scaled to the size of the video being made. See
  // REF_MAX_MEGAPIXELS — without this a recording is conditioned on at 1.8x the
  // area of a generated frame, through every sampling step.
  //
  // `resolution_steps` of 32 because the reference node rounds its own canvas
  // to multiples of 32, so landing on one here is what stops it resampling a
  // second time.
  "171": {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      image: ["170", 0],
      upscale_method: "lanczos",
      megapixels: REF_MAX_MEGAPIXELS,
      resolution_steps: 32,
    },
    _meta: { title: "Scale Image to Total Pixels" },
  },

  // What the director is shown: every nth frame of the scaled batch, striding
  // to about VIDEO_SAMPLE_FRAMES of them.
  //
  // The stride is worked out at 173 from the frames the loader actually
  // returned rather than from anything this app measured, which is the point:
  // a clip's length is exactly the thing that cannot be trusted to be readable
  // before the run.
  "172": {
    class_type: "VHS_SelectEveryNthImage",
    inputs: {
      images: ["171", 0],
      select_every_nth: ["173", 1],
      skip_first_images: 0,
    },
    _meta: { title: "Select Every Nth Image" },
  },
  "173": {
    class_type: "ComfyMathExpression",
    // Output 1 is the INT. `round` and `max` are the same two functions
    // FRAME_EXPRESSION leans on, so this evaluates on the same footing.
    inputs: {
      expression: `max(1, round(a / ${VIDEO_SAMPLE_FRAMES}))`,
      "values.a": ["170", 1],
    },
    _meta: { title: "Math Expression" },
  },

  // The third and fourth reference loaders. Not in the ComfyUI export — the
  // graph this came from wired two — but a LoadImage carries no state of its
  // own beyond the filename a param writes, so there is nothing here to keep in
  // step with an export.
  "165": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },
  "166": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image" },
  },

  // The reference track. Not in the ComfyUI export either, and carries no
  // state beyond the filename a param writes.
  //
  // LoadAudio reads ComfyUI's input directory, which is why a generated track
  // has to be copied there before this can see it — /api/remix does that, the
  // same copy Remix and Extend make for a clip.
  "155": {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio" },
  },

  // How much of that track the model is actually given.
  //
  // Pressing Create video on a finished song hands over the whole song, and a
  // reference is not a running time: MiniMax's own model card puts a reference
  // audio at 2–15 seconds, ComfyUI's standalone `ref_audios` path truncates
  // nothing, and a three-minute track is thousands of latent frames of packed
  // sequence for a five-second video. So the trim sits between the loader and
  // the reference node, and the default is the length of the video being made.
  //
  // `TrimAudioDuration` is a ComfyUI built-in (comfy_extras/nodes_audio.py), so
  // this needs no pack the graph did not already need — but it is a recent one,
  // which is why it is in the stored graph rather than spliced in: `pnpm
  // check:nodes` then asks a real ComfyUI whether the class is there.
  //
  // Both inputs are written per run by the trim controls: `duration` for how
  // much, `start_index` for where from. Deleted outright when the whole track
  // is wanted, see `finalize`.
  "167": {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: ["155", 0],
      start_index: 0,
      duration: 15,
    },
    _meta: { title: "Trim Audio Duration" },
  },
};

/**
 * The stored graph plus every pass past the first, and the nodes that put them
 * back together.
 *
 * All MAX_CHUNKS declared rather than cloned at run time, for the reason the
 * rest of this file's optional inputs are: `finalize` deletes what a given
 * submission does not reach, and a graph that stands still is a graph
 * `check:workflows` can validate.
 */
const graph: ComfyGraph = {
  ...baseGraph,
  ...Object.assign(
    {},
    ...Array.from({ length: MAX_CHUNKS - 1 }, (_, i) =>
      chunkNodes(baseGraph, i + 1, [...CHUNK_NODES, ...CHUNK_VIDEO_NODES, TRIM_NODE]),
    ),
  ),

  /** The passes' pictures, end to end. */
  [JOIN_IMAGES_NODE]: {
    class_type: "BatchImagesNode",
    inputs: Object.fromEntries(
      Array.from({ length: MAX_CHUNKS }, (_, i) => [
        `images.image${i}`,
        [chunkId(DECODE_NODE, i), 0],
      ]),
    ),
    _meta: { title: "Batch Images (passes)" },
  },

  /**
   * The passes' own soundtracks, end to end.
   *
   * The fallback rather than the intent. Each pass invents its audio from
   * nothing, so joining them gives a score that restarts at every seam — which
   * is why `finalize` prefers the reference track below whenever there is one
   * long enough to cover the whole video, and only comes here when there is
   * not. Remix never needs this: a clip brings a continuous track with it.
   */
  ...Object.fromEntries(
    Array.from({ length: MAX_CHUNKS - 1 }, (_, i) => [
      audioJoinId(i),
      {
        class_type: "AudioConcatenate",
        inputs: {
          direction: "right",
          audio1: i === 0 ? [chunkId(DECODE_AUDIO_NODE, 0), 0] : [audioJoinId(i - 1), 0],
          audio2: [chunkId(DECODE_AUDIO_NODE, i + 1), 0],
        },
        _meta: { title: "Audio Concatenate" },
      },
    ]),
  ),

  /**
   * The reference track, cut to the length of the finished video.
   *
   * What makes a long run here worth listening to. A track that already covers
   * the whole video is continuous by definition, so putting it over the top
   * removes the only seam none of the rest of this can hide — the same trade
   * Remix makes with a clip's own sound, and the reason chunking is offered on
   * these two graphs and not on the ones that invent a video from nothing.
   *
   * Both inputs are written per run by `finalize`: the start is wherever the
   * trim controls point, and the duration is the video's own length.
   */
  [JOIN_TRACK_NODE]: {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: [AUDIO_NODE, 0],
      start_index: 0,
      duration: 15,
    },
    _meta: { title: "Trim Audio Duration (soundtrack)" },
  },
};

/**
 * Everything that shapes the director's instructions writes this one target,
 * built once here so the duration and every facet select cannot disagree about
 * what it is. See `directorTarget` for why they all write the whole thing.
 *
 * The appendix is told how many slots this graph wires; it reads the submitted
 * values to find out how many actually have an image in them.
 */
/**
 * The words of the attached track, in the prompt and in the director's brief.
 * One declaration for both, so the block the director is told to look for is
 * the one the prompt actually carries.
 */
const words = wordsBlocks({
  sourceParam: AUDIO_PARAM,
  wordsParam: LYRICS_PARAM,
  source: TRACK_WORDS,
});

const director = directorTarget(ids, REFERENCE_DIRECTOR, [
  // The pictures speak first, then the clip — the order the two arrive in the
  // batch the director is shown, so the instructions read in the same order as
  // the images they describe.
  referenceFacets(REF_NODES.length, { otherVisualReference: videoAttached }),
  referenceVideo({
    videoParam: VIDEO_PARAM,
    audioParam: VIDEO_AUDIO_PARAM,
    trackParam: AUDIO_PARAM,
    keepParam: VIDEO_KEEP_PARAM,
    slots: REF_NODES.length,
  }),
  referenceTrack(AUDIO_PARAM),
  words.director,
  // Last, so it lands after everything else that speaks for the sound.
  audioKeep({
    param: VIDEO_AUDIO_KEEP_PARAM,
    // Unlike Remix, a clip here is a reference rather than the thing being
    // rebuilt, so its sound is a mood by default rather than a track to reuse.
    fallback: VIDEO_AUDIO_KEEP_DEFAULT,
    attached: videoAudioAttached,
  }),
]);

/**
 * The prompt text, which on this graph is written by two controls.
 *
 * The words of an attached track go into the prompt itself rather than only
 * into the director's brief, because the prompt is what reaches H3 either way —
 * see `promptTarget`. One target object, shared by both, so the two cannot
 * disagree about what they are writing.
 */
const promptText = promptTarget(ids, [words.prompt]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  // An upload and a facet select per slot, each slot revealed by the one before
  // it — so the form starts as one image and grows only as far as it is used.
  ...REF_NODES.flatMap((node, position) =>
    // The first picture is not required here, unlike everywhere else this
    // helper is used: a track is a reference too, and a run with one and no
    // pictures is a real thing to want. What replaces the check is in
    // `finalize`, which can see both controls at once.
    referenceSlot({ index: position + 1, node, director, firstRequired: false }),
  ),
  /**
   * A clip as a reference, sitting alongside the pictures rather than instead
   * of them — which is the whole difference between this and Remix, where the
   * clip is the thing being rebuilt.
   *
   * Capped at MAX_CLIP_SECONDS, and floored at 1s because the reference node
   * refuses anything under five frames outright. The loader enforces the cap
   * again on its own terms — `frame_load_cap` at the forced rate — so a clip
   * that gets past the browser is still only decoded that far.
   */
  {
    id: VIDEO_PARAM,
    label: "Reference clip",
    // Reported onward so a long video can be cut into passes that each follow
    // their own stretch of the clip. See `refChunkPlan`.
    measures: CLIP_SECONDS_PARAM,
    type: "video",
    default: "",
    minSeconds: 1,
    maxSeconds: MAX_CLIP_SECONDS,
    budgetSeconds: REF_BUDGET_SECONDS,
    // A row until asked for. The picture above is what this workflow is named
    // after and keeps its drop target; a clip and a track are the alternatives
    // to it, and three open ones were most of the panel. See `compact`.
    compact: true,
    // Short, because the control it sits under is a row until it is asked for
    // — and the drop zone it opens into repeats the limits in full. What is
    // left is the part that is not obvious from either.
    help: "Optional. Shows how something moves, which a still cannot. Pins the run to 4 steps; a clip as long as the video is what makes one slow.",
    group: "References",
    targets: [
      { node: VIDEO_NODE, input: "video" },
      // The director is told what the clip is and which of the images in front
      // of it are frames of it. See referenceVideo.
      director,
    ],
  },
  referenceVideoKeepParam(director, {
    id: VIDEO_KEEP_PARAM,
    revealedBy: VIDEO_PARAM,
  }),
  {
    id: VIDEO_AUDIO_PARAM,
    label: "Use the clip's sound",
    type: "toggle",
    /**
     * Off by default, unlike Remix — where the clip *is* the video being
     * rebuilt and its sound is the baseline.
     *
     * Here the clip is a reference brought into a new scene, and attaching its
     * audio changes what the model is given structurally: the node fuses sound
     * and picture into one `video_audio` conditioning block, which is the same
     * shape Remix hands it to say "reproduce this". A run whose prompt asks for
     * new dialogue is then arguing with its own conditioning. Turn it on when
     * the clip's sound is wanted in the result.
     */
    default: false,
    help: "Gives the model the clip's own soundtrack along with its picture, and pulls the result towards reproducing the clip. Leave it off unless you want the clip's sound in the video.",
    group: "References",
    // Only a question about a clip that is there.
    revealedBy: VIDEO_PARAM,
    targets: [
      // No node input of its own: what it decides is whether an input exists at
      // all, which is `finalize`'s to do. It still targets the director, which
      // has to know whether the model was given the sound before it writes a
      // score over it.
      director,
    ],
  },
  audioKeepParam(director, {
    id: VIDEO_AUDIO_KEEP_PARAM,
    label: "What to keep from the clip's sound",
    fallback: VIDEO_AUDIO_KEEP_DEFAULT,
    // Only a question about a soundtrack the model is actually being given.
    revealedBy: [VIDEO_PARAM, VIDEO_AUDIO_PARAM],
    help: "What the new soundtrack owes the clip's own. Turn it up to reuse what is in it.",
  }),
  {
    id: AUDIO_PARAM,
    label: "Reference track",
    type: "audio",
    default: "",
    compact: true,
    help: "Optional. Pins the run to 4 steps. Only as much of it as the video is long is sent — see below.",
    group: "References",
    // Nothing else knows how long the track runs, and the start control has to
    // land inside it. The browser reads it off the loaded player and reports it
    // to the measured param below.
    measures: TRACK_SECONDS_PARAM,
    targets: [
      { node: AUDIO_NODE, input: "audio" },
      // Also the director's, which is told to stop inventing a score once a
      // real one has been handed to the model. See referenceTrack.
      director,
    ],
  },
  {
    /**
     * No control of its own: filled in by the clip above, and read only when
     * the video runs past a single pass — which is when the clip has to be
     * divided between them. Nothing measured reads as unknown, and a run with
     * an unmeasured clip simply gives every pass the same opening slice.
     */
    id: CLIP_SECONDS_PARAM,
    label: "Clip length",
    type: "measured",
    default: 0,
    group: "References",
    // The director, like every other measurement here — it writes the same
    // computed brief every contributor writes, and a measured value with no
    // target at all is refused by `check:workflows`. `finalize` is the reader
    // that actually matters, and it reads the resolved value rather than a
    // node, so this survives the director being switched off.
    targets: [director],
  },
  {
    id: TRACK_SECONDS_PARAM,
    label: "Track length",
    type: "measured",
    // Nothing measured yet, which every reader treats as "unknown" rather than
    // as an empty track — a form can be submitted before the player has its
    // metadata.
    default: 0,
    group: "References",
    targets: [
      {
        node: TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => startSeconds(values),
      },
    ],
  },
  {
    id: TRIM_PARAM,
    label: "How much of the track",
    type: "select",
    default: TRIM_MATCH,
    options: [
      { value: TRIM_MATCH, label: "As much as the video is long" },
      { value: TRIM_SET, label: "A set length" },
      { value: TRIM_WHOLE, label: "All of it" },
    ],
    help: "Pressing Create video on a finished song hands over the whole song. MiniMax documents a reference track at 2–15 seconds.",
    group: "References",
    // Only a question about a track that is there.
    revealedBy: AUDIO_PARAM,
    targets: [
      { node: TRIM_NODE, input: "duration", transform: (_value, values) => trimSeconds(values) },
    ],
  },
  {
    id: TRIM_START_PARAM,
    label: "Start at",
    type: "number",
    default: 0,
    min: 0,
    max: 3600,
    step: 0.5,
    unit: "sec",
    help: "Where in the track the reference is taken from. 0 is the opening, which on most songs is the least like the rest of it.",
    group: "References",
    // A question about a track that is there, and only while some of it is
    // being taken: with all of it, the trim node is not in the run at all.
    revealedBy: AUDIO_PARAM,
    hiddenBy: { param: TRIM_PARAM, is: TRIM_WHOLE },
    targets: [
      {
        node: TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => startSeconds(values),
      },
    ],
  },
  {
    id: TRIM_SECONDS_PARAM,
    label: "Seconds to use",
    type: "slider",
    default: 15,
    min: 1,
    max: 60,
    step: 0.5,
    unit: "sec",
    help: "How much to take from the start point. Past the end of the track simply stops there.",
    group: "References",
    // Both conditions, so a stored "a set length" cannot leave this control
    // sitting in a form with no track in it.
    revealedBy: [AUDIO_PARAM, { param: TRIM_PARAM, is: TRIM_SET }],
    targets: [
      { node: TRIM_NODE, input: "duration", transform: (_value, values) => trimSeconds(values) },
    ],
  },
  wordsParam({
    id: LYRICS_PARAM,
    label: "Words in the track",
    help: "Optional, and the single biggest thing you can do for a run with a track. Nothing here can hear the file, so without this the model writes its own words over yours. Section tags are read as structure, not sung.",
    group: "References",
    // Only a question about a track that is there. What was typed is kept and
    // comes back with the next one, the same as every other revealed control.
    revealedBy: AUDIO_PARAM,
    targets: [
      // The model reads this even with the rewrite switched off, which is the
      // reason it is a prompt target and not only a director one.
      promptText,
      // And the director is told what the block at the end of that prompt is,
      // and what to do with it. See wordsBlocks.
      director,
    ],
  }),
  {
    id: "ref_image_size",
    label: "Reference handling",
    type: "select",
    default: "match",
    // Both, so a ComfyUI too busy to answer leaves a choice rather than a
    // single-entry dropdown. See ASPECT_RATIOS for why that matters.
    options: [
      { value: "match", label: "match" },
      { value: "max", label: "max" },
    ],
    optionsFrom: { node: REFERENCE_NODE, input: "ref_image_size" },
    help: "max keeps more likeness, and is slower.",
    group: "References",
    advanced: true,
    targets: [{ node: REFERENCE_NODE, input: "ref_image_size" }],
  },

  promptParam(
    ids,
    "<Picture 1> is a superhero, mid-fight, in the ruins of a city.",
    "One line is enough. Name your references as <Picture 1>, <Picture 2> and so on, in upload order.",
    6,
    promptText,
  ),
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  durationParam(ids, director, {
    max: MAX_CHUNK_SECONDS,
    help: `Snaps to the nearest length the model accepts, so it can land slightly long. Past about 15s it is built in passes and joined — which needs a reference clip or track for the passes to follow, and sounds best when the track covers the whole video.`,
  }),
  aspectRatioParam("115"),
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
    targets: [
      { node: "115", input: "megapixels" },
      // A reference clip is scaled to the same frame size as the video being
      // made, up to REF_MAX_MEGAPIXELS — there is nothing for the model to take
      // from a reference sharper than its own output, and every pixel of it is
      // carried through every sampling step.
      {
        node: VIDEO_SCALE_NODE,
        input: "megapixels",
        transform: (value) =>
          Math.min(Number(value), REF_MAX_MEGAPIXELS),
      },
    ],
  },

  ...samplingParams(ids, { pinSteps: TRACK_PINS_STEPS }),
];

export const minimaxH3Reference: WorkflowDef = {
  id: "minimax-h3-ref",
  name: "Reference to Video",
  description: "Puts people or objects from your images into a new scene.",
  estimatedSeconds: 300,
  /**
   * One per pass. Past a single pass this is four times the wait, so it is both
   * the estimate's multiplier and the bucket the learned median groups by. See
   * `refChunkPlan`.
   */
  passes: (values) => refChunkPlan(values).count,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  // The clip's soundtrack toggle survives the bypass: its only *target* is the
  // director, but what it decides is whether the model is handed the clip's
  // audio, and that is true of a run with no rewrite in it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass, { keep: [VIDEO_AUDIO_PARAM] }),
  directorBypass: bypass,
  /**
   * This graph is where turbo started: the mode's first form in this app was a
   * ComfyUI export of *this* workflow with the LoRA spliced in, and it produced
   * usable takes. The switch was taken off for a while on the strength of the
   * LoRA's author calling `ref2va` unsupported — worth knowing, and the reason
   * to compare a turbo take against a standard one before trusting it for
   * identity work, but not a reason to withhold a mode that had been working.
   * <https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10>
   *
   * **It starts at four steps**, which is the fast end of the range and also the
   * only end of it the node pack has a complete form for: the four-step sampler,
   * the bf16 pair, no Spectrum. Eight is still there for a take worth spending
   * the time on, and a reference track pins the control to four in any case —
   * so four as the shipped number is what the graph was already doing whenever
   * a track was attached, made the default for everything else too.
   *
   * 140s is scaled from this graph's own 300s rather than measured, on the fit
   * the old 220s implied: 300 at twelve steps and 220 at eight puts a step at
   * 20s and everything that is not sampling — the rewrite, the model load, the
   * decode — at about 60s, so four steps is 60 + 80. The first finished turbo
   * run on a machine replaces it with that machine's median.
   */
  turbo: h3Turbo(140, 4),

  // The content LoRA first, matching the order they stack in. This graph runs
  // the ref2va backbone, for which the LoRA declares its own checkpoint — see
  // h3ContentLora, and the note on that base about it being ours rather than
  // the LoRA author's pairing.
  patches: [h3ContentLora(), ...h3Patches()],
  stepSampler: h3StepSampler({
    models: FOUR_STEP_MODELS,
    /**
     * Spectrum forecasts sampler steps from the ones already taken, and at four
     * steps there is nothing to forecast from worth having: the ComfyUI export
     * that produced a working four-step take with a reference track has no
     * Spectrum node in it. So the four-step form of this graph is the whole of
     * that export — distilled sampler, bf16 weights, no forecaster — and the
     * switch is refused rather than quietly left on.
     *
     * Which also settles the reference-track case, without a second rule for
     * it: a track pins the steps to 4, and this keys off the pinned value.
     */
    suppresses: ["spectrum"],
    note: "It also loads the bf16 diffusion model and text encoder — the pair that takes a reference track — and leaves Spectrum out, which the four-step form does not use.",
  }),

  /**
   * Where a finished track goes when you press Create video on it.
   *
   * The one hand-off that is not about a clip, which is why `accepts` exists:
   * the button belongs on an audio result and nowhere else, and offering Remix
   * on a track would send an mp3 to a LoadVideo node.
   *
   * Nothing is carried across. The music workflow's `prompt` is a description
   * of a record rather than of a scene, and its `duration` counts minutes while
   * this graph's counts seconds — a carried value is not clamped to the
   * destination's range, so that one would arrive out of bounds and be rejected
   * at submit. See ClipTarget.
   */
  clipTarget: {
    action: "illustrate",
    accepts: "audio",
    sourceParam: AUDIO_PARAM,
  },

  /**
   * Every reference slot past the ones actually filled has its variadic inputs
   * and its loader removed outright. Leaving them pointing at a LoadImage with
   * an empty filename would fail validation, and leaving one blank is not the
   * same as omitting it — the model would be told to expect a subject that was
   * never supplied.
   *
   * Both consumers have to be cleared before the loader goes. Dropping the
   * node while the batch still linked to it would queue a graph referencing a
   * node that no longer exists, which ComfyUI rejects outright.
   *
   * `leadingReferences` rather than "every slot with a value": the kept slots
   * have to be the first N with no hole in the middle, because the variadic
   * names left behind are what tells H3 how many pictures it has and in which
   * order — and it is the same count the director was given.
   */
  /**
   * The combinations `finalize` below has to survive. Every one of them prunes
   * a different set of nodes, and the ones that go wrong are the sparse ones —
   * a reference this graph offers that a given run did not use.
   *
   * The two clip cases with the soundtrack on and off are the pair worth having
   * here: they differ by one deleted input on a node whose other input stays
   * wired, which is exactly the shape of deletion that goes wrong quietly.
   */
  finalizeCases: [
    /**
     * The passes. Each count is a different graph, and the soundtrack branch
     * doubles them again — a track that covers the video becomes the sound, one
     * that does not leaves the passes' own audio joined instead.
     */
    {
      name: "two passes following a clip",
      values: {
        reference_image_1: "a.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        [CLIP_SECONDS_PARAM]: 30,
        duration: 30,
      },
    },
    {
      name: "four passes following a clip",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        [CLIP_SECONDS_PARAM]: 60,
        duration: 58,
      },
    },
    {
      name: "four passes following a clip whose length nothing measured",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: false,
        duration: 58,
      },
    },
    {
      name: "passes over a track long enough to become the soundtrack",
      values: {
        reference_image_1: "a.png",
        [AUDIO_PARAM]: "song.mp3",
        [TRACK_SECONDS_PARAM]: 90,
        duration: 40,
      },
    },
    {
      name: "passes over a track too short to cover the video",
      values: {
        reference_image_1: "a.png",
        [AUDIO_PARAM]: "song.mp3",
        [TRACK_SECONDS_PARAM]: 10,
        duration: 40,
      },
    },
    {
      name: "passes over a whole track, which keeps its per-pass trims",
      values: {
        reference_image_1: "a.png",
        [AUDIO_PARAM]: "song.mp3",
        [TRACK_SECONDS_PARAM]: 90,
        [TRIM_PARAM]: TRIM_WHOLE,
        duration: 40,
      },
    },
    {
      name: "passes over a clip and a track at once",
      values: {
        reference_image_1: "a.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        [CLIP_SECONDS_PARAM]: 40,
        [AUDIO_PARAM]: "song.mp3",
        [TRACK_SECONDS_PARAM]: 90,
        duration: 40,
      },
    },
    {
      name: "four passes with the rewrite switched off",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        [CLIP_SECONDS_PARAM]: 60,
        duration: 58,
        [LITERAL_PROMPT]: true,
      },
    },
    {
      name: "a long video with nothing that varies over it",
      values: { reference_image_1: "a.png", duration: 40 },
      rejects: "same shot repeated",
    },
    {
      name: "a picture and nothing else",
      values: { reference_image_1: "a.png" },
    },
    {
      name: "a picture and a clip with its sound",
      values: {
        reference_image_1: "a.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
      },
    },
    {
      name: "a picture and a clip without its sound",
      values: {
        reference_image_1: "a.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: false,
      },
    },
    {
      name: "a clip and no pictures",
      values: { [VIDEO_PARAM]: "clip.mp4", [VIDEO_AUDIO_PARAM]: true },
    },
    {
      name: "a track and no pictures",
      values: { [AUDIO_PARAM]: "song.mp3" },
    },
    {
      name: "every reference at once",
      values: {
        reference_image_1: "a.png",
        reference_image_2: "b.png",
        reference_image_3: "c.png",
        reference_image_4: "d.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        [AUDIO_PARAM]: "song.mp3",
      },
    },
    {
      name: "a clip with the rewrite switched off",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        literal_prompt: true,
      },
    },
    {
      name: "no reference of any kind",
      values: {},
      rejects: "needs at least one to build from",
    },
  ],

  finalize(graph, values) {
    /**
     * The passes, before anything else — every branch below writes the
     * reference node, and past one pass there are several of them.
     */
    const { count: chunks, frames } = refChunkPlan(values);
    const refNodes = Array.from({ length: chunks }, (_, i) =>
      chunkId(REFERENCE_NODE, i),
    );

    /**
     * Asking for a long video with nothing that varies over it.
     *
     * Refused rather than clamped, because clamping would hand back a fifteen
     * second video to someone who asked for a minute and say nothing. Named
     * against the duration because that is the control to move — the other way
     * out is to attach a clip or a track, which the message says.
     */
    if (chunks === 1 && !hasMovingReference(values) && outputSeconds(values) > MAX_CHUNK_SECONDS / MAX_CHUNKS) {
      throw new ParamError(
        `Past ${Math.floor(MAX_CHUNK_SECONDS / MAX_CHUNKS)}s this is built in passes, and pictures alone are the same in every one of them — so it would come back as the same shot repeated. Add a reference clip or a reference track for the passes to follow, or shorten the video.`,
        "duration",
      );
    }

    // Everything past the passes this run needs, and the reassembly it would
    // have fed. Done before the pruning below so that what follows only ever
    // sees stacks that are staying.
    for (let index = chunks; index < MAX_CHUNKS; index += 1) {
      for (const base of [...CHUNK_NODES, ...CHUNK_VIDEO_NODES, TRIM_NODE]) {
        delete graph[chunkId(base, index)];
      }
      delete graph[JOIN_IMAGES_NODE].inputs[`images.image${index}`];
    }
    for (let join = Math.max(0, chunks - 1); join < MAX_CHUNKS - 1; join += 1) {
      delete graph[audioJoinId(join)];
    }

    // What each pass covers: its share of the running time, and — where a clip
    // or a track is attached — its own slice of them. The clip's filename is
    // copied across because only pass 0's loader is a param target.
    if (chunks > 1) {
      const share = frames / CHUNK_FPS;
      // Read before the loop, because the loop overwrites pass 0's copy.
      const trimStart = Number(graph[TRIM_NODE]?.inputs.start_index ?? 0);
      const clipFrames = Math.ceil(clipSeconds(values) * CHUNK_FPS);
      const clipShare = Math.max(
        1,
        Math.min(REF_BUDGET_SECONDS * CHUNK_FPS, Math.ceil(clipFrames / chunks)),
      );
      for (let index = 0; index < chunks; index += 1) {
        graph[chunkId(DURATION_NODE, index)].inputs.value = share;

        const loader = graph[chunkId(VIDEO_NODE, index)];
        if (loader) {
          loader.inputs.video = graph[VIDEO_NODE].inputs.video;
          loader.inputs.skip_first_frames = index * clipShare;
          // The last pass keeps the budget as its cap, so it runs to the end of
          // the clip whatever the browser measured — the same guard Remix makes,
          // for the same untrustworthy number.
          loader.inputs.frame_load_cap =
            index === chunks - 1 ? REF_BUDGET_SECONDS * CHUNK_FPS : clipShare;
        }
        const trim = graph[chunkId(TRIM_NODE, index)];
        if (trim) {
          // Its own span of the track, not the whole video's: the param writes
          // pass 0's duration as the length of the finished video, which is
          // right for one pass and four times too long for four.
          trim.inputs.start_index = trimStart + index * share;
          trim.inputs.duration = share;
        }
      }
    }

    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      for (const node of refNodes) delete graph[node].inputs[refInput(index)];
      delete graph[BATCH_NODE].inputs[batchInput(index)];
      delete graph[REF_NODES[index - 1]];
    }

    // The reference clip, and the four nodes that serve it.
    //
    // Its frames go into the first batch slot past the pictures that survived
    // above, so the director sees them after the pictures however many of those
    // there were. Written here rather than declared on the node because which
    // slot that is depends on the submission.
    if (videoAttached(values)) {
      graph[BATCH_NODE].inputs[batchInput(filled + 1)] = [VIDEO_PEEK_NODE, 0];
      // The soundtrack is the one part of the clip that is optional. Dropping
      // the input leaves the frames wired and the audio unsent, which is
      // exactly "the movement and none of the sound".
      // Only the input goes. The loader stays either way: it is where the
      // frames come from as well as the sound.
      if (!videoAudioAttached(values)) {
        for (const node of refNodes) delete graph[node].inputs[VIDEO_AUDIO_INPUT];
      }
    } else {
      for (const node of refNodes) {
        delete graph[node].inputs[VIDEO_INPUT];
        delete graph[node].inputs[VIDEO_AUDIO_INPUT];
      }
      for (let index = 0; index < chunks; index += 1) {
        delete graph[chunkId(VIDEO_NODE, index)];
        delete graph[chunkId(VIDEO_SCALE_NODE, index)];
      }
      delete graph[VIDEO_PEEK_NODE];
      delete graph[VIDEO_STRIDE_NODE];
    }

    // With nothing to look at there is nothing to batch, and a BatchImagesNode
    // with no inputs is not an empty batch — it is a node that cannot produce
    // the IMAGE its consumer is asking for. So the batch goes and the director
    // loses its picture.
    //
    // Which leaves a node that has to stop being a `DescribeImage`, since
    // `image` is a *required* input on that class and a graph missing one is
    // refused before it runs. `applyTextOnlyRewrite` does that conversion,
    // afterwards and centrally — it is the same conversion a text-only rewrite
    // model asks for, and a director with no picture is in exactly that
    // position however it got there.
    //
    // Only reachable because a track can stand in for the first picture. A run
    // with a clip and no pictures still has a batch — of the clip's frames.
    if (filled === 0 && !videoAttached(values)) {
      delete graph[ids.director].inputs[REWRITE_IMAGE_INPUT];
      delete graph[BATCH_NODE];
    }

    // The track goes the same way as an unused picture, and for the same
    // reason: a LoadAudio with an empty filename fails validation, and a
    // variadic input left in place tells H3 to expect a reference that was
    // never supplied.
    if (!trackAttached(values)) {
      for (const node of refNodes) delete graph[node].inputs[AUDIO_INPUT];
      delete graph[AUDIO_NODE];
      for (let index = 0; index < chunks; index += 1) {
        delete graph[chunkId(TRIM_NODE, index)];
      }
    } else if (String(values[TRIM_PARAM] ?? TRIM_MATCH) === TRIM_WHOLE) {
      // All of it is the trim *removed* rather than the trim set to the track's
      // length: how long the file runs is not a number this app has — nothing
      // has opened it, and the browser never sees the bytes for a track that
      // arrived through Create video.
      //
      // Past one pass it stays, because each pass is then reading its own span
      // of the track rather than all of it, and the spans are what the trims
      // are for. See the start offsets written above.
      if (chunks === 1) {
        graph[REFERENCE_NODE].inputs[AUDIO_INPUT] = [AUDIO_NODE, 0];
        delete graph[TRIM_NODE];
      }
    }

    /**
     * The check that `required` cannot make, because it is about two controls
     * rather than one. Everything downstream of the reference node — the
     * subject definitions, the retention analysis, the sampler itself — is
     * built around something to hold on to, and a run with neither a picture
     * nor a track is a text-to-video run made on the wrong graph.
     *
     * Here rather than in a param because this is the first place both answers
     * are known, and it throws the same ParamError the coercion would, so it
     * reaches the form the same way any other rejected value does.
     */
    if (filled === 0 && !trackAttached(values) && !videoAttached(values)) {
      throw new ParamError(
        "Add a reference image, a reference clip or a reference track — this workflow needs at least one to build from.",
        "reference_image_1",
      );
    }

    /**
     * A start past the end of the track, which is the one way the trim node
     * fails: it clamps a start to the length of the audio and then raises
     * because there is nothing between the start and the end.
     *
     * Rejected here rather than clamped, because clamping would silently hand
     * the model a different part of the song than the one that was asked for,
     * and this is a number someone typed. Only decidable when the browser has
     * measured the track — with no measurement it is passed through, which is
     * what every run did before there was a start control at all.
     */
    const start = startSeconds(values);
    const length = trackSeconds(values);
    if (graph[TRIM_NODE] && length > 0 && start >= length) {
      throw new ParamError(
        `The track is ${length.toFixed(1)} seconds long, so it has nothing at ${start}s to start from.`,
        TRIM_START_PARAM,
      );
    }

    /**
     * The reassembly, or its removal.
     *
     * A single pass is the graph this workflow has always queued — the join
     * nodes go and the output reads the one decode pair — so everything below
     * is what happens only past fifteen seconds.
     */
    if (chunks === 1) {
      delete graph[JOIN_IMAGES_NODE];
      delete graph[JOIN_TRACK_NODE];
      return;
    }

    graph[VIDEO_OUT_NODE].inputs.images = [JOIN_IMAGES_NODE, 0];

    /**
     * Which soundtrack the finished video gets.
     *
     * The reference track wins wherever it covers the whole video, because it
     * is the only sound in this graph that was continuous before anything was
     * generated — the same reason Remix takes a clip's own audio. It has to
     * *cover* it: a track shorter than the video would run out partway and
     * leave the rest silent, which is worse than a seam.
     *
     * Failing that, the passes' own soundtracks are joined end to end. Each was
     * invented from nothing and they have no relation to each other, so this is
     * the case where the seams are audible. It is the honest fallback rather
     * than a good outcome, and the help on the duration control says so.
     */
    const seconds = outputSeconds(values);
    const trackCovers = trackAttached(values) && length > 0 && length - start >= seconds;
    // The clip's own sound, where it was attached and reaches the end of the
    // video. Each pass's loader already carries exactly its own span of it, so
    // the joins below rebuild the whole track by reading the loaders instead of
    // the decodes — the same span-by-span reassembly Remix does, and the reason
    // its seams are inaudible.
    const clipCovers =
      !trackCovers &&
      videoAudioAttached(values) &&
      clipSeconds(values) >= seconds;

    if (trackCovers || clipCovers) {
      if (trackCovers) {
        graph[JOIN_TRACK_NODE].inputs.audio = [AUDIO_NODE, 0];
        graph[JOIN_TRACK_NODE].inputs.start_index = start;
      } else {
        for (let join = 0; join < chunks - 1; join += 1) {
          graph[audioJoinId(join)].inputs.audio1 =
            join === 0 ? [chunkId(VIDEO_NODE, 0), 2] : [audioJoinId(join - 1), 0];
          graph[audioJoinId(join)].inputs.audio2 = [chunkId(VIDEO_NODE, join + 1), 2];
        }
        graph[JOIN_TRACK_NODE].inputs.audio = [audioJoinId(chunks - 2), 0];
        graph[JOIN_TRACK_NODE].inputs.start_index = 0;
      }
      // Cut to the video rather than to the source, so a track or a clip that
      // runs past the end does not leave audio hanging off it.
      graph[JOIN_TRACK_NODE].inputs.duration = seconds;
      graph[VIDEO_OUT_NODE].inputs.audio = [JOIN_TRACK_NODE, 0];

      // Nothing reads what the passes invented any more.
      for (let index = 0; index < chunks; index += 1) {
        delete graph[chunkId(DECODE_AUDIO_NODE, index)];
      }
      if (trackCovers) {
        for (let join = 0; join < chunks - 1; join += 1) delete graph[audioJoinId(join)];
      }
      return;
    }

    /**
     * Nothing continuous to fall back on, so the passes' own soundtracks are
     * joined end to end.
     *
     * Each was invented from nothing and none of them knows the others, so this
     * is the one path here with an audible seam. It is reachable with pictures
     * and a short track, or a clip whose sound was left off — the duration's
     * help says as much, and attaching a track that covers the video is the way
     * out of it.
     */
    delete graph[JOIN_TRACK_NODE];
    graph[VIDEO_OUT_NODE].inputs.audio = [audioJoinId(chunks - 2), 0];
  },
};
