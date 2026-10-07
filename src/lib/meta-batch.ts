/**
 * Following a run that VHS's Meta Batch Manager splits into several prompts.
 *
 * A graph with a `VHS_BatchManager` does not finish in one prompt. Each pass
 * loads the next slice of frames, runs the whole graph on it, and appends the
 * result to an output file the `VHS_VideoCombine` node holds open; at the end
 * of the pass VHS queues the same graph again *server-side*, under a new
 * prompt id, at the front of the queue. Only the last pass closes the file and
 * reports it. The first prompt — the one this app submitted and tracks —
 * finishes after its slice with no file, its combine node reporting
 * `unfinished_batch` instead.
 *
 * So a run is identified by something that survives the requeue rather than
 * by its prompt id: the combine node's `filename_prefix`, which `finalize`
 * makes unique per submission, and which VHS copies into every pass unchanged.
 */

import {
  getHistoryEntries,
  type ComfyGraph,
  type ComfyHistoryEntry,
  type ComfyQueue,
} from "./comfy";

const COMBINE = "VHS_VideoCombine";
const MANAGER = "VHS_BatchManager";

/**
 * How many recent history entries to search for the rest of a run. A run's
 * passes are queued at the front, so they sit together at the top of the
 * history; this only has to cover one run's worth of them plus anything that
 * finished while the client was not polling.
 */
const HISTORY_WINDOW = 64;

/** The prefix that names one batched run, or null for an ordinary graph. */
export function runKey(graph: unknown): string | null {
  if (!graph || typeof graph !== "object") return null;
  const nodes = Object.values(graph as ComfyGraph);
  if (!nodes.some((node) => node?.class_type === MANAGER)) return null;
  const combine = nodes.find((node) => node?.class_type === COMBINE);
  const prefix = combine?.inputs?.filename_prefix;
  return typeof prefix === "string" && prefix ? prefix : null;
}

/** The graph inside a queue item or a history entry: index 2 of the tuple. */
export function graphOf(item: unknown): unknown {
  return Array.isArray(item) ? item[2] : undefined;
}

/** Whether a finished prompt was one slice of a batched run, not its end. */
export function isUnfinishedBatch(entry: ComfyHistoryEntry): boolean {
  return Object.values(entry.outputs ?? {}).some(
    (output) => output && "unfinished_batch" in output,
  );
}

/** Every queue item — running first — that belongs to the run. */
export function livePasses(queue: ComfyQueue, key: string): unknown[][] {
  return [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].filter(
    (item) => runKey(graphOf(item)) === key,
  );
}

/**
 * Where a batched run has got to, once its first prompt has finished a slice.
 *
 * - A pass still queued or running: the run is running. VHS queues the next
 *   pass before the current one is recorded as finished, so there is no gap
 *   between passes in which the run looks stopped.
 * - Otherwise the run's last recorded pass decides: a file means done, an
 *   error is the run's error. A pass that was cut off and left nothing queued
 *   behind it is a run that stopped — interrupted, or ComfyUI restarted.
 */
export async function followRun(
  key: string,
  queue: ComfyQueue,
): Promise<
  | { state: "running"; passes: number }
  | { state: "finished"; entry: ComfyHistoryEntry }
  | { state: "stopped"; passes: number }
> {
  const history = await getHistoryEntries(HISTORY_WINDOW);
  const recorded = Object.values(history).filter(
    (entry) => runKey(graphOf(entry.prompt)) === key,
  );

  if (livePasses(queue, key).length > 0) {
    return { state: "running", passes: recorded.length + 1 };
  }

  const last = recorded.find(
    (entry) => !isUnfinishedBatch(entry) || entry.status?.status_str === "error",
  );
  if (last) return { state: "finished", entry: last };
  return { state: "stopped", passes: recorded.length };
}
