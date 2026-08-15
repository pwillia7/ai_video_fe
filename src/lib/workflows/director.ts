import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamValue } from "./types";

/**
 * The prompt-rewrite stage, and the switch that takes it out of the run.
 *
 * Every graph here runs one: what the user types goes into a
 * `PrimitiveStringMultiline`, an `OAIAPI_ChatCompletion` expands it into the
 * structured format the model was trained on, and only that expansion reaches
 * the sampler. It is most of what makes a one-line prompt work at all, which is
 * why it is on by default and why the directors are as long as they are.
 *
 * It is also the one thing standing between a user and the model. Someone who
 * has written the format by hand — or who wants the same words twice, or is
 * debugging what the model does with a particular phrasing — is being edited by
 * an LLM they did not ask for, and there was no way to say no. This is that way.
 *
 * **Not the same as leaving the director in with an empty instruction.** The
 * node would still make an API call, still cost the wait, and still return
 * something other than what was typed. The point is that the graph queued with
 * the switch on contains no OpenAI node at all: nothing to reach the network,
 * nothing to need a key, nothing to go wrong at the rewrite step.
 */
export interface DirectorBypass {
  /** Id of the toggle that decides this. Its whole effect is this rewiring. */
  param: string;
  /**
   * The `OAIAPI_ChatCompletion` whose output the raw prompt replaces.
   *
   * One node rather than "every director in the graph": the music workflow has
   * a second one that writes lyrics, which is a separate switch of the user's
   * and stays exactly as they set it. What this names is the stage the prompt
   * itself passes through.
   */
  node: string;
  /** The node holding what the user typed, and the output slot to link. */
  prompt: { node: string; slot?: number };
}

/** True for a link to that node, whichever output slot it uses. */
function isLinkFrom(value: unknown, nodeId: string): boolean {
  return Array.isArray(value) && value[0] === nodeId;
}

/** Every node this one takes an input from. */
function sources(graph: ComfyGraph, id: string): string[] {
  return Object.values(graph[id].inputs)
    .filter(
      (value): value is [string, number] =>
        Array.isArray(value) && typeof value[0] === "string",
    )
    .map(([node]) => node)
    .filter((node) => graph[node] !== undefined);
}

/**
 * The nodes nothing else reads — which in a ComfyUI graph are the ones that
 * save something, and the only reason any of the others run.
 *
 * Found rather than declared, on the same grounds as the consumers in
 * model-chain.ts: the graph already knows, and a list of output classes kept
 * here would be a list to keep in step with six graphs and every re-export.
 */
function terminals(graph: ComfyGraph): string[] {
  const consumed = new Set<string>();
  for (const id of Object.keys(graph)) {
    for (const source of sources(graph, id)) consumed.add(source);
  }
  return Object.keys(graph).filter((id) => !consumed.has(id));
}

/** Ids reachable from these, following inputs. */
function reachableFrom(graph: ComfyGraph, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id) || graph[id] === undefined) continue;
    seen.add(id);
    queue.push(...sources(graph, id));
  }
  return seen;
}

/** True when the submitted values ask for the director to be skipped. */
export function bypassApplies(
  spec: DirectorBypass,
  values: Record<string, ParamValue>,
): boolean {
  return values[spec.param] === true;
}

/**
 * Take the director out of the graph, in place. Call it on a clone —
 * `applyParams` does, after `finalize`.
 *
 * After, rather than before: `finalize` prunes whatever the run did not use and
 * may still be reading nodes this removes — the reference graph's own pruning
 * writes to the batch node that only exists to feed the director.
 *
 * What goes is worked out rather than listed. Everything that read the
 * director's output reads the prompt node instead, and then anything no longer
 * reachable from the graph's own output nodes is deleted: the director, the
 * `OAIAPI_Client` behind it, and whatever existed only to be shown to it — the
 * batched reference images, the frames sampled out of a source clip. A list per
 * graph would be six lists to keep right, and the failure would be a node left
 * behind holding an input that no longer exists.
 *
 * The roots are read *before* the rewiring, because the point of the pass is
 * that nodes stop being reachable: asked afterwards, the batch node nothing
 * reads any more would look like an output node and be kept.
 */
export function applyBypass(graph: ComfyGraph, spec: DirectorBypass): void {
  const roots = terminals(graph);
  const link = [spec.prompt.node, spec.prompt.slot ?? 0];

  for (const node of Object.values(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLinkFrom(value, spec.node)) node.inputs[input] = [...link];
    }
  }

  const keep = reachableFrom(graph, roots);
  for (const id of Object.keys(graph)) {
    if (!keep.has(id)) delete graph[id];
  }
}

/** The graph this would queue. Used by `check:workflows` and the probes. */
export function bypassedGraph(
  graph: ComfyGraph,
  spec: DirectorBypass,
): ComfyGraph {
  const clone = structuredClone(graph);
  applyBypass(clone, spec);
  return clone;
}

/**
 * Whether the switch would do what it says on this graph.
 *
 * Worth checking here rather than discovering at generation time, and worth
 * checking in both directions. A `node` nothing reads would leave the switch
 * doing nothing at all — the director would still run and the user's text would
 * still be rewritten, with the form saying otherwise. A prompt node that got
 * pruned would leave the sampler reading a node that is not there, which
 * ComfyUI rejects outright.
 */
export function bypassProblems(
  spec: DirectorBypass,
  graph: ComfyGraph,
  params: ParamDef[],
): string[] {
  const problems: string[] = [];

  const param = params.find((candidate) => candidate.id === spec.param);
  if (!param) {
    problems.push(
      `The director bypass keys off "${spec.param}", which this workflow has no param for.`,
    );
  } else if (param.type !== "toggle") {
    problems.push(
      `The director bypass keys off "${spec.param}", which is a ${param.type} rather than a toggle.`,
    );
  }

  if (!graph[spec.node]) {
    problems.push(
      `The director bypass names node ${spec.node}, which is not in the graph.`,
    );
    return problems;
  }
  if (!graph[spec.prompt.node]) {
    problems.push(
      `The director bypass reads the prompt from node ${spec.prompt.node}, which is not in the graph.`,
    );
    return problems;
  }

  // The node standing in for the director has to be the one the director was
  // reading, or this is not a bypass — it is a different input wired into the
  // sampler. Both are node ids in the same declaration and nothing else would
  // notice them being the wrong way round: the graph would queue, and the model
  // would be handed whatever that other node produces.
  // Its `prompt` input specifically, not any input: the client node is linked
  // to the director too, and standing that in for the rewrite would queue a
  // graph that runs and hands the model whatever an API client node produces.
  if (!isLinkFrom(graph[spec.node].inputs.prompt, spec.prompt.node)) {
    problems.push(
      `The director bypass stands node ${spec.prompt.node} in for the rewrite, but ${graph[spec.node].class_type} (node ${spec.node}) does not take its \`prompt\` from there.`,
    );
  }

  const readers = Object.keys(graph).filter((id) =>
    Object.values(graph[id].inputs).some((value) =>
      isLinkFrom(value, spec.node),
    ),
  );
  if (readers.length === 0) {
    problems.push(
      `Nothing reads node ${spec.node} (${graph[spec.node].class_type}), so the director bypass would leave the graph exactly as it is.`,
    );
    return problems;
  }

  const bypassed = bypassedGraph(graph, spec);
  if (!bypassed[spec.prompt.node]) {
    problems.push(
      `Bypassing the director prunes node ${spec.prompt.node}, which is where the prompt was supposed to come from.`,
    );
  }
  if (
    Object.values(bypassed).some((node) =>
      Object.values(node.inputs).some(
        (value) =>
          Array.isArray(value) &&
          typeof value[0] === "string" &&
          bypassed[value[0]] === undefined,
      ),
    )
  ) {
    problems.push(
      "Bypassing the director leaves a link pointing at a node it deleted.",
    );
  }

  return problems;
}

/**
 * Hide the controls that exist only to instruct the director, while it is being
 * skipped.
 *
 * Read off the wiring rather than listed: a control whose every target is the
 * director's own node has no other way to reach the model, so with that node
 * gone it does nothing at all. The reference facet selects are the case this is
 * for — four dropdowns about how to describe a picture, in a run where nothing
 * is being described. Controls that write the graph *and* the director keep
 * their place, which is most of them: the duration still sets the length.
 *
 * `hiddenBy` is presentation only, so what was set is kept and comes back with
 * the switch. Nothing has to be pruned to match, because `applyBypass` deletes
 * the node these were writing to.
 */
export function hideDirectorOnly(
  params: ParamDef[],
  spec: DirectorBypass,
): ParamDef[] {
  return params.map((param) => {
    const onlyDirector =
      param.targets.length > 0 &&
      param.targets.every((target) => target.node === spec.node);
    if (!onlyDirector) return param;

    const existing =
      param.hiddenBy === undefined
        ? []
        : Array.isArray(param.hiddenBy)
          ? param.hiddenBy
          : [param.hiddenBy];
    return { ...param, hiddenBy: [...existing, spec.param] };
  });
}
