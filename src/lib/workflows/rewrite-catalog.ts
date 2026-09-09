/**
 * Which of the gateway's models the rewrite picker offers, and why those.
 *
 * The gateway lists 250-odd language models. Almost none of them are a
 * sensible answer to "what should rewrite my prompt", and a dropdown with all
 * of them in it is not a control — so this file is the curation, and
 * `pnpm sync:models` applies it to the live catalog and writes the result to
 * `generated/gateway-models.ts`.
 *
 * The rule is deliberately a rule rather than a list of model ids. A list goes
 * stale the week a provider ships a point release: `grok-4.6` becomes
 * `grok-4.7`, the id in the graph stops existing, and ComfyUI rejects the
 * queued workflow with "value not in list" — because the node's `model` widget
 * is a live combo validated against this same catalog. Naming *families* and
 * taking the newest member of each means a point release is picked up by
 * re-running the sync, and a retired model simply drops out.
 *
 * Nothing here runs at generation time. It is build-time input only.
 */

/** One entry of `GET https://ai-gateway.vercel.sh/v1/models`, as far as we read it. */
export interface CatalogEntry {
  id: string;
  name?: string;
  type?: string;
  released?: number;
  tags?: string[];
  modalities?: { input?: string[]; output?: string[] };
  pricing?: { input?: string | number; output?: string | number };
}

/** One offered choice, as the form and the graphs see it. */
export interface OfferedModel {
  id: string;
  /** What the dropdown shows: the provider's own name plus what it costs. */
  label: string;
  /** Accepts images, so it can drive a director that is shown a picture. */
  vision: boolean;
  /** Costs nothing to run. Labelled as such — see `priceLabel`. */
  free: boolean;
  /** Dollars per million output tokens. Zero for the free ones. */
  pricePerMillion: number;
}

/**
 * The families offered, in the order the picker shows them — which is the
 * order they are worth trying for this particular job.
 *
 * The job is rewriting a one-line idea into a shot-by-shot brief for a video
 * model, so what matters is prose, instruction-following, and not refusing.
 * That last one is why the list opens where it does: the whole reason this app
 * left the OpenAI node is that a director which declines to describe the shot
 * fails the run, minutes before the GPU would have finished it.
 *
 * A family is a prefix, and what it contributes is its newest surviving
 * member of each kind — see `curate` for what "kind" means and why it is not
 * simply the newest.
 */
export const REWRITE_FAMILIES: Array<{ prefix: string; why: string }> = [
  { prefix: "spacexai/grok-", why: "The most permissive of the frontier models, and the reason this picker exists." },
  { prefix: "moonshotai/kimi-", why: "Strong at prose and relaxed about fiction." },
  { prefix: "minimax/minimax-m", why: "From the people who trained the video model this app drives." },
  { prefix: "zai/glm-", why: "Cheap and fast. Its own content policy, strict in different places to the Western ones." },
  { prefix: "alibaba/qwen", why: "Open weights, and the least reluctant of the large Chinese lineages." },
  { prefix: "deepseek/deepseek-v", why: "Cheap, and writes a long brief without padding it." },
  { prefix: "mistral/mistral-", why: "European, and historically the least preachy of the open-weight lineages." },
  { prefix: "nvidia/nemotron-", why: "Open weights, permissively tuned, and text-only throughout." },
  { prefix: "inclusionai/ling-", why: "Open weights. Cheap enough that a refusal costs nothing to retry elsewhere." },
  { prefix: "xiaomi/mimo-", why: "Open weights, and small enough to answer immediately." },
  { prefix: "tencent/hy", why: "Open weights, and another content policy again." },
  { prefix: "meta/llama-", why: "Open weights, for comparison against the hosted ones." },
  { prefix: "openai/gpt-", why: "What the graphs used to call directly, kept so the difference can be measured. Its open-weight member is the text-only one." },
  { prefix: "google/gemini-", why: "A known quantity. Fast and cheap; filters more than the ones above." },
  { prefix: "anthropic/claude-sonnet-", why: "A known quantity, and the best writer here when it agrees to write." },
];

/**
 * Variants that are the same model under another billing or serving
 * arrangement, or are pointed at a job that is not this one.
 *
 * Excluded so that "the newest member of the family" lands on the model the
 * provider means by that version, rather than on whichever speed tier they
 * shipped most recently — `glm-5.3-fast` is not a newer model than `glm-5.3`,
 * it is the same one with a different price. Dated snapshots (`-0813`) go for
 * the same reason.
 *
 * `-free` is conspicuously *not* here: a free variant is a distinct offer and
 * gets its own place in the list. See `curate`.
 */
const NOT_A_VERSION =
  /(-fast|-highspeed|-turbo|-lightning|-promo(-\d+)?|-beta|-preview|-exp|-thinking|-multi-agent|-\d{4})$/;

/**
 * Families' members that are for writing code, or are not really chat models.
 *
 * `-mt` is machine translation — Hunyuan ships three of them, and they are the
 * newest thing in that family without being an answer to anything asked here.
 * `-fin` and `-sante` are the same shape of mistake from the other direction:
 * Ling's free variants are the ones fine-tuned for finance and for healthcare,
 * so the free offer in that family is a model taught to write about something
 * else. A cheap general model is a better director than a free specialised one.
 */
const WRONG_JOB =
  /(code|coder|devstral|embed|guard|moderation|search|realtime|audio|tts|image|-mt\d|-(fin|sante)(-|$))/;

function price(value: string | number | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  // Rounded because the source is a per-token price and the multiplication
  // otherwise lands on 0.9700000000000001, which would be written into the
  // generated file and read back as a diff every time the script runs.
  return Math.round(parsed * 1_000_000 * 10_000) / 10_000;
}

/** "$2.00/M", or "free". Per million *output* tokens — the bigger number. */
export function priceLabel(perMillion: number): string {
  if (perMillion <= 0) return "free";
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion.toFixed(2).replace(/\.00$/, "")}/M`;
}

function eligible(model: CatalogEntry): boolean {
  if (model.type !== "language") return false;
  if ((model.tags ?? []).includes("image-generation")) return false;
  if (NOT_A_VERSION.test(model.id)) return false;
  if (WRONG_JOB.test(model.id)) return false;
  return true;
}

/** Whether this one can be shown a picture. See `curate`. */
function seesImages(model: CatalogEntry): boolean {
  return (model.modalities?.input ?? []).includes("image");
}

function offer(model: CatalogEntry): OfferedModel {
  const perMillion = price(model.pricing?.output);
  const free = perMillion <= 0 && price(model.pricing?.input) <= 0;
  const name = model.name?.trim() || model.id;
  return {
    id: model.id,
    label: `${name} — ${priceLabel(free ? 0 : perMillion)}`,
    vision: (model.modalities?.input ?? []).includes("image"),
    free,
    pricePerMillion: free ? 0 : perMillion,
  };
}

/**
 * The offered list: for every family, the newest member that can be shown a
 * picture and the newest that cannot, plus the free variants of each.
 *
 * **Both kinds, because the app no longer requires one.** Four of the six
 * graphs show their director an image — the uploaded still, the last frame of
 * the clip being extended, the reference sheet — and the ComfyUI node that does
 * the showing offers only vision models in its `model` widget, so for a long
 * time a text-only model was simply not something a run could contain. It is
 * now: a graph handed a model that cannot see swaps that node for the text one
 * and tells the director it is writing blind. See `applyTextOnlyRewrite`.
 *
 * That is what makes the second pick worth having, and the second pick is most
 * of the point of this file. Vision is the rarer property and it is not
 * correlated with being any good at this job: holding every family to it lost
 * DeepSeek outright, since it ships no vision model at all, and elsewhere
 * picked the wrong member — `glm-5.3-flash` over `glm-5.3`, because the faster
 * and weaker tier is the one that takes images. Half the open-weight lineages
 * worth having here are text-only, which is the same half least likely to
 * refuse a shot.
 *
 * "Newest of each kind" also covers "newest overall" without stating it: the
 * newest member is necessarily the newer of those two. Where a family's newest
 * takes images and it has no text-only member — Grok, Gemini, Claude — the two
 * picks collapse to one entry, as they did before.
 *
 * A family contributing nothing — retired, or every member excluded — is simply
 * absent. That is the failure this is built around: the list shrinks, and
 * nothing offered is a model the gateway has stopped listing.
 */
export function curate(models: CatalogEntry[]): OfferedModel[] {
  const offered: OfferedModel[] = [];

  for (const family of REWRITE_FAMILIES) {
    const members = models
      .filter((model) => model.id.startsWith(family.prefix))
      .filter(eligible)
      .sort((a, b) => (b.released ?? 0) - (a.released ?? 0));

    const paid = (model: CatalogEntry) => price(model.pricing?.output) > 0;
    const gratis = (model: CatalogEntry) =>
      price(model.pricing?.output) <= 0 && price(model.pricing?.input) <= 0;

    /**
     * Up to four per family, and often one or two.
     *
     * The free variants follow the same pair as the paid ones and for the same
     * reason: which of the two a run can use is decided per graph and per
     * model, so a free text-only model is a free option that a graph showing a
     * picture can still take, and a free vision model is one it can take
     * without writing blind.
     */
    const picks = [
      members.find((model) => paid(model) && seesImages(model)),
      members.find((model) => paid(model) && !seesImages(model)),
      members.find((model) => gratis(model) && seesImages(model)),
      members.find((model) => gratis(model) && !seesImages(model)),
    ];

    for (const model of picks) {
      if (model && !offered.some((existing) => existing.id === model.id)) {
        offered.push(offer(model));
      }
    }
  }

  return offered;
}
