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
  FRAME_EXPRESSION,
  directorBypassFor,
  effectiveSeconds,
  directorTarget,
  durationParam,
  REFERENCE_DIRECTOR,
  TRACK_WORDS,
  VOICE_WORDS,
  audioKeepHidesWords,
  audioKeepReusesWords,
  audioLabels,
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
  referenceVoice,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 reference-to-video: up to four reference images steer the subject,
 * and the prompt says what they do.
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
 * - `ref_audios` takes **two** standalone recordings, and they are for different
 *   things. `ref_audio_0` is a music track, through the trim at 167 from the
 *   loader at 155; `ref_audio_1` is a voice reference, through 168 from 156.
 *   A score plays under the scene and nobody on screen produces it; a voice
 *   belongs to somebody in the picture and gets a speaker ID. Both can be
 *   attached at once — the node takes three — and the director is told which
 *   `<Audio N>` each one is, by `audioLabels`.
 *
 *   Same variadic form as the images and the same rule: unused means removed,
 *   not blank, *and* the survivors are renumbered so there is no hole. A voice
 *   with no track ships as `ref_audio_0`. See `finalize`, which rebuilds the
 *   list rather than patching it.
 *
 *   The track is what the Create video button on a finished song fills in — see
 *   `clipTarget` — and between them they are the reason this graph, alone among
 *   the H3 ones, has a LoadAudio in it. What reaches the model is a window of
 *   each: as many seconds of the track as the video is long, unless the form
 *   says otherwise, and a fixed `VOICE_TRIM_DEFAULT` of the voice, because how
 *   long the video runs says nothing about how much recording it takes to
 *   establish how somebody sounds.
 * - **Any of the three pins the run to four steps**, four steps loads a
 *   different diffusion model and text encoder from the rest of the range, and
 *   four steps without the distilled LoRA is refused rather than run. See
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
const BATCH_NODE = "146";
const AUDIO_NODE = "155";
const TRIM_NODE = "167";
const AUDIO_PARAM = "reference_audio";

/**
 * The second standalone audio slot: a recording of a voice.
 *
 * A separate slot rather than a purpose select on the one above, because the
 * node takes three standalone audios and numbers them in wiring order, so both
 * can be attached to the same run — a score under the scene and a voice for the
 * person in it are not two settings of one control. See `referenceVoice` for
 * why the director cannot be left to read one slot two ways.
 *
 * Its own loader and its own trim, mirroring the track's, because the two are
 * cut differently: a score is taken to the length of the video it plays under,
 * and a voice is an exemplar whose useful length has nothing to do with the
 * video at all. See `VOICE_TRIM_DEFAULT`.
 */
const VOICE_NODE = "156";
const VOICE_TRIM_NODE = "168";
const VOICE_PARAM = "reference_voice";
const VOICE_KEEP_PARAM = "reference_voice_keep";
const VOICE_WORDS_PARAM = "reference_voice_words";
const VOICE_START_PARAM = "reference_voice_start";
const VOICE_SECONDS_PARAM = "reference_voice_seconds";
const VOICE_TRACK_SECONDS_PARAM = "reference_voice_length";

/**
 * What a voice reference is for, unless the user says otherwise.
 *
 * "Same voices, new words" is the answer this slot exists to make reachable —
 * MiniMax's own voice referencing, where the recording guides timbre and
 * delivery and the lines come from the prompt. Attaching a voice at all is a
 * choice to use it for that; the other answers are there for the run that also
 * wants what was said.
 */
const VOICE_KEEP_DEFAULT = "voice" as const;

/**
 * How many seconds of the voice reference the model gets, by default.
 *
 * Not the length of the video, which is what the music track uses and what
 * would be wrong here. A score plays *under* the video and matching the two is
 * the point; a voice is an exemplar of how somebody sounds, and how long the
 * video runs says nothing about how much of a recording it takes to establish
 * that. Ten sits inside MiniMax's documented 2-15s for a reference audio with
 * room at both ends, and a shorter file simply stops where it stops —
 * `TrimAudioDuration` past the end of the audio is not an error.
 */
const VOICE_TRIM_DEFAULT = 10;

/** The variadic slots the two standalone audios take, before `finalize` compacts. */
const audioInput = (index: number) => `ref_audios.ref_audio_${index}`;
const AUDIO_INPUT = audioInput(0);
const VOICE_INPUT = audioInput(1);

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

/** Whether this run has a voice reference. */
const voiceAttached = (values: Record<string, ParamValue>): boolean =>
  String(values[VOICE_PARAM] ?? "").trim() !== "";

/**
 * Whether this run reuses what was said in the voice reference.
 *
 * Only two of the five answers do. On the other three the words control is
 * hidden and its contents withheld, because a transcript of lines the rest of
 * the brief says to replace is the prompt arguing with itself — the same rule,
 * and the same helper, as Remix's clip.
 */
const keepsVoiceSpeech = (values: Record<string, ParamValue>): boolean =>
  audioKeepReusesWords(values, VOICE_KEEP_PARAM, VOICE_KEEP_DEFAULT);

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
 * What every piece of attached audio is called this run.
 *
 * One resolver, read by all three appendices that name a recording, so the
 * number the director is given is the number the reference node actually
 * assigned. See `audioLabels` — and `finalize`, which compacts the variadic
 * slots so the wiring order this assumes is the wiring order that ships.
 */
const labelsFor = (values: Record<string, ParamValue>) =>
  audioLabels({
    soundtrack: videoAudioAttached(values),
    track: trackAttached(values),
    voice: voiceAttached(values),
  });

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
  // Every reference that is not a still. A voice reference is a standalone
  // audio on the same variadic input the track uses, so it is the same
  // conditioning block and the same reason for the same weights.
  whenSet: [AUDIO_PARAM, VOICE_PARAM, VIDEO_PARAM],
  value: 4,
  note: "A reference track, voice or clip pins this to 4 — the step count the bf16 model pair and the pack's own sampler take one at. Turbo has to stay on: four steps without the distilled LoRA is not a usable take, so the run is refused rather than wasted.",
  /**
   * And the switch that makes four steps mean anything.
   *
   * The pin swaps the sampler and the weights but not the distilled LoRA, which
   * is a mode rather than a param — so until this existed, turning Turbo off
   * and attaching a track produced a four-step run with no LoRA under it, which
   * is the one combination this graph has always described as not a usable
   * take. It finished, it took the time, and it came back wrong, which is worse
   * than being refused.
   */
  requiresTurbo:
    "Four steps needs the distilled LoRA under it. Turn Turbo back on, or take the reference track, voice or clip off to run at a step count that works without it.",
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

/**
 * The same three for the voice reference's own trim.
 *
 * Separate functions rather than the track's taking a parameter, because only
 * the shape is shared: the track's length answer reads a select and can mean
 * "as long as the video", and this one is always a number of seconds. Folding
 * them together would put a branch in this one that can never be taken.
 */
const voiceStartSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[VOICE_START_PARAM] ?? 0));

const voiceTrimSeconds = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[VOICE_SECONDS_PARAM] ?? VOICE_TRIM_DEFAULT));

/** How long the loaded voice reference runs, or 0 for "nothing measured it". */
const voiceLength = (values: Record<string, ParamValue>): number =>
  Math.max(0, Number(values[VOICE_TRACK_SECONDS_PARAM] ?? 0));

/** How each slot names its input on those two nodes. Slot 1 is index 0. */
const refInput = (index: number) => `ref_images.ref_image_${index - 1}`;
const batchInput = (index: number) => `images.image${index - 1}`;

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

      // The two references that are not pictures, both through a trim rather
      // than straight off their loaders. Each goes, with its loader and its
      // trim, on any run that does not have it — and the one that survives
      // alone moves up into slot 0, because a variadic input left with a hole
      // in it is not the same list of references. See `finalize`.
      //
      // Two slots rather than one control read two ways: `ref_audios` takes up
      // to three and numbers them in wiring order, so a score and a voice can
      // both be attached, and the director is told which <Audio N> each is.
      "ref_audios.ref_audio_0": ["167", 0],
      "ref_audios.ref_audio_1": ["168", 0],
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

  // The voice reference, and its own trim.
  //
  // The same two node classes as the track above, wired the same way, and
  // deliberately not shared with it: what the two slots are for differs in the
  // one thing a trim decides. The track is cut to the length of the video it
  // plays under, because that is what a score does. A voice is an exemplar of
  // how someone sounds, and the video's length says nothing about how much
  // recording it takes to establish that — so this one takes a fixed window,
  // `VOICE_TRIM_DEFAULT`, from wherever the form says to start.
  //
  // Both inputs are written per run by the controls below, each producing the
  // whole answer, for the same reason the track's two do: a target write is an
  // assignment.
  "156": {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio (Voice)" },
  },
  "168": {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: ["156", 0],
      start_index: 0,
      duration: VOICE_TRIM_DEFAULT,
    },
    _meta: { title: "Trim Audio Duration (Voice)" },
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

/**
 * And the same pair for the voice reference.
 *
 * Gated, unlike the track's, because this slot has an answer that *replaces*
 * what was said. On "same voices, new words" — which is what a voice reference
 * is normally for — a transcript of the old lines is the prompt carrying
 * exactly what the rest of the brief says to write anew. Remix's clip has the
 * same problem and the same gate.
 */
const voiceWords = wordsBlocks({
  sourceParam: VOICE_PARAM,
  wordsParam: VOICE_WORDS_PARAM,
  source: VOICE_WORDS,
  when: (values) => keepsVoiceSpeech(values),
});

const director = directorTarget(ids, REFERENCE_DIRECTOR, [
  // The pictures speak first, then the clip — the order the two arrive in the
  // batch the director is shown, so the instructions read in the same order as
  // the images they describe.
  referenceFacets(REF_NODES.length, { otherVisualReference: videoAttached }),
  referenceVideo({
    videoParam: VIDEO_PARAM,
    audioParam: VIDEO_AUDIO_PARAM,
    keepParam: VIDEO_KEEP_PARAM,
    slots: REF_NODES.length,
    labelsFor,
  }),
  // Then the two standalone recordings, in the order the node numbers them, so
  // the brief reads in the same order as the references it describes.
  referenceTrack(AUDIO_PARAM, labelsFor),
  referenceVoice({ voiceParam: VOICE_PARAM, labelsFor }),
  words.director,
  voiceWords.director,
  // Last, so they land after everything else that speaks for the sound. One
  // per recording that has a "what to keep" control, each naming its own
  // <Audio N> — a marker on the wrong label is a rule about a reference the
  // model was not given.
  audioKeep({
    param: VIDEO_AUDIO_KEEP_PARAM,
    // Unlike Remix, a clip here is a reference rather than the thing being
    // rebuilt, so its sound is a mood by default rather than a track to reuse.
    fallback: VIDEO_AUDIO_KEEP_DEFAULT,
    attached: videoAudioAttached,
    label: (values) => labelsFor(values).soundtrack ?? "<Audio 1>",
  }),
  audioKeep({
    param: VOICE_KEEP_PARAM,
    fallback: VOICE_KEEP_DEFAULT,
    attached: voiceAttached,
    label: (values) => labelsFor(values).voice ?? "<Audio 1>",
    // The answers are written for a soundtrack, and this slot holds a voice on
    // its own. See `about`.
    about:
      "This recording is a voice and nothing else — not a soundtrack. Where the answer above speaks of music and room tone carrying over, there is none in this file to carry: what it has is somebody speaking or singing, and the answer decides only whether their words come across with their voice. The score and the ambience of this video are written from the user's text either way.",
  }),
]);

/**
 * The prompt text, which on this graph is written by three controls.
 *
 * The words of an attached recording go into the prompt itself rather than only
 * into the director's brief, because the prompt is what reaches H3 either way —
 * see `promptTarget`. One target object, shared by all of them, so they cannot
 * disagree about what they are writing.
 */
const promptText = promptTarget(ids, [words.prompt, voiceWords.prompt]);

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
    // Named for what it is now that a voice has a slot of its own. The two sit
    // next to each other in the same section and both take an audio file, so
    // the label is the only thing telling them apart.
    label: "Reference track (music)",
    type: "audio",
    default: "",
    compact: true,
    help: "Optional. A score to play under the scene — for a voice, use the slot below. Pins the run to 4 steps. Only as much of it as the video is long is sent — see below.",
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

  /**
   * The second standalone audio slot: a recording of how somebody sounds.
   *
   * The track above is a score — it plays under the scene and nobody on screen
   * produces it. This is the other thing a recording can be for, and the two
   * are wired to different `ref_audios` slots rather than being one control
   * with a purpose select, because the model takes both at once and the
   * director has to be told which <Audio N> is which. See `referenceVoice`.
   *
   * Not `measures`-free: the trim's start has to land inside the file for the
   * same reason the track's does — `TrimAudioDuration` raises when a start
   * leaves nothing behind it — so the browser reports the length it already
   * reads off the loaded player.
   */
  {
    id: VOICE_PARAM,
    label: "Voice reference",
    type: "audio",
    default: "",
    // A row until asked for, like the clip and the track. The picture is what
    // this workflow is named after and keeps its drop target.
    compact: true,
    help: "Optional. A recording of how someone sounds, for a person in the video to speak or sing with. Pins the run to 4 steps. MiniMax documents a reference at 2–15 seconds.",
    group: "References",
    // Its own wording: the Create video hand-off fills the music slot and not
    // this one, so the default caption would point at a button that never
    // arrives here.
    noun: "voice recording",
    limitNote: "Up to 4 MB. A few clean seconds of speech is enough.",
    measures: VOICE_TRACK_SECONDS_PARAM,
    targets: [
      { node: VOICE_NODE, input: "audio" },
      // The director is told what it is, whose voice it becomes, and which
      // <Audio N> to cite. See referenceVoice.
      director,
    ],
  },
  audioKeepParam(director, {
    id: VOICE_KEEP_PARAM,
    label: "What to keep from the voice",
    fallback: VOICE_KEEP_DEFAULT,
    revealedBy: VOICE_PARAM,
    help: "Voice referencing is the default: the recording guides the timbre and the delivery, and the lines come from your prompt. Turn it up to reuse what was actually said.",
  }),
  {
    id: VOICE_TRACK_SECONDS_PARAM,
    label: "Voice reference length",
    type: "measured",
    // Nothing measured yet, which every reader treats as "unknown" rather than
    // as an empty file — a form can be submitted before the player has its
    // metadata. Same contract as the track's.
    default: 0,
    group: "References",
    targets: [
      {
        node: VOICE_TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => voiceStartSeconds(values),
      },
    ],
  },
  {
    id: VOICE_START_PARAM,
    label: "Start at",
    type: "number",
    default: 0,
    min: 0,
    max: 3600,
    step: 0.5,
    unit: "sec",
    help: "Where in the recording the reference is taken from. Worth moving past a silent or noisy opening — the model hears only what this window covers.",
    group: "References",
    revealedBy: VOICE_PARAM,
    targets: [
      {
        node: VOICE_TRIM_NODE,
        input: "start_index",
        transform: (_value, values) => voiceStartSeconds(values),
      },
    ],
  },
  {
    id: VOICE_SECONDS_PARAM,
    label: "Seconds to use",
    type: "slider",
    default: VOICE_TRIM_DEFAULT,
    min: 1,
    max: 15,
    step: 0.5,
    unit: "sec",
    // Not "as long as the video", which is the track's default and the one
    // thing about a score that does not transfer to a voice. See
    // VOICE_TRIM_DEFAULT.
    help: "How much to take from the start point. Nothing to do with how long the video is — this is how much of the voice the model gets to learn from. Past the end of the file simply stops there.",
    group: "References",
    revealedBy: VOICE_PARAM,
    targets: [
      {
        node: VOICE_TRIM_NODE,
        input: "duration",
        transform: (_value, values) => voiceTrimSeconds(values),
      },
    ],
  },
  wordsParam({
    id: VOICE_WORDS_PARAM,
    label: "Words in the voice reference",
    help: "What is actually said in the recording. Only needed while those words are being reused — with the default, the lines come from your prompt and the recording supplies only the voice.",
    group: "References",
    // Speech rather than a lyric sheet: a section tag here would be structure
    // the director is told to keep out of anyone's mouth, in a box whose usual
    // contents are a spoken line.
    placeholder: "the line as it is spoken",
    revealedBy: VOICE_PARAM,
    // And stood down again on the three answers that write new words. The
    // default is one of them, so this is normally out of the way. See
    // `keepsVoiceSpeech`.
    hiddenBy: audioKeepHidesWords(VOICE_KEEP_PARAM),
    targets: [promptText, director],
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

  durationParam(ids, director),
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
  /**
   * Every case carrying a reference that is not a still declares `mode`, because
   * every one of those pins the steps to four and four steps is refused without
   * turbo — see `TRACK_PINS_STEPS.requiresTurbo`. A case left in standard mode
   * would be checking that `finalize` survives a run the app does not allow.
   */
  finalizeCases: [
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
      mode: { turbo: true },
    },
    {
      name: "a picture and a clip without its sound",
      values: {
        reference_image_1: "a.png",
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: false,
      },
      mode: { turbo: true },
    },
    {
      name: "a clip and no pictures",
      values: { [VIDEO_PARAM]: "clip.mp4", [VIDEO_AUDIO_PARAM]: true },
      mode: { turbo: true },
    },
    {
      name: "a track and no pictures",
      values: { [AUDIO_PARAM]: "song.mp3" },
      mode: { turbo: true },
    },

    /**
     * The voice slot, and the pair that matters most for it.
     *
     * A voice with no track is the case the compaction exists for: the voice is
     * declared on `ref_audio_1` and has to ship as `ref_audio_0`, with the
     * track's loader and trim gone. A voice *with* a track is the other order —
     * both slots filled, numbered as declared — and the two together are what
     * prove the list is rebuilt rather than patched.
     */
    {
      name: "a picture and a voice",
      values: { reference_image_1: "a.png", [VOICE_PARAM]: "voice.wav" },
      mode: { turbo: true },
    },
    {
      name: "a voice and no pictures",
      values: { [VOICE_PARAM]: "voice.wav" },
      mode: { turbo: true },
    },
    {
      name: "a picture, a music track and a voice",
      values: {
        reference_image_1: "a.png",
        [AUDIO_PARAM]: "song.mp3",
        [VOICE_PARAM]: "voice.wav",
      },
      mode: { turbo: true },
    },
    {
      name: "a voice whose words are being reused",
      values: {
        reference_image_1: "a.png",
        [VOICE_PARAM]: "voice.wav",
        [VOICE_KEEP_PARAM]: "exact",
        [VOICE_WORDS_PARAM]: "The line as it is spoken.",
      },
      mode: { turbo: true },
    },
    {
      name: "a voice with the whole track sent beside it",
      values: {
        [AUDIO_PARAM]: "song.mp3",
        [TRIM_PARAM]: TRIM_WHOLE,
        [VOICE_PARAM]: "voice.wav",
      },
      mode: { turbo: true },
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
        [VOICE_PARAM]: "voice.wav",
      },
      mode: { turbo: true },
    },
    {
      name: "a clip with the rewrite switched off",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [VIDEO_AUDIO_PARAM]: true,
        literal_prompt: true,
      },
      mode: { turbo: true },
    },
    {
      name: "no reference of any kind",
      values: {},
      rejects: "needs at least one to build from",
    },
    /**
     * And the combination the pin now refuses outright: a reference that is not
     * a still, in standard mode. Declared as a case because it is a rule about
     * what this graph will run, and a rule with no case behind it is one that
     * can be deleted without anything noticing.
     */
    {
      name: "a voice with turbo switched off",
      values: { reference_image_1: "a.png", [VOICE_PARAM]: "voice.wav" },
      rejects: "Four steps needs the distilled LoRA",
    },
  ],

  finalize(graph, values) {
    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      delete graph[REFERENCE_NODE].inputs[refInput(index)];
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
        delete graph[REFERENCE_NODE].inputs[VIDEO_AUDIO_INPUT];
      }
    } else {
      delete graph[REFERENCE_NODE].inputs[VIDEO_INPUT];
      delete graph[REFERENCE_NODE].inputs[VIDEO_AUDIO_INPUT];
      delete graph[VIDEO_NODE];
      delete graph[VIDEO_SCALE_NODE];
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

    /**
     * The two standalone audios, which go the same way as an unused picture and
     * for the same reason: a LoadAudio with an empty filename fails validation,
     * and a variadic input left in place tells H3 to expect a reference that was
     * never supplied.
     *
     * Rebuilt rather than patched, because with two of them the slot *numbers*
     * are no longer fixed. `ref_audio_0` and `ref_audio_1` are a list, not two
     * named inputs — the same variadic form as the pictures, under the same rule
     * `leadingReferences` exists for. A run with a voice and no track has to
     * hand the voice over as `ref_audio_0`; left in slot 1 with a hole in front
     * of it, what the model is told is that it has two standalone references and
     * the first of them is missing.
     *
     * Which is also the order `labelsFor` assumes when it tells the director
     * what to call each one, so the two have to be built from the same list.
     */
    for (const input of [AUDIO_INPUT, VOICE_INPUT]) {
      delete graph[REFERENCE_NODE].inputs[input];
    }

    /** What each surviving slot reads from, in the order they are wired. */
    const standalone: string[] = [];

    if (trackAttached(values)) {
      // All of it is the trim *removed* rather than the trim set to the track's
      // length: how long the file runs is not a number this app has — nothing
      // has opened it, and the browser never sees the bytes for a track that
      // arrived through Create video.
      const whole = String(values[TRIM_PARAM] ?? TRIM_MATCH) === TRIM_WHOLE;
      standalone.push(whole ? AUDIO_NODE : TRIM_NODE);
      if (whole) delete graph[TRIM_NODE];
    } else {
      delete graph[AUDIO_NODE];
      delete graph[TRIM_NODE];
    }

    if (voiceAttached(values)) {
      // No "all of it" here: a voice reference is always a window, so the trim
      // is never removed. See VOICE_TRIM_DEFAULT.
      standalone.push(VOICE_TRIM_NODE);
    } else {
      delete graph[VOICE_NODE];
      delete graph[VOICE_TRIM_NODE];
    }

    standalone.forEach((source, index) => {
      graph[REFERENCE_NODE].inputs[audioInput(index)] = [source, 0];
    });

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
    if (
      filled === 0 &&
      !trackAttached(values) &&
      !videoAttached(values) &&
      !voiceAttached(values)
    ) {
      throw new ParamError(
        "Add a reference image, a reference clip, a reference track or a voice reference — this workflow needs at least one to build from.",
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

    // And the same for the voice reference, which has the same trim node under
    // it and so fails in exactly the same way.
    const voiceStart = voiceStartSeconds(values);
    const voiceRuns = voiceLength(values);
    if (graph[VOICE_TRIM_NODE] && voiceRuns > 0 && voiceStart >= voiceRuns) {
      throw new ParamError(
        `The voice reference is ${voiceRuns.toFixed(1)} seconds long, so it has nothing at ${voiceStart}s to start from.`,
        VOICE_START_PARAM,
      );
    }
  },
};
