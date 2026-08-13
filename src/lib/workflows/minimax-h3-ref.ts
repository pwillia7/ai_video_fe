import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  FRAME_EXPRESSION,
  directorTarget,
  durationParam,
  REFERENCE_DIRECTOR,
  h3Patches,
  h3Turbo,
  promptParam,
  referenceFacets,
  referenceKeepParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 reference-to-video: one or two reference images steer the subject,
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
 * - `ref_images.ref_image_0` / `ref_image_1` are ComfyUI's variadic input
 *   form. A single-reference run must *remove* `ref_image_1` and its LoadImage
 *   rather than leave them blank — see `finalize` below.
 * - A different UNET from the other two: `ref2va` rather than `fl2va`.
 */
const ids: MinimaxNodeIds = {
  prompt: { node: "138", input: "value" },
  director: "145",
  duration: "132",
  noise: "129",
  scheduler: "124",
};

/**
 * The optional second reference. Node 139 now feeds two consumers — the video
 * node and the batch that shows the references to the rewrite stage — so
 * dropping it means clearing a link in both places. Named here because
 * `finalize` has to keep up with anything new that reads from 139.
 */
const SECOND_REF_NODE = "139";
const SECOND_REF_INPUT = "ref_images.ref_image_1";
const REFERENCE_NODE = "136";
const BATCH_NODE = "146";
const SECOND_BATCH_INPUT = "images.image1";

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
    // Variadic, like ref_images above: image1 is removed outright when there
    // is no second reference rather than left pointing at a deleted node.
    inputs: {
      "images.image0": ["137", 0],
      "images.image1": ["139", 0],
    },
    _meta: { title: "Batch Images" },
  },
};

/**
 * Everything that shapes the director's instructions writes this one target,
 * built once here so the duration and both facet selects cannot disagree about
 * what it is. See `directorTarget` for why they all write the whole thing.
 *
 * The appendix is told there are two slots because that is what this graph
 * wires; it reads the submitted values to find out how many actually have an
 * image in them.
 */
const director = directorTarget(ids, REFERENCE_DIRECTOR, [referenceFacets(2)]);

const params: ParamDef[] = [
  {
    id: "reference_image_1",
    label: "Reference image",
    type: "image",
    default: "",
    required: true,
    help: "The subject the video is built around.",
    group: "References",
    targets: [{ node: "137", input: "image" }],
  },
  referenceKeepParam(director, 1),
  {
    id: "reference_image_2",
    label: "Second reference",
    type: "image",
    default: "",
    help: "Optional. Refer to it as <Picture 2>.",
    group: "References",
    targets: [{ node: SECOND_REF_NODE, input: "image" }],
  },
  referenceKeepParam(director, 2),
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
    "One line is enough. Name your references as <Picture 1> and <Picture 2>, in upload order.",
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

  /**
   * With no second reference, the variadic inputs and the loader must be
   * removed outright. Leaving them pointing at a LoadImage with an empty
   * filename would fail validation, and leaving it blank is not the same as
   * omitting it — the model would be told to expect a second subject.
   *
   * Both consumers have to be cleared before the loader goes. Dropping the
   * node while the batch still linked to it would queue a graph referencing a
   * node that no longer exists, which ComfyUI rejects outright.
   */
  finalize(graph, values) {
    if (values.reference_image_2) return;
    delete graph[REFERENCE_NODE].inputs[SECOND_REF_INPUT];
    delete graph[BATCH_NODE].inputs[SECOND_BATCH_INPUT];
    delete graph[SECOND_REF_NODE];
  },
};
