import type { ComfyGraph, ComfyHistoryEntry } from "@/lib/comfy";
import { LOCAL_CLASS } from "./local-director";
import { REWRITE_CLASSES } from "./rewrite-model";

/**
 * Keeping what the director wrote, so it can be read back afterwards.
 *
 * The brief is the most consequential text in a run and, until now, the one
 * nobody could see: it went from the director straight into the text encoder
 * and existed nowhere else. Whether a take went wrong because of the video
 * model or because of what it was told is unanswerable without it.
 *
 * ComfyUI only records what an *output* node produces, so each director gets a
 * `PreviewAny` reading its output 0 — the brief on every class a director can
 * be, gateway or local. Its text lands in the run's history beside the video,
 * which the status route is already reading.
 */
const BRIEF_SUFFIX = ":brief";
const BRIEF_CLASS = "PreviewAny";
const DIRECTOR_CLASSES = [...REWRITE_CLASSES, LOCAL_CLASS];

/**
 * Give every director a preview of its output, in place. Call it last —
 * `applyParams` does, after the bypass — so a director the run no longer has
 * gets none, rather than a preview reading a node that is gone.
 */
export function attachBriefPreviews(graph: ComfyGraph): void {
  for (const [id, node] of Object.entries(graph)) {
    if (!DIRECTOR_CLASSES.includes(node.class_type)) continue;
    graph[`${id}${BRIEF_SUFFIX}`] = {
      class_type: BRIEF_CLASS,
      inputs: { source: [id, 0] },
      // What the director does, without which service does it: the local
      // director keeps the gateway node's title, so the service would be wrong
      // on half the runs. "Rewrite Prompt", "Write Lyrics".
      _meta: {
        title: (node._meta?.title ?? "Director").replace(/^AI Gateway - /, ""),
      },
    };
  }
}

/**
 * What each director wrote on a finished run, by its title. Empty when the run
 * had no director — written as typed — or predates the previews.
 *
 * Titled from the queued graph that ComfyUI keeps in the history entry, which
 * is how the music workflow's two read as "caption" and "lyrics" rather than
 * as two node ids.
 */
export function briefsFrom(entry: ComfyHistoryEntry): Record<string, string> {
  const queued = Array.isArray(entry.prompt)
    ? (entry.prompt[2] as ComfyGraph | undefined)
    : undefined;
  const briefs: Record<string, string> = {};

  for (const [id, output] of Object.entries(entry.outputs ?? {})) {
    if (!id.endsWith(BRIEF_SUFFIX)) continue;
    const text = (output as { text?: unknown }).text;
    if (!Array.isArray(text)) continue;
    const brief = text.filter((part) => typeof part === "string").join("").trim();
    if (!brief) continue;
    const title = queued?.[id]?._meta?.title ?? "Director";
    briefs[title in briefs ? `${title} (${id})` : title] = brief;
  }

  return briefs;
}
