import type { ComfyGraph, ComfyNode } from "@/lib/comfy";
import {
  MODEL_LOADER,
  modelLoaderIn,
  spliceModel,
  type SpliceId,
} from "./model-chain";
import type { ParamValue } from "./types";

/**
 * What the one diffusion-model loader loads while a patch is applied.
 *
 * For a LoRA whose stored graph is on weights it was not made for. MiniMax-H3
 * LoRAs are built against fp16/fp8 bases, and the rotated and quantised
 * checkpoints — `*_int8_convrot`, `*_nvfp4`, `*_w4a8` — store their weights in a
 * different basis: the LoRA loads into one without any error at all and then
 * produces warped faces and melting limbs. So the swap is not a tuning choice,
 * it is the difference between the switch working and the switch quietly ruining
 * every take made with it on.
 *
 * The loader is found rather than named, unlike `StepModel`'s node id. There is
 * exactly one `UNETLoader` in these graphs — `spliceModel` depends on that
 * already, and refuses the patch outright if it is not true — so an id here
 * would be one more thing to keep in step with a re-export, for no gain.
 *
 * Only the diffusion model. The text encoder is not where a model-only LoRA
 * applies, so the graph's `CLIPLoader` is left alone whatever it is quantised to.
 */
export interface PatchBase {
  /**
   * Filename prefixes of the checkpoints this base is the answer for — the
   * *stored* graph's, not the one loaded instead.
   *
   * A LoRA that runs on more than one model family needs one of these per
   * family: MiniMax-H3 ships `fl2va` and `ref2va` backbones, each with its own
   * non-rotated checkpoint, and the same LoRA file wants a different one on
   * each. Matching on the graph rather than declaring per workflow keeps one
   * entry in the dropdown instead of a near-duplicate per family.
   */
  forModel: string[];
  /** The file the loader names while the switch is on. */
  value: string;
  /** Set where a second supported base is worth offering. */
  alternate?: PatchBaseAlternate;
  /**
   * Filename prefixes this patch is known to work on. `value` — and
   * `alternate.value` — have to start with one of them, which is what turns
   * "someone pointed this at a rotated checkpoint" into a failed
   * `check:workflows` rather than a render that finishes looking subtly wrong.
   */
  allowed: string[];
}

/**
 * A second base the patch also runs on, offered as a switch under it.
 *
 * Not a quality setting so much as a question about the machine and what is on
 * its disk: the full-precision checkpoint is the better one and the lighter one
 * is what you reach for when it will not fit or is not downloaded. That is the
 * same kind of question Low VRAM answers, which is why the switch is remembered
 * once for the whole app rather than per workflow.
 *
 * A boolean rather than a list of files, because there are two and the app
 * should not be handing the browser a menu of the model files on someone's
 * disk — `base` is withheld from `ClientPatch` for exactly that reason. Which
 * file each side of the switch means is resolved on the server. A third base
 * would want a different shape, and would be the point to reconsider this.
 */
export interface PatchBaseAlternate {
  /** The file the loader names instead, while this switch is on. */
  value: string;
  label: string;
  help: string;
}

/**
 * A numeric input on the spliced node, offered as a control of its own.
 *
 * Written onto the node at splice time rather than reaching it as a param,
 * because the node is not in the stored graph — the same reason turbo's
 * `lowVram` works this way. See `PatchDef`.
 */
export interface PatchStrength {
  /** The input on the spliced node. Must be one the node already has. */
  input: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  help: string;
}

/**
 * The node that puts a LoRA's trigger in front of the prompt.
 *
 * ComfyUI core, so this costs no node pack — the same property that makes
 * `LoraLoaderModelOnly` the right loader.
 */
const PROMPT_JOIN = "StringConcatenate";

/** Node id for the spliced-in prompt join. Must not collide with a graph's own. */
const PROMPT_NODE_ID = "style-prompt";

/**
 * One step on a LoRA's own scale, offered as a dropdown under it.
 *
 * For a LoRA whose training gives it graded phrases rather than one trigger —
 * the VHS one is trained on light/medium/heavy tape damage, and the phrase is
 * what selects between them. The strength slider is a different question: that
 * scales how hard the weights push, this says which thing they push toward.
 */
export interface PatchPromptTier {
  /** Stable id: stored, sent, and recorded. */
  id: string;
  label: string;
  /** The phrase itself, verbatim from the LoRA's own documentation. */
  phrase: string;
}

/**
 * What a LoRA needs written into the prompt to do anything at all.
 *
 * **A LoRA with a trigger is inert without it.** The weights are applied either
 * way, so a run with the switch on and no trigger looks like it worked and is
 * merely a slightly different take — which is the worst kind of wrong, and the
 * reason this is declared next to the file rather than left to whoever writes
 * the prompt.
 *
 * The text goes in front of whatever reaches the model, deterministically,
 * rather than being asked of the prompt director. The director is a language
 * model rewriting a sentence, and "begin your output with exactly this" is a
 * request it can decline, reword, or bury mid-sentence. A join node cannot.
 * That also makes the trigger survive the director being bypassed entirely.
 */
export interface PatchPrompt {
  /** The trigger word, first thing the model sees. */
  trigger: string;
  /** How the tier control is labelled. Absent `tiers`, no control is shown. */
  label?: string;
  help?: string;
  /** Graded phrases, in the order they are offered. */
  tiers?: PatchPromptTier[];
  /**
   * Which tier a fresh install selects. Declared rather than taken as the first
   * offered, because the list is ordered by intensity — which is how someone
   * reads a graded scale — and the useful default is not usually an end of it.
   * An id naming no tier falls back to the first.
   */
  defaultTier?: string;
}

/**
 * A curated LoRA the switch can load, and everything that is true of that one
 * LoRA rather than of the switch carrying it.
 *
 * `base` and `strength` live here rather than on the patch because they are
 * facts about a particular set of weights: one LoRA is trained against a
 * checkpoint and converges at a strength, and the next one added to the list
 * will have its own answers to both. Hanging them off the switch would make the
 * first LoRA's numbers silently apply to every later one.
 */
export interface PatchChoice {
  /**
   * Stable id. Stored, sent in the request, and recorded on finished runs, so
   * renaming one forgets the setting and orphans the record — add a new id
   * instead.
   */
  id: string;
  /** How it reads in the dropdown. */
  label: string;
  /** The LoRA file, written onto the spliced node's file input. */
  file: string;
  /**
   * The checkpoints this LoRA needs, one per model family it runs on. Empty or
   * absent where it runs on whatever the graph already loads.
   */
  bases?: PatchBase[];
  /** Set where this LoRA's strength is the user's to set. */
  strength?: PatchStrength;
  /** Set where this LoRA has a trigger word it is inert without. */
  prompt?: PatchPrompt;
  /** One line under the dropdown, describing this LoRA rather than the switch. */
  help: string;
}

/** The dropdown a switch offers, and the LoRAs in it. */
export interface PatchChoices {
  /** The input on the spliced node the chosen file is written to. */
  fileInput: string;
  /** The dropdown's label. */
  label: string;
  /**
   * In the order they are offered. The first is what a fresh install selects,
   * so put the one most people want at the top.
   */
  options: PatchChoice[];
}

/**
 * A patch: one node put in the model's path, and a switch to put it there.
 *
 * SageAttention and Spectrum are the plain form — a node from a ComfyUI export,
 * wired between the model and the sampler, on a switch, with nothing for the
 * user to set beyond whether it is there at all. Written once as a list rather
 * than twice as named fields because they differ only in which node they carry.
 *
 * Turbo is deliberately not one of these. It moves the step control's range and
 * carries a switch of its own, which is a different enough shape that folding it
 * in here would cost more than the duplication saves. See turbo.ts.
 *
 * A patch's node settings are otherwise whatever its ComfyUI export carries and
 * are not exposed: they are the node pack's tuning of its own method rather
 * than anything about the shot.
 *
 * **`choices` is the one that is not like the others.** The content-LoRA switch
 * carries a node that is a shell — a loader with no file in it — and a curated
 * list of LoRAs to put in it. So the switch answers "am I applying one of
 * these", the dropdown answers "which", and each entry brings the base it needs
 * and the strength it converges at. All of it is declared rather than reached by
 * a param `target`, for the reason turbo's low-VRAM switch is: the node is not
 * in the stored graph, so there is nothing for a target to point at until the
 * splice has run, and while the switch is off there never is.
 *
 * The node is only in the graph when the switch is on, so "off" is its absence
 * rather than the node present and told to do nothing. That is what lets a run
 * with every switch off need none of the packs these nodes come from.
 */
export interface PatchDef {
  /**
   * Which link in the model chain this is. Doubles as the node's id in the
   * graph and as the key the switch is remembered under, so it must stay
   * stable — renaming one silently forgets everyone's setting.
   */
  id: SpliceId;
  /** The switch's name in the sidebar, and in a run's name in the history. */
  label: string;
  /**
   * The node to splice in, exactly as ComfyUI exports it, minus the model link
   * — that is wired by the splice, because only the graph knows where the
   * model is. For a switch with `choices` this is the loader without its file,
   * which the chosen entry supplies.
   */
  node: ComfyNode;
  /** The input on that node the model arrives at. */
  modelInput: string;
  /**
   * Wall-clock estimate with this patch applied, if it differs. Normally
   * absent: the first finished run in a given combination of switches replaces
   * any static number with this machine's own median, and guessing is worse
   * than not saying.
   */
  estimatedSeconds?: number;
  /** Where the switch starts before anyone has touched it. See DEFAULTS_VERSION. */
  defaultOn?: boolean;
  /** Set where the switch picks from a list rather than carrying one node. */
  choices?: PatchChoices;
  /** One line under the switch. */
  help: string;
}

/**
 * What the browser is allowed to see.
 *
 * `node` and `modelInput` are withheld for the same reason the graph is: they
 * are server-side wiring. Every model filename goes with them — each choice's
 * `file`, and both sides of its `base` — because the app has no business handing
 * the browser a listing of the model files on someone's disk. What survives is
 * wording and numbers: enough to draw the controls, not enough to name a file.
 * Which file a choice means is resolved on the server, from the id.
 */
export type ClientPatch = Omit<PatchDef, "node" | "modelInput" | "choices"> & {
  choices?: ClientPatchChoices;
  /**
   * The value of another control at which this switch is refused, and the line
   * that says so — see `suppresses` on StepSampler, which is where the rule
   * actually lives.
   *
   * Not written by hand on a patch, exactly like a param's `noteAt`:
   * `toSummary` fills it in from whatever declares the rule, so the switch
   * cannot claim something the queued graph does not do.
   */
  suppressedAt?: { param: string; value: ParamValue; note: string };
};

export interface ClientPatchChoices {
  label: string;
  options: ClientPatchChoice[];
}

export type ClientPatchChoice = Omit<
  PatchChoice,
  "file" | "bases" | "strength"
> & {
  // `prompt` is not stripped: it is words that go in the prompt, which the form
  // has to show and which give nothing away about the machine.
  strength?: Omit<PatchStrength, "input">;
  /**
   * The base switch's wording, minus the filename it selects — the same trade
   * `strength` makes, and for the same reason: the form needs to know there is
   * a switch and what to call it, not which file sits behind either side.
   *
   * Resolved against the workflow's own graph, because a LoRA declares a base
   * per model family and only one of them applies here. A family whose base
   * offers no alternate shows no switch, which is why this is filled in by
   * `toClientPatch` from the graph rather than copied off the entry.
   */
  baseAlternate?: Omit<PatchBaseAlternate, "value">;
};

export function toClientPatch(patch: PatchDef, graph: ComfyGraph): ClientPatch {
  const { node: _node, modelInput: _modelInput, choices, ...rest } = patch;
  const client: ClientPatch = rest;
  if (!choices) return client;
  client.choices = {
    label: choices.label,
    options: choices.options.map((option) => {
      const { file: _file, bases, strength, ...keep } = option;
      const clientOption: ClientPatchChoice = keep;
      if (strength) {
        const { input: _input, ...clientStrength } = strength;
        clientOption.strength = clientStrength;
      }
      const base = patchBaseFor(bases, graph);
      if (base?.alternate) {
        const { value: _value, ...clientAlternate } = base.alternate;
        clientOption.baseAlternate = clientAlternate;
      }
      return clientOption;
    }),
  };
  return client;
}

/**
 * The entry a run is using: the one it named, or the first offered.
 *
 * Falling back rather than failing, because an id can outlive the entry it
 * named — a stored setting, or a `Reuse settings` on a run made before the list
 * changed — and dropping to the default is the answer that still produces a
 * take. `check:workflows` is what stops the list itself being wrong.
 */
export function patchChoice(
  patch: PatchDef,
  chosen: string | undefined,
): PatchChoice | undefined {
  const options = patch.choices?.options;
  if (!options?.length) return undefined;
  return options.find((option) => option.id === chosen) ?? options[0];
}

/**
 * Whether this switch is refused at these values — asked by the form, so the
 * row can show as off rather than lying about a node the run will not have.
 *
 * The values passed have to be the ones that will actually run: a pinned
 * control submits its pinned value and not what is stored under it. See
 * `pinnedValues`.
 */
export function patchSuppressed(
  patch: ClientPatch,
  values: Record<string, ParamValue>,
): boolean {
  const rule = patch.suppressedAt;
  return rule !== undefined && values[rule.param] === rule.value;
}

/** What the run carries for one patch, for the patches that take anything. */
export interface PatchOptions {
  /** Id of the entry in `choices`. Falls back to the first offered. */
  choice?: string;
  /**
   * The strength this run set, ignored by an entry that declares none.
   * Out-of-range numbers are clamped rather than refused: the control cannot
   * produce one, so anything outside the range came from a hand-written request
   * or a stored value from an older range, and neither is worth failing a
   * render over.
   */
  strength?: number;
  /** Load the entry's alternate base. Ignored where it offers none. */
  alternateBase?: boolean;
  /** Id of the tier in the entry's `prompt`. Falls back to the first offered. */
  tier?: string;
  /**
   * Where the prompt reaches the model: the node input the trigger has to land
   * in front of.
   *
   * Passed in rather than found here, because only the workflow knows it — it
   * is the same link `directorBypass` rewires, and `promptConsumer` derives it
   * from that rather than from a second declaration that could drift. Without
   * it a LoRA that declares a trigger is refused, since applying its weights
   * with no trigger is the silent-no-op this whole field exists to prevent.
   */
  promptInput?: { node: string; input: string };
}

/** What a run actually got from one patch, once the choice is resolved. */
export interface AppliedPatch {
  /** Id of the entry used, absent on a patch that offers no list. */
  choice?: string;
  /** The LoRA file that went into the node. */
  file?: string;
  /** The strength it was applied at, where the entry has one. */
  strength?: number;
  /** The text put in front of the prompt, and which tier it came from. */
  prompt?: { text: string; tier?: string };
  /** The checkpoint put under it, and which side of the base switch that was. */
  base?: { file: string; alternate: boolean };
}

/**
 * Splice the patch in, in place, with the chosen LoRA and the base it needs.
 * Call it on a clone — `applyParams` does.
 *
 * Returns what it actually did, which is what a run is recorded as having used:
 * an id that no longer names an entry resolves to the default rather than
 * failing, so what was asked for and what ran are not always the same.
 */
export function applyPatch(
  graph: ComfyGraph,
  patch: PatchDef,
  options: PatchOptions = {},
): AppliedPatch {
  const choice = patchChoice(patch, options.choice);
  const applied: AppliedPatch = {};
  const inputs: Record<string, unknown> = {};

  if (patch.choices && !choice) {
    throw new Error(`${patch.label} offers a list of LoRAs with nothing in it.`);
  }

  if (choice && patch.choices) {
    if (!(patch.choices.fileInput in patch.node.inputs)) {
      throw new Error(
        `${patch.label} writes its LoRA to "${patch.choices.fileInput}", which ` +
          `${patch.node.class_type} does not accept.`,
      );
    }
    inputs[patch.choices.fileInput] = choice.file;
    applied.choice = choice.id;
    applied.file = choice.file;

    if (choice.strength) {
      if (!(choice.strength.input in patch.node.inputs)) {
        throw new Error(
          `${choice.label} offers a strength on "${choice.strength.input}", which ` +
            `${patch.node.class_type} does not accept.`,
        );
      }
      const strength = resolveStrength(choice.strength, options.strength);
      inputs[choice.strength.input] = strength;
      applied.strength = strength;
    }
  }

  spliceModel(graph, {
    id: patch.id,
    label: patch.label,
    node: patch.node,
    modelInput: patch.modelInput,
    inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
  });

  if (choice?.prompt) {
    applied.prompt = applyPatchPrompt(
      graph,
      patch.label,
      choice.prompt,
      options.tier,
      options.promptInput,
    );
  }

  if (choice?.bases?.length) {
    const base = patchBaseFor(choice.bases, graph);
    if (!base) {
      throw new Error(
        `${choice.label} declares no checkpoint for the model this graph loads, so it cannot be applied here.`,
      );
    }
    // Resolved rather than echoed: a base offering no alternate loads its
    // default whatever the switch was left on, so recording the request would
    // name a checkpoint the run never touched.
    const alternate =
      options.alternateBase === true && base.alternate !== undefined;
    applied.base = {
      file: applyPatchBase(graph, patch.label, base, alternate),
      alternate,
    };
  }

  return applied;
}

/**
 * The file a base resolves to. The alternate only where one is actually
 * offered, so a stale `true` in a stored run cannot name a file that is gone.
 */
export function patchBaseFile(
  base: PatchBase,
  alternateBase: boolean | undefined,
): string {
  return alternateBase && base.alternate ? base.alternate.value : base.value;
}

/** The strength this run uses: the submitted one clamped, or the default. */
export function resolveStrength(
  spec: PatchStrength,
  submitted: number | undefined,
): number {
  if (submitted === undefined || !Number.isFinite(submitted)) {
    return spec.default;
  }
  return Math.min(spec.max, Math.max(spec.min, submitted));
}

/**
 * The base this LoRA needs on this graph, found by what the graph loads now.
 *
 * Undefined where the LoRA declares none for this family, which is what refuses
 * the switch on a graph it was not made for rather than leaving it on weights
 * that would warp.
 */
export function patchBaseFor(
  bases: PatchBase[] | undefined,
  graph: ComfyGraph,
): PatchBase | undefined {
  if (!bases?.length) return undefined;
  const loader = modelLoaderIn(graph);
  const current = loader ? graph[loader].inputs.unet_name : undefined;
  if (typeof current !== "string") return undefined;
  return bases.find((base) =>
    base.forModel.some((prefix) => current.startsWith(prefix)),
  );
}

/** The tier a run is using: the one it named, or the first offered. */
export function patchTier(
  prompt: PatchPrompt,
  chosen: string | undefined,
): PatchPromptTier | undefined {
  const tiers = prompt.tiers;
  if (!tiers?.length) return undefined;
  return (
    tiers.find((tier) => tier.id === chosen) ??
    tiers.find((tier) => tier.id === prompt.defaultTier) ??
    tiers[0]
  );
}

/** The text this LoRA puts in front of the prompt. */
export function patchPromptText(
  prompt: PatchPrompt,
  chosen: string | undefined,
): string {
  const tier = patchTier(prompt, chosen);
  return tier ? `${prompt.trigger}, ${tier.phrase}` : prompt.trigger;
}

/**
 * Put the LoRA's trigger in front of the prompt, in place, and say what it was.
 *
 * Splices a join node between whatever currently produces the prompt and the
 * node that consumes it, so the trigger is first whatever else happens to the
 * text — including the prompt director being bypassed, which rewires the
 * *producer* and leaves this join and its consumer untouched. That is why this
 * runs before `applyBypass` rather than after: bypass rewrites links out of the
 * director, and the join's own input is one of them.
 *
 * Throws where the consumer is unknown or missing. A LoRA with a trigger and no
 * trigger applied is a run that looks like it worked, which is worse than one
 * that failed.
 */
function applyPatchPrompt(
  graph: ComfyGraph,
  label: string,
  prompt: PatchPrompt,
  tier: string | undefined,
  promptInput: { node: string; input: string } | undefined,
): { text: string; tier?: string } {
  if (!promptInput) {
    throw new Error(
      `${label} needs a trigger in the prompt, but this workflow does not say where the prompt reaches the model.`,
    );
  }
  const consumer = graph[promptInput.node];
  if (!consumer || !(promptInput.input in consumer.inputs)) {
    throw new Error(
      `${label} writes its trigger into node ${promptInput.node}.${promptInput.input}, which ${
        consumer ? `${consumer.class_type} does not accept` : "this graph does not have"
      }.`,
    );
  }
  if (graph[PROMPT_NODE_ID]) {
    throw new Error(
      `${label} needs node id "${PROMPT_NODE_ID}", which is taken.`,
    );
  }

  const text = patchPromptText(prompt, tier);
  graph[PROMPT_NODE_ID] = {
    class_type: PROMPT_JOIN,
    inputs: {
      string_a: text,
      // Whatever fed the model before — the director's rewrite, or the raw
      // prompt once bypass has rewired it.
      string_b: consumer.inputs[promptInput.input],
      delimiter: ", ",
    },
    _meta: { title: "LoRA trigger" },
  };
  consumer.inputs[promptInput.input] = [PROMPT_NODE_ID, 0];

  return { text, tier: patchTier(prompt, tier)?.id };
}

/**
 * Point the loader at the weights this LoRA needs, in place, and say which file
 * that was.
 *
 * Throws rather than carrying on, for the same reason the step sampler's model
 * swap does: a graph that quietly declined would load the base the LoRA was not
 * made for and finish, which is the failure this whole declaration exists to
 * prevent.
 */
function applyPatchBase(
  graph: ComfyGraph,
  label: string,
  base: PatchBase,
  alternateBase: boolean,
): string {
  const file = patchBaseFile(base, alternateBase);
  const loader = modelLoaderIn(graph);
  if (!loader) {
    throw new Error(
      `${label} loads ${file}, but this graph has no single diffusion-model loader to put it in.`,
    );
  }
  graph[loader].inputs.unet_name = file;
  return file;
}

/**
 * What is wrong with a patch's LoRA list, if anything. Read by
 * `check:workflows`.
 *
 * The splice check proves the node can be wired in. This asks the separate
 * questions the splice cannot: whether every entry has somewhere to put its
 * file, and whether the weights underneath each one are weights that LoRA
 * belongs on — the same distinction `turboProblems` draws with `requiresModel`,
 * and for the same reason. Attaching to the wrong base fails nothing at all.
 */
export function patchBaseProblems(
  patch: PatchDef,
  graph: ComfyGraph,
): string[] {
  const choices = patch.choices;
  if (!choices) return [];

  const problems: string[] = [];
  if (choices.options.length === 0) {
    problems.push(`${patch.label} offers a list of LoRAs with nothing in it.`);
  }

  const seen = new Set<string>();
  for (const option of choices.options) {
    if (seen.has(option.id)) {
      problems.push(`${patch.label} offers two LoRAs with the id "${option.id}".`);
    }
    seen.add(option.id);
  }

  for (const option of choices.options) {
    if (!option.prompt) continue;
    if (option.prompt.tiers && option.prompt.tiers.length === 0) {
      problems.push(`${option.label} offers a tier list with nothing in it.`);
    }
    const tierIds = new Set<string>();
    for (const tier of option.prompt.tiers ?? []) {
      if (tierIds.has(tier.id)) {
        problems.push(`${option.label} offers two tiers with the id "${tier.id}".`);
      }
      tierIds.add(tier.id);
    }
  }

  const loader = modelLoaderIn(graph);
  for (const option of choices.options) {
    if (!option.bases?.length) continue;
    // Only the base that applies here. The others answer for graphs this
    // workflow is not, and are checked when those workflows are.
    const base = patchBaseFor(option.bases, graph);
    if (!base) {
      problems.push(
        `${option.label} declares no checkpoint for ${
          loader ? String(graph[loader].inputs.unet_name) : "this graph's model"
        }, so the switch offering it cannot run here.`,
      );
      continue;
    }
    if (!loader) {
      problems.push(
        `${option.label} loads ${base.value}, but this graph has no single ${MODEL_LOADER} to load it into.`,
      );
      continue;
    }
    if (!("unet_name" in graph[loader].inputs)) {
      problems.push(
        `${option.label} loads ${base.value} into node ${loader}, which does not accept "unet_name".`,
      );
    }
    // Both sides of the switch, not only the default. An alternate outside the
    // list is the same mistake as a default outside it, and is the easier one to
    // make: it is the option someone reaches for when the recommended base will
    // not fit, which is exactly when a quantised one looks tempting.
    const named = base.alternate ? [base.value, base.alternate.value] : [base.value];
    for (const file of named) {
      if (!base.allowed.some((prefix) => file.startsWith(prefix))) {
        problems.push(
          `${option.label} goes on ${base.allowed.map((prefix) => `${prefix}*`).join(" or ")}, but it loads ${file}.`,
        );
      }
    }
    if (base.alternate && base.alternate.value === base.value) {
      problems.push(
        `${option.label}'s base switch offers ${base.value} on both sides, so it does nothing.`,
      );
    }
  }
  return problems;
}

/**
 * Every form this patch can take, for `check:nodes` — one per LoRA offered, and
 * one more per LoRA that offers a second base. All of them name files that no
 * stored graph does.
 */
export function patchVariants(
  graph: ComfyGraph,
  patch: PatchDef,
  promptInput?: { node: string; input: string },
): Array<{ suffix: string; graph: ComfyGraph; optional: boolean }> {
  const options = patch.choices?.options;
  if (!options?.length) {
    return [{ suffix: "", graph: patchGraph(graph, patch), optional: false }];
  }
  const variants: Array<{ suffix: string; graph: ComfyGraph; optional: boolean }> = [];
  for (const option of options) {
    // Every LoRA in the list is optional. The switch is off by default and the
    // app runs without any of them, the list is meant to grow, and nobody
    // downloads all of it — so calling them required would leave the check red
    // on a correctly set-up machine and train everyone to ignore it.
    variants.push({
      suffix: `, ${option.label.toLowerCase()}`,
      graph: patchGraph(graph, patch, { choice: option.id, promptInput }),
      optional: true,
    });
    const base = patchBaseFor(option.bases, graph);
    if (base?.alternate) {
      variants.push({
        suffix: `, ${option.label.toLowerCase()}, ${base.alternate.label.toLowerCase()}`,
        graph: patchGraph(graph, patch, {
          choice: option.id,
          alternateBase: true,
          promptInput,
        }),
        optional: true,
      });
    }
  }
  return variants;
}

/**
 * The graph this patch would actually queue. Only used by `check:nodes`, which
 * has to ask ComfyUI about classes no stored graph names — and, for a patch
 * with a `base`, about a model file no stored graph names either.
 */
export function patchGraph(
  graph: ComfyGraph,
  patch: PatchDef,
  options: PatchOptions = {},
): ComfyGraph {
  const clone = structuredClone(graph);
  applyPatch(clone, patch, options);
  return clone;
}

/** The patches a workflow offers that a run actually asked for, in chain order. */
export function enabledPatches(
  offered: PatchDef[] | undefined,
  wanted: string[] | undefined,
): PatchDef[] {
  if (!offered?.length || !wanted?.length) return [];
  return offered.filter((patch) => wanted.includes(patch.id));
}
