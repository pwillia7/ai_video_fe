import { enumValuesFor, getNodeSchema } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "@/lib/workflows/types";

/**
 * Fills in select options from the live ComfyUI schema.
 *
 * Sampler lists, schedulers, container formats and model filenames all depend
 * on what is installed on that particular machine, so hardcoding them means
 * the UI drifts from reality the moment a custom node pack is added. Resolving
 * at request time keeps the dropdowns honest.
 *
 * Never throws: if ComfyUI is unreachable the param keeps its declared static
 * options, so the app degrades to a working-but-stale UI rather than an error.
 */
export async function resolveDynamicOptions(
  workflow: WorkflowDef,
): Promise<ParamDef[]> {
  return Promise.all(
    workflow.params.map(async (param) => {
      if (param.type !== "select" || !param.optionsFrom) return param;

      const node = workflow.graph[param.optionsFrom.node];
      if (!node) return param;

      const schema = await getNodeSchema(
        param.optionsFrom.classType ?? node.class_type,
      );
      const values = enumValuesFor(schema, param.optionsFrom.input);
      if (!values || values.length === 0) return param;

      // "restrict" keeps the declared options and their labels — a curated list
      // whose live counterpart is too long to show — and only drops the ones
      // this install has stopped offering. See OptionsFrom.
      if (param.optionsFrom.mode === "restrict") {
        const live = new Set(values);
        const kept = param.options.filter((option) => live.has(option.value));
        // Everything gone means the lookup found a list that has nothing to do
        // with this control. Keep the declared options and let ComfyUI judge,
        // rather than rendering a select with no choices in it.
        return kept.length > 0 ? { ...param, options: kept } : param;
      }

      return {
        ...param,
        options: values.map((value) => ({ value, label: value })),
      };
    }),
  );
}

/**
 * The set of values a select will accept, used to validate a submission.
 * Falls back to the static list when the live lookup is unavailable, so a
 * ComfyUI blip cannot reject an otherwise valid choice.
 */
export async function allowedValuesFor(
  workflow: WorkflowDef,
  param: ParamDef,
): Promise<string[] | null> {
  if (param.type !== "select") return null;

  if (param.optionsFrom) {
    const node = workflow.graph[param.optionsFrom.node];
    if (node) {
      const schema = await getNodeSchema(
        param.optionsFrom.classType ?? node.class_type,
      );
      const values = enumValuesFor(schema, param.optionsFrom.input);
      if (values && values.length > 0) {
        if (param.optionsFrom.mode !== "restrict") return values;
        const live = new Set(values);
        const kept = param.options
          .map((option) => option.value)
          .filter((value) => live.has(value));
        // As above: an empty intersection is a lookup that went somewhere
        // unrelated, not a control with no valid values.
        if (kept.length > 0) return kept;
        return param.options.map((option) => option.value);
      }
    }
    // Live lookup failed — accept anything and let ComfyUI be the judge.
    return null;
  }

  return param.options.map((option) => option.value);
}
