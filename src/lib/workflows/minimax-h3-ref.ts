import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  directorTarget,
  durationParam,
  REFERENCE_DIRECTOR,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  leadingReferences,
  promptParam,
  referenceFacets,
  referenceSlot,
  referenceTrack,
  samplingParams,
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
 * - `ref_audios.ref_audio_0` takes a track, from node 155. Same variadic form
 *   as the images and the same rule: unused means removed, not blank. It is
 *   what the Create video button on a finished track fills in — see
 *   `clipTarget` — and the reason this graph, alone among the H3 ones, has a
 *   LoadAudio in it.
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
const AUDIO_INPUT = "ref_audios.ref_audio_0";
const AUDIO_PARAM = "reference_audio";
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
      // The one reference that is not a picture. Removed with its loader on
      // every run that has no track — see `finalize`.
      "ref_audios.ref_audio_0": ["155", 0],
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
  // references so the rewrite can see them, 145 expands the two into the
  // description node 136 actually reads. The api_key is "-" as exported: the
  // ComfyUI host supplies the real one.
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
      // video's length — H3's format needs it to place shot cut times.
      system_prompt: REFERENCE_DIRECTOR,
      client: ["144", 0],
      images: ["146", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },
  "146": {
    class_type: "BatchImagesNode",
    // Variadic, like ref_images above: an unused slot's input is removed
    // outright rather than left pointing at a deleted node.
    inputs: {
      "images.image0": ["137", 0],
      "images.image1": ["139", 0],
      "images.image2": ["165", 0],
      "images.image3": ["166", 0],
    },
    _meta: { title: "Batch Images" },
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
};

/**
 * Everything that shapes the director's instructions writes this one target,
 * built once here so the duration and every facet select cannot disagree about
 * what it is. See `directorTarget` for why they all write the whole thing.
 *
 * The appendix is told how many slots this graph wires; it reads the submitted
 * values to find out how many actually have an image in them.
 */
const director = directorTarget(ids, REFERENCE_DIRECTOR, [
  referenceFacets(REF_NODES.length),
  referenceTrack(AUDIO_PARAM),
]);

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
  {
    id: AUDIO_PARAM,
    label: "Reference track",
    type: "audio",
    default: "",
    help: "Optional. The video is still the length of the Duration control — a long track is a reference, not a running time.",
    group: "References",
    targets: [
      { node: AUDIO_NODE, input: "audio" },
      // Also the director's, which is told to stop inventing a score once a
      // real one has been handed to the model. See referenceTrack.
      director,
    ],
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
    "One line is enough. Name your references as <Picture 1>, <Picture 2> and so on, in upload order.",
    6,
  ),

  durationParam(ids, director),
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

  ...samplingParams(ids),
];

export const minimaxH3Reference: WorkflowDef = {
  id: "minimax-h3-ref",
  name: "Reference to Video",
  description: "Puts people or objects from your images into a new scene.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  params,
  /**
   * This graph is where turbo started: the mode's first form in this app was a
   * ComfyUI export of *this* workflow with the LoRA spliced in, and it produced
   * usable takes. The switch was taken off for a while on the strength of the
   * LoRA's author calling `ref2va` unsupported — worth knowing, and the reason
   * to compare a turbo take against a standard one before trusting it for
   * identity work, but not a reason to withhold a mode that had been working.
   * <https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10>
   *
   * 220s is scaled from this graph's own 300s rather than measured; the first
   * finished turbo run on a machine replaces it with that machine's median.
   */
  turbo: h3Turbo(220),

  patches: h3Patches(),
  stepSampler: h3StepSampler(),

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
  finalize(graph, values) {
    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      delete graph[REFERENCE_NODE].inputs[refInput(index)];
      delete graph[BATCH_NODE].inputs[batchInput(index)];
      delete graph[REF_NODES[index - 1]];
    }

    // With no pictures at all there is nothing to batch, and a BatchImagesNode
    // with no inputs is not an empty batch — it is a node that cannot produce
    // the IMAGE its consumer is asking for. So the batch goes and the director
    // loses its `images` input, which is optional on this node class: the music
    // graph's director runs without one.
    //
    // Only reachable because a track can stand in for the first picture. Every
    // other run keeps at least slot 1.
    if (filled === 0) {
      delete graph[ids.director].inputs.images;
      delete graph[BATCH_NODE];
    }

    // The track goes the same way as an unused picture, and for the same
    // reason: a LoadAudio with an empty filename fails validation, and a
    // variadic input left in place tells H3 to expect a reference that was
    // never supplied.
    const track = String(values[AUDIO_PARAM] ?? "").trim();
    if (!track) {
      delete graph[REFERENCE_NODE].inputs[AUDIO_INPUT];
      delete graph[AUDIO_NODE];
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
    if (filled === 0 && !track) {
      throw new ParamError(
        "Add a reference image or a reference track — this workflow needs at least one to build from.",
        "reference_image_1",
      );
    }
  },
};
