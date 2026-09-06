import { REWRITE_MODELS } from "./generated/gateway-models";
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
export function defaultRewriteModel(): string {
  return REWRITE_MODELS[0].id;
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
  directors: string[],
  {
    group = "Prompt",
    help = "Only rewrites your prompt — it never touches the video. Free and paid are marked, at dollars per million words out. Switch models if one refuses a shot.",
  }: { group?: string; help?: string } = {},
): SelectParam {
  return {
    id: REWRITE_MODEL,
    label: "Rewrite model",
    type: "select",
    default: defaultRewriteModel(),
    options: REWRITE_MODELS.map((model) => ({
      value: model.id,
      label: model.label,
    })),
    optionsFrom: { node: directors[0], input: "model", mode: "restrict" },
    help,
    group,
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
export const REWRITE_CLASSES: string[] = [
  "VercelAIGatewayGenerateText",
  "VercelAIGatewayDescribeImage",
];

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
    model: defaultRewriteModel(),
    prompt,
    system_prompt: system,
    max_tokens: MAX_TOKENS,
    temperature: 1,
    seed: 0,
    strip_thinking: true,
  };

  if (!images) {
    return {
      class_type: REWRITE_CLASSES[0],
      inputs: { ...common },
      _meta: { title },
    };
  }

  return {
    class_type: REWRITE_CLASSES[1],
    inputs: {
      image: images,
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
