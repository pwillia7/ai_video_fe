/**
 * The ways a run can differ from the plain graph.
 *
 * None of these is a param: they change which graph gets queued rather than a
 * value inside one, and the nodes they speak for are not in the stored graph at
 * all. See turbo.ts, patches.ts, and model-chain.ts for the splice they share.
 *
 * Named here rather than in either of those files because both halves of the
 * app need the set — the server to decide what to splice, the browser to say
 * what a finished run was.
 */
export interface RunModes {
  /** Run with the distilled LoRA spliced in. */
  turbo?: boolean;
  /**
   * Ids of the single-node switches that were on. Ids rather than labels
   * because this is what a stored job and an API request carry, and a label is
   * wording that may be improved later; `workflowLabel` resolves them against
   * whatever the workflow currently offers.
   */
  patches?: string[];
  /**
   * Which LoRA each switch that offers a list is set to, by patch id — the
   * entry's id, not its file. The browser is never given the model filenames,
   * so the id is the whole of what it can say. See `PatchChoice`.
   */
  lora?: Record<string, string>;
  /**
   * How strong each LoRA is applied, keyed by the *entry's* id rather than the
   * switch's.
   *
   * By entry because the number belongs to the LoRA: each converges somewhere
   * different, and their ranges differ, so switching LoRAs should find that
   * one's own setting rather than inherit a number the new range may not even
   * contain. Ids naming nothing are ignored.
   */
  strengths?: Record<string, number>;
  /**
   * Which LoRAs were asked to load their alternate base, by entry id.
   *
   * A boolean rather than a filename, for the same reason as `lora` above —
   * see `PatchBaseAlternate`. Ids naming no entry, or an entry offering no
   * alternate, are ignored.
   */
  alternateBase?: Record<string, boolean>;
  /**
   * Which graded trigger phrase each LoRA is set to, by entry id — see
   * `PatchPrompt`. Ids naming nothing are ignored.
   */
  tier?: Record<string, string>;
}

/**
 * How a run is named once its modes are part of what it is — in the history, in
 * the notification, and above the tips.
 *
 * `offered` supplies the wording for the patch ids, since a run records only
 * which ones it had and the workflow is what knows their names. Iterating it
 * rather than `modes.patches` is also what keeps the order stable and quietly
 * drops an id the workflow no longer offers.
 */
export function workflowLabel(
  name: string,
  modes: RunModes,
  offered: ReadonlyArray<{ id: string; label: string }> = [],
): string {
  const marks: string[] = [];
  if (modes.turbo) marks.push("Turbo");
  for (const patch of offered) {
    if (modes.patches?.includes(patch.id)) marks.push(patch.label);
  }
  return marks.length > 0 ? `${name} (${marks.join(" + ")})` : name;
}
