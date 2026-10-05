import type { ComfyGraph } from "@/lib/comfy";
import { pruneUnreachable, terminals } from "./director";
import {
  REWRITE_CLASSES,
  REWRITE_IMAGE_INPUT,
  REWRITE_MODEL,
} from "./rewrite-model";

/**
 * Where the prompt rewrite runs: on the Vercel AI Gateway, or on the ComfyUI
 * machine itself.
 *
 * The gateway is the default and the better writer, but every model on it is
 * someone's hosted model with someone's content policy, and a director that
 * declines to describe the shot is a run that never starts. The local option
 * exists for exactly that: a model with its refusals taken out, run by
 * ComfyUI's own `TextGenerate` node on the same card that renders the video.
 *
 * In-process rather than a llama.cpp or Ollama server beside ComfyUI, and that
 * is the decision everything else here follows from. The card is full during a
 * render — H3's text encoder alone is a 32B Qwen3-VL — so a director cannot sit
 * resident next to the video models; it has to be loaded, used and evicted
 * before they arrive. Loaded through `CLIPLoader`, it is a model ComfyUI's own
 * memory manager knows about and evicts like any other. A separate server is
 * memory ComfyUI cannot see, and the hand-off between the two is a race.
 *
 * The price is speed. ComfyUI's generate loop decodes at roughly 7 tokens a
 * second for this model on a 3090, so a full H3 brief adds about a minute and
 * a half to the run where the gateway adds ten or twenty seconds. That was
 * measured, not guessed — see `scripts/spike-local-director.ts`.
 *
 * Not a param. Which machine writes the brief is a fact about the person's
 * setup rather than about any one workflow, so it is chosen once, beside the
 * gateway key, and travels with the run as a mode. See `RunMode.localDirector`.
 */
export type DirectorEngine = "gateway" | "local";

/**
 * The params to draw, with the gateway's model picker taken off while the
 * director runs locally — it would be choosing a model nothing uses.
 *
 * Applied where the form is drawn rather than to the workflow itself: the
 * stored values are clamped against the workflow's params, so dropping the
 * picker there would forget the gateway model the moment someone tried the
 * local one, and switching back would land on the default.
 */
export function directorParams<T extends { id: string }>(
  params: T[],
  engine: DirectorEngine,
): T[] {
  return engine === "local"
    ? params.filter((param) => param.id !== REWRITE_MODEL)
    : params;
}

/** A language model the box can run as a director, found by its filename. */
export interface LocalDirectorModel {
  id: string;
  label: string;
  /**
   * How to recognise it in ComfyUI's `text_encoders` list.
   *
   * A pattern rather than a filename because the filename is not stable: the
   * upstream one has spaces in it, and browsers and download managers each
   * mangle those differently — the copy on the machine this was built against
   * arrived with every space turned into "20". Matching on what the file *is*
   * keeps working whatever it was saved as.
   */
  match: RegExp;
  /** Where to get it, for the error that says it is missing. */
  download: string;
}

/**
 * The models known to work, best first.
 *
 * One today. It was picked because it is the only uncensored model packaged in
 * a form `CLIPLoader` reads without conversion, and because it can see — so the
 * four graphs that show their director a picture keep doing so. The bf16
 * variant of the same file is 26 GB and does not fit on a 24 GB card at all,
 * which is why the pattern insists on the int8 one.
 */
export const LOCAL_DIRECTOR_MODELS: LocalDirectorModel[] = [
  {
    id: "gemma-4-12b-heretic",
    label: "Gemma 4 12B uncensored (heretic, int8)",
    match: /gemma-?4-?12b.*heretic.*int8/i,
    download:
      "https://huggingface.co/DeepNeuralNerd/Gemma-4-12B-it-uncensored-heretic-DeepNeuralNerd-LTX_2.5_ComfyUI",
  },
];

export const DEFAULT_LOCAL_DIRECTOR = LOCAL_DIRECTOR_MODELS[0].id;

export function localDirectorModel(id: unknown): LocalDirectorModel {
  return (
    LOCAL_DIRECTOR_MODELS.find((model) => model.id === id) ??
    LOCAL_DIRECTOR_MODELS[0]
  );
}

/**
 * The file on this install that is the chosen model, if there is one.
 * `available` is CLIPLoader's live `clip_name` list.
 */
export function findLocalDirectorFile(
  model: LocalDirectorModel,
  available: string[],
): string | undefined {
  // Basename only: ComfyUI lists files in subfolders with the folder prefixed,
  // and a folder name is not part of what the file is.
  return available.find((file) =>
    model.match.test(file.split(/[\\/]/).pop() ?? file),
  );
}

/**
 * What a local brief adds to a run, for the first estimate in a combination
 * before this device has timings of its own. Measured: 86–98 seconds for a
 * reference brief on a 3090, the higher figure with the model loaded cold.
 */
export const LOCAL_DIRECTOR_SECONDS = 90;

export const LOCAL_CLASS = "TextGenerate";
export const LOCAL_LOADER_CLASS = "CLIPLoader";
/**
 * The node that holds the director's instruction for it.
 *
 * Needed because `TextGenerate`'s `system_prompt` is socket-only — it will not
 * take a typed value, only a link — where the gateway nodes take the
 * instruction as a plain widget. The instruction is still written per run by
 * the duration param onto the director node; the conversion moves whatever
 * ended up there into this node.
 */
const SYSTEM_CLASS = "PrimitiveStringMultiline";

/**
 * How much the local director may write.
 *
 * The same ceiling as the gateway's and for the same reason — a truncated brief
 * renders, and simply stops following the prompt partway through. `TextGenerate`
 * defaults to 512, which is under half of a ten-second H3 brief.
 */
const MAX_LENGTH = 4096;

/**
 * Turn every gateway director in the graph into a local one, in place. Call it
 * on a clone — `applyParams` does, after `finalize` and before
 * `applyTextOnlyRewrite`.
 *
 * The node keeps its id. That is what lets everything downstream go on working
 * untouched: the links that read the brief off output 0, the bypass that
 * rewires them to the raw prompt, the trigger words a LoRA adds where the
 * prompt reaches the model. `TextGenerate` returns the text on output 0 just as
 * the gateway nodes do.
 *
 * Before the text-only pass rather than after, because that pass exists for
 * models that cannot see and this one can: a converted node is no longer a
 * gateway class, so the text-only pass leaves it alone and the pictures stay
 * wired. Where `finalize` left nothing to show, there is simply no image input
 * — `TextGenerate`'s is optional, where `DescribeImage`'s is not.
 *
 * Seed 0, as on the gateway node: ComfyUI caches a node whose inputs have not
 * changed, so re-queueing the same prompt reuses the brief rather than spending
 * another ninety seconds on a new one.
 */
export function applyLocalRewrite(graph: ComfyGraph, file: string): void {
  const roots = terminals(graph);
  let converted = false;

  for (const [id, node] of Object.entries(graph)) {
    if (!REWRITE_CLASSES.includes(node.class_type)) continue;

    const loader = `${id}:local-loader`;
    const system = `${id}:local-system`;
    graph[loader] = {
      class_type: LOCAL_LOADER_CLASS,
      // The type only picks among encoders that share an architecture; a
      // generating model is recognised from its weights whichever is given.
      inputs: { clip_name: file, type: "ltxv" },
      _meta: { title: "Load Local Director" },
    };

    const instruction = node.inputs.system_prompt;
    const systemLink: [string, number] | undefined = Array.isArray(instruction)
      ? (instruction as [string, number])
      : typeof instruction === "string" && instruction.trim()
        ? [system, 0]
        : undefined;
    if (systemLink?.[0] === system) {
      graph[system] = {
        class_type: SYSTEM_CLASS,
        inputs: { value: instruction },
        _meta: { title: "Local Director Instruction" },
      };
    }

    const image = node.inputs[REWRITE_IMAGE_INPUT];
    node.class_type = LOCAL_CLASS;
    node.inputs = {
      clip: [loader, 0],
      prompt: node.inputs.prompt,
      max_length: MAX_LENGTH,
      // Gemma's own recommended sampling.
      sampling_mode: "on",
      "sampling_mode.temperature": 1,
      "sampling_mode.top_k": 64,
      "sampling_mode.top_p": 0.95,
      "sampling_mode.min_p": 0.05,
      "sampling_mode.repetition_penalty": 1.05,
      "sampling_mode.seed": 0,
      // Thinking would double the slowest part of the run for a brief that is
      // already structured by the instruction.
      thinking: false,
      use_default_template: true,
      ...(systemLink ? { system_prompt: systemLink } : {}),
      ...(image !== undefined ? { image } : {}),
    };
    converted = true;
  }

  // Nothing becomes unreachable today — the pictures stay wired — but the pass
  // is the same shape as the text-only one, and a director input that stopped
  // being carried across would otherwise leave its feeder looking like output.
  if (converted) pruneUnreachable(graph, roots);
}

/**
 * The graph a local run would queue, for `check:workflows`. The filename is a
 * stand-in: what is being checked is the wiring, not the file.
 */
export function localGraph(graph: ComfyGraph): ComfyGraph {
  const clone = structuredClone(graph);
  applyLocalRewrite(clone, "local-director.safetensors");
  return clone;
}
