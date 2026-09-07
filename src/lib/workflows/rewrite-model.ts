import type { ComfyGraph } from "@/lib/comfy";
import { REWRITE_MODELS } from "./generated/gateway-models";
import type { OfferedModel } from "./rewrite-catalog";
import type { SelectParam } from "./types";

export type { OfferedModel } from "./rewrite-catalog";
export { REWRITE_MODELS };

/**
 * Which model rewrites the prompt.
 *
 * Every graph runs its prompt through a language model before the video model
 * sees it — that is what makes a one-line idea a usable prompt, and it is most
 * of what the directors in minimax-common are. Until now that model was
 * whatever was hardcoded in the graph, reached through an OpenAI-only node.
 *
 * It is exposed because the choice has a failure mode nothing else here does.
 * A director that declines to describe the shot does not produce a worse video,
 * it produces no video: the run stops at the rewrite, minutes before the GPU
 * would have started. Which requests get declined is a property of the model
 * and of nothing else, so the fix has to be a different model, and swapping one
 * in has to be something you can do from the form rather than from a commit.
 *
 * One id shared by every workflow, like `literal_prompt` and for the same
 * reason: a model that works for you is the model that works for you, whichever
 * graph you reach for next.
 */
export const REWRITE_MODEL = "rewrite_model";

/**
 * The model a graph carries when nobody has chosen — the first of the offered
 * list, which `rewrite-catalog.ts` orders by how well it does this job.
 *
 * Read from the generated list rather than written down, because the two must
 * agree: the ComfyUI node validates its `model` widget against the live gateway
 * catalog, so a default that is not in the offered list is a default that is
 * quite possibly not in the catalog either, and the run would be rejected
 * before it started.
 */
export function defaultRewriteModel(needsVision = true): string {
  return modelsFor(needsVision)[0].id;
}

/**
 * The models a graph may actually be offered, which is not the same question on
 * every graph.
 *
 * A rewrite node comes in two classes and the choice between them is structural:
 * `DescribeImage` where the director is shown something — the upload, the last
 * frame of a clip, the reference sheet — and `GenerateText` where it is not.
 * Four of the six graphs are the first kind and two are the second, and a model
 * that cannot be shown a picture fails the run on the first while working
 * perfectly well on the second.
 *
 * Requiring vision of everything was the simpler rule and it cost the two
 * text-only graphs a whole provider: DeepSeek ships no vision model, so the
 * family was curated away and never appeared.
 */
export function modelsFor(needsVision: boolean): OfferedModel[] {
  return needsVision ? REWRITE_MODELS.filter((m) => m.vision) : REWRITE_MODELS;
}

/**
 * The picker, wired to every director in the graph.
 *
 * Several, for the music workflow: one model writes the caption and another
 * writes the lyrics, and there is no sense in which those should be different
 * models — they are two calls in one act of writing a song.
 *
 * `optionsFrom` restricts rather than replaces. The node's own dropdown is the
 * live catalog, all 250-odd of it, which is not a control anyone wants; but it
 * is also the exact list ComfyUI validates a queued graph against, so anything
 * offered here that is missing from it would be a choice that queues a run and
 * has it rejected. Restricting to the intersection means the picker can be
 * curated and current at once, and a model retired between the last sync and
 * today simply stops being offered.
 *
 * Its only target is the director, so `hideDirectorOnly` takes it off the form
 * whenever the rewrite is switched off — there is no model in that run.
 */
export function rewriteModelParam(
  graph: ComfyGraph,
  directors: string[],
  {
    group = "Prompt",
    help = "Only rewrites your prompt — it never touches the video. Priced in dollars per million words out, and free where it is free. Switch models if one refuses a shot; the key button says which of them your key can be spent on.",
  }: { group?: string; help?: string } = {},
): SelectParam {
  // Read off the graph rather than declared beside it. Which class each rewrite
  // node is, is already decided by whether `rewriteNode` was handed images, so
  // a second statement of the same fact here is one that could disagree with it.
  const needsVision = directors.some(
    (node) => graph[node]?.class_type === VISION_CLASS,
  );
  const offered = modelsFor(needsVision);

  return {
    id: REWRITE_MODEL,
    label: "Rewrite model",
    type: "select",
    default: offered[0].id,
    options: offered.map((model) => ({
      value: model.id,
      label: model.label,
    })),
    optionsFrom: { node: directors[0], input: "model", mode: "restrict" },
    help,
    group,
    // Behind the disclosure: it is reached for when a model refuses a shot,
    // which is something that happens to a run rather than something chosen for
    // one, and it sat directly under the prompt on all six workflows.
    advanced: true,
    targets: directors.map((node) => ({ node, input: "model" })),
  };
}

/**
 * How much the rewrite is allowed to write.
 *
 * The gateway node requires a ceiling where the OpenAI node had none, and its
 * own default is 512 — which is under half of what an H3 director produces for
 * a ten-second clip. A truncated brief is not an obvious failure either: the
 * graph runs, the video renders, and it simply stops following the prompt
 * partway through. Hence a number with room in it. Nothing is billed for
 * headroom; only the tokens actually written are.
 */
const MAX_TOKENS = 4096;

/**
 * Longest edge of a picture shown to a director, in pixels.
 *
 * Vision models are billed by area and the node rescales before it uploads.
 * 1024 is comfortably enough to describe a photograph — the reference sheet is
 * being read for what is in it, not inspected — and the full-size image still
 * goes to the video model, which is where the detail matters.
 */
const MAX_IMAGE_SIDE = 1024;

/**
 * The two classes a rewrite node can be. Named once, because three separate
 * things ask "is this node a director": `check:workflows`, `check:nodes`, and
 * the length-block rule in params.ts.
 */
/**
 * What the vision rewrite node calls the pictures it is shown.
 *
 * Named because a graph's `finalize` has to be able to *remove* it — a run with
 * nothing to show the director drops the input rather than passing an empty
 * batch — and that deletion is silent when it names the wrong key. The OpenAI
 * node this replaced called it `images`, so the wrong key is one that used to
 * be right, which is the kind that survives review.
 */
/**
 * Which kind of AI Gateway key the app is being pointed at.
 *
 * Not something this app can find out. The key lives on the ComfyUI host and is
 * never sent here — the status route answers with a boolean and nothing else —
 * so whether it carries credit is the user's to state. It decides only what the
 * rewrite picker offers.
 *
 * "free" is a Vercel team with no card on it. Such a team still gets $5 of
 * credit a month, so a paid model is not *refused* on one; it is billed against
 * an allowance that runs out mid-month and then fails a run. Someone who would
 * rather not find that out at generation time can say so here and be offered
 * only the models that cost nothing.
 */
export type GatewayTier = "free" | "paid";

/** The models a key of this kind can be spent on without thinking about it. */
export function modelsForTier(tier: GatewayTier): OfferedModel[] {
  return tier === "free" ? REWRITE_MODELS.filter((m) => m.free) : REWRITE_MODELS;
}

/**
 * The same params with the rewrite picker narrowed to what this key can spend.
 *
 * Applied in the browser rather than when the workflow is built, because the
 * answer belongs to the person at the keyboard and not to the install: two
 * people pointed at the same ComfyUI can hold different keys.
 *
 * **Unchanged when the filter would empty the list**, which is not a
 * hypothetical — a catalog with no free model in it at all is the state today,
 * MiniMax having retired the free tier of M3. A picker with nothing in it is
 * worse than one offering more than was asked for, so the narrowing is
 * abandoned and `freeModelsExist` is what the form uses to say so.
 */
export function tierParams<T extends { id: string }>(
  params: T[],
  tier: GatewayTier,
): T[] {
  const allowed = modelsForTier(tier);
  if (allowed.length === 0 || allowed.length === REWRITE_MODELS.length) {
    return params;
  }
  return narrowPicker(
    params,
    new Set(allowed.map((model) => model.id)),
  );
}

/**
 * The narrowing itself, split out from the decision about what to narrow to.
 *
 * Separate because the decision cannot currently be exercised: with no free
 * model in the catalog, `tierParams` returns early on every input, and a branch
 * that no state of the world reaches is a branch nothing checks.
 */
export function narrowPicker<T extends { id: string }>(
  params: T[],
  ids: Set<string>,
): T[] {
  return params.map((param) => {
    if (param.id !== REWRITE_MODEL) return param;
    const picker = param as T & {
      options?: Array<{ value: string; label: string }>;
      default?: string;
    };
    const options = (picker.options ?? []).filter((option) =>
      ids.has(option.value),
    );
    if (options.length === 0) return param;
    // The default moves with the list. A form reset, or a workflow opened for
    // the first time, has to land on something the picker is showing.
    return {
      ...picker,
      options,
      default: ids.has(String(picker.default))
        ? picker.default
        : options[0].value,
    };
  });
}

/** Whether narrowing to a free key would leave anything to pick. */
export function freeModelsExist(): boolean {
  return REWRITE_MODELS.some((model) => model.free);
}

export const REWRITE_IMAGE_INPUT = "image";

/** The rewrite node that is only ever given text. */
export const TEXT_CLASS = "VercelAIGatewayGenerateText";
/** The one that is shown a picture, and so needs a model that can see one. */
export const VISION_CLASS = "VercelAIGatewayDescribeImage";

export const REWRITE_CLASSES: string[] = [TEXT_CLASS, VISION_CLASS];

/** A link to another node's output, as the API graph format writes one. */
type Link = [string, number];

/**
 * The prompt-rewrite node, built rather than copied out of a ComfyUI export.
 *
 * Every graph runs one and they differ in exactly three ways: which director
 * they are given, where the user's text comes from, and whether they are shown
 * a picture. Everything else — the ceiling above, the streaming, the reasoning
 * strip — is the same answer to the same question on all six, and a builder is
 * the only way to keep it that way.
 *
 * `images` picks the node class, because on this pack they are two nodes:
 * `VercelAIGatewayGenerateText` takes a prompt, `VercelAIGatewayDescribeImage`
 * takes a prompt and an IMAGE. Both name their inputs `prompt` and
 * `system_prompt` and both return the text on output 0, which is what lets the
 * bypass, the director target and every link into the sampler stay identical
 * across the two.
 *
 * `seed` is 0 on purpose: the node sends no seed to the model at 0, and ComfyUI
 * caches a node whose inputs have not changed. So re-queueing the same prompt
 * reuses the rewrite instead of paying for a new one, which is what
 * `force_regen: false` did on the node this replaces.
 */
export function rewriteNode({
  prompt,
  system,
  images,
  title,
}: {
  prompt: Link;
  system: string;
  images?: Link;
  title: string;
}) {
  const common = {
    // The default follows the class the node is about to be: a text-only model
    // written into a node that will be shown a picture is a graph rejected
    // before it renders. `images` is what decides both.
    model: defaultRewriteModel(Boolean(images)),
    prompt,
    system_prompt: system,
    max_tokens: MAX_TOKENS,
    temperature: 1,
    seed: 0,
    strip_thinking: true,
  };

  if (!images) {
    return {
      class_type: TEXT_CLASS,
      inputs: { ...common },
      _meta: { title },
    };
  }

  return {
    class_type: VISION_CLASS,
    inputs: {
      [REWRITE_IMAGE_INPUT]: images,
      ...common,
      max_image_side: MAX_IMAGE_SIDE,
      // The references are one scene to be described together, not four
      // pictures to be captioned one at a time and concatenated. Per-image is
      // the node's default and would produce four disconnected paragraphs.
      batch_mode: "all images in one call",
    },
    _meta: { title },
  };
}
