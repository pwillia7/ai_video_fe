"use client";

import type { ParamValue } from "@/lib/workflows/types";

/**
 * A submitted generation, tracked from queue to result and kept afterwards as
 * history.
 *
 * Only the reference is stored, never the video itself: the file lives on the
 * ComfyUI box and is streamed through /api/media on demand. localStorage holds
 * a few megabytes at best, so storing media here would blow the budget after a
 * couple of clips. The trade is that history entries go dead if ComfyUI's
 * output directory is cleared.
 */

export type JobPhase =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "unknown";

export interface JobOutput {
  url: string;
  filename: string;
  subfolder: string;
  type: string;
}

export interface Job {
  promptId: string;
  workflowId: string;
  workflowName: string;
  /** Kept for the history list, where the prompt is the only useful label. */
  prompt: string;
  /**
   * The generation whose clip this one was made from — remixed or extended.
   * Lets the history show a clip and what came out of it as one family rather
   * than as unrelated entries that happen to sit near each other.
   */
  derivedFrom?: string;
  /**
   * Whether the turbo LoRA was spliced in. Recorded because it changes how
   * long the run takes by a factor, so mixing the two modes together would
   * teach the estimate a median that describes neither.
   */
  turbo?: boolean;
  /**
   * Which single-node switches were on, by id. Recorded for the same reason as
   * turbo: each sits in front of the sampler, so each changes what a run costs,
   * and the estimate is only honest if it is learned from runs made the same
   * way.
   */
  patches?: string[];
  hasAudio: boolean;
  /**
   * Marked by the user as worth keeping. Purely an organising flag — it sorts
   * the entry into its own section at the top of the history and protects it
   * from the bulk clears and from eviction, but changes nothing about the file
   * itself, which is on the ComfyUI box either way.
   */
  favorite?: boolean;
  submittedAt: number;
  /**
   * When ComfyUI actually started rendering, as opposed to when it accepted
   * the job. With a queue these diverge, and mixing them up would make the
   * progress bar and every learned estimate include time spent waiting.
   */
  startedAt?: number;
  completedAt?: number;
  phase: JobPhase;
  queuePosition: number | null;
  outputs: JobOutput[];
  error?: string;
  resolved: Record<string, ParamValue>;
  estimatedSeconds: number | null;
}

const STORAGE_KEY = "sorant-jobs";

/**
 * How much of `localStorage` the history may take, in characters of JSON.
 *
 * A budget rather than a count of runs, because a run is not a fixed size and
 * the count was answering the wrong question. What is stored per generation is
 * its references and the settings it was made with — no media, see above — and
 * that comes to roughly 0.8–1.3KB for an ordinary prompt and about 17KB for one
 * written to the 8000-character limit. A flat cap of fifty was therefore
 * somewhere between 40KB and 800KB depending on how much people type, which is
 * to say it was not a storage limit at all; it was a guess that cost most users
 * their history at around 1% of what the browser would have held.
 *
 * 2M characters is about as far as this can honestly go, and the reason is the
 * unit. An origin gets around 5MB, but browsers meter that in UTF-16 code
 * units — two bytes a character — so the real ceiling is nearer 2.5M
 * characters for everything this app stores, params included. A budget of
 * "5MB" would therefore ask for roughly twice the quota and be refused, which
 * is a worse failure than a smaller history: every write would fall down the
 * ladder in `writeJobs` before it stuck.
 *
 * At that size it holds around 1800 ordinary generations, and degrades the
 * right way — someone who writes enormous prompts keeps fewer of them rather
 * than getting a broken write.
 *
 * Compute is no longer the argument against a big history, but it was: this
 * blob used to be stringified on every poll tick, so its size was paid every
 * 1.5 seconds for as long as a render ran. A tick that changes nothing now
 * returns the same array and writes nothing at all — see the poll in
 * use-jobs.ts — so the cost is paid when something actually happens. What is
 * left is a parse on load, a few milliseconds at this size.
 *
 * Unlimited is not on the table whatever the compute: `localStorage` writes are
 * synchronous and block the main thread, and past the quota they throw. A cap
 * is what keeps the failure "the oldest entries went" instead of "history
 * silently stopped saving".
 */
const MAX_HISTORY_CHARS = 2_000_000;
/** A job still unresolved after this long is not coming back. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isActive(job: Job): boolean {
  return job.phase === "queued" || job.phase === "running";
}

export function isFavorite(job: Job): boolean {
  return job.favorite === true;
}

/**
 * The favourited entries and everything else, each in the order they arrived.
 *
 * Lifted out rather than merely sorted to the top: an entry appears in the
 * favourites section *instead of* under its day, so the same generation is
 * never on screen twice and a day's Download and Delete act on exactly the rows
 * that day is showing.
 */
export function partitionFavorites(jobs: Job[]): {
  favorites: Job[];
  rest: Job[];
} {
  const favorites: Job[] = [];
  const rest: Job[] = [];
  for (const job of jobs) (isFavorite(job) ? favorites : rest).push(job);
  return { favorites, rest };
}

/** What a generation can come back as with no picture in it. */
const AUDIO_ONLY = /\.(mp3|flac|wav|opus|ogg|m4a)$/i;

/**
 * Whether this generation is sound and nothing else.
 *
 * Read off the file that came back rather than off the workflow that made it,
 * because history outlives the registry: a job stored last month names a
 * workflow id that may since have been renamed or removed, and its own filename
 * still answers the question. False while a job is still running, which is
 * correct — there is nothing to play yet either.
 */
export function isAudioOnly(job: Job): boolean {
  const primary = job.outputs[0];
  return primary !== undefined && AUDIO_ONLY.test(primary.filename);
}

export function readJobs(): Job[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Job & { remixOf?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((job) => typeof job?.promptId === "string")
      // History written before Extend existed keyed the lineage on `remixOf`,
      // back when a remix was the only way one generation could come from
      // another. Read it forward rather than dropping those threads.
      .map(({ remixOf, ...job }) =>
        job.derivedFrom === undefined && remixOf !== undefined
          ? { ...job, derivedFrom: remixOf }
          : job,
      );
  } catch {
    return [];
  }
}

/**
 * The newest entries that fit in the budget, plus anything still running.
 *
 * A job in flight is not history: its entry is the only record of what to poll
 * and what to cancel, so losing it to a size limit would strand a render nobody
 * can reach. Those are kept whatever they cost — there are only ever a handful,
 * and they become evictable the moment they finish.
 *
 * Favourites go next, newest first, because marking one is the user saying this
 * is the entry to keep — losing it to a run of newer takes would answer that
 * with the opposite. They still queue for the same budget rather than being
 * exempt from it like an in-flight job: there can be any number of them, and
 * "the newest favourites survive" degrades far better than a write the browser
 * refuses outright.
 *
 * The rest fill what is left, newest first, stopping at the first that does not
 * fit rather than skipping it to pack in smaller older ones. That keeps the
 * contract one sentence long — history is the most recent runs that fit — which
 * is worth more than the entries a knapsack would recover, given an entry would
 * have to be sixty times the usual size for the two to differ.
 */
export function trimToBudget(jobs: Job[], budget = MAX_HISTORY_CHARS): Job[] {
  const ordered = sortJobs(jobs);
  const keep = new Set<string>();
  // The array's own brackets, and a comma per entry after the first.
  let used = 2;

  const sizeOf = (job: Job) => JSON.stringify(job).length + 1;

  for (const job of ordered) {
    if (!isActive(job)) continue;
    keep.add(job.promptId);
    used += sizeOf(job);
  }

  for (const pass of [isFavorite, () => true]) {
    for (const job of ordered) {
      if (keep.has(job.promptId) || !pass(job)) continue;
      const size = sizeOf(job);
      // `break` rather than `continue`, per the note above — but only out of
      // this pass, so an oversized favourite does not also stop the ordinary
      // history from filling whatever is left.
      if (used + size > budget) break;
      keep.add(job.promptId);
      used += size;
    }
  }

  return ordered.filter((job) => keep.has(job.promptId));
}

export function writeJobs(jobs: Job[]): void {
  // Halving rather than giving up on the first refusal: the budget above is
  // this app's own share, but the quota is the origin's, so a write can be
  // refused while we are well inside our own limit. Shedding history is a
  // better answer than silently keeping none of it.
  for (const budget of [MAX_HISTORY_CHARS, MAX_HISTORY_CHARS / 4, 50_000]) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(trimToBudget(jobs, budget)),
      );
      return;
    } catch {
      // Try again with less. Storage being disabled outright fails every pass,
      // and falls out of the loop having done nothing — history is a
      // convenience, and it must not break generation.
    }
  }
}

/** Newest first, which is the order the history list wants. */
export function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => b.submittedAt - a.submittedAt);
}

/**
 * Anything left queued or running from a previous session that ComfyUI can no
 * longer be asked about. Marked rather than deleted so the history does not
 * silently lose entries.
 */
export function expireStale(jobs: Job[], now = Date.now()): Job[] {
  return jobs.map((job) =>
    isActive(job) && now - job.submittedAt > STALE_AFTER_MS
      ? { ...job, phase: "unknown" as const }
      : job,
  );
}

/**
 * Render time, excluding any wait in the queue.
 *
 * Null when the job was never seen running, rather than falling back to
 * `submittedAt`. That fallback looked harmless but scored queue wait as render
 * time: close the tab with five jobs queued, come back, and every one of them
 * reports submit-to-reopen. Those samples then became the median and the
 * progress bar started pacing minutes of rendering against an hour.
 *
 * A job that taught us nothing is better than a job that taught us a lie —
 * learnedEstimateSeconds drops nulls and falls back to the static estimate.
 */
export function renderMs(job: Job): number | null {
  if (job.completedAt === undefined || job.startedAt === undefined) return null;
  return job.completedAt - job.startedAt;
}

/**
 * How long this workflow, in this mode, actually takes on this machine.
 *
 * ComfyUI's API carries no estimate — a running job reports only its id,
 * status, priority and creation time, and step-level progress exists solely on
 * the WebSocket, which cannot be proxied. But the history here already holds
 * real completion times, so the honest estimate is the user's own median
 * rather than a number hardcoded when the workflow was written.
 *
 * Median over the last few runs, so one anomalous render does not skew it.
 */
export function learnedEstimateSeconds(jobs: Job[], job: Job): number | null {
  const wanted = modeKey(job);
  const samples = jobs
    .filter(
      (other) =>
        other.workflowId === job.workflowId &&
        // Same graph, very different render time — for every switch, so the
        // whole set has to match. History from before a switch existed carries
        // no record of it and so reads as off, which is what those runs were.
        modeKey(other) === wanted &&
        other.phase === "done",
    )
    .map(renderMs)
    .filter((ms): ms is number => ms !== null && ms > 0)
    .slice(0, 5);

  if (samples.length === 0) return job.estimatedSeconds;

  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] / 1000);
}

/**
 * Which combination of switches a run was made with, as one comparable string.
 * Sorted so two runs with the same switches on match however they were stored.
 */
function modeKey(job: Job): string {
  return [job.turbo ? "turbo" : "", ...(job.patches ?? [])].sort().join("|");
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Local calendar day, as a sortable key. Built from the date parts rather than
 * by dividing the timestamp: a day is not reliably 24 hours long once daylight
 * saving is involved, and "which day was this" has to agree with the calendar
 * the user is looking at, not with UTC.
 */
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function dayLabel(timestamp: number, now = Date.now()): string {
  const key = dayKey(timestamp);
  if (key === dayKey(now)) return "Today";

  // Stepping the calendar date back by one rather than subtracting 24 hours,
  // for the same reason as above — on the day the clocks change, subtracting
  // would land on the wrong side of midnight.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    // The year only earns its place once it is not this one.
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/** Newest day first, and newest job first within each — as `sortJobs` leaves them. */
export function groupByDay(
  jobs: Job[],
  now = Date.now(),
): Array<{ key: string; label: string; jobs: Job[] }> {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = dayKey(job.submittedAt);
    const existing = groups.get(key);
    if (existing) existing.push(job);
    else groups.set(key, [job]);
  }
  return [...groups.entries()].map(([key, dayJobs]) => ({
    key,
    label: dayLabel(dayJobs[0].submittedAt, now),
    jobs: dayJobs,
  }));
}

export interface LineageRow {
  job: Job;
  /** 0 for a source, deeper for a take on a take. Capped for indentation. */
  depth: number;
}

/**
 * Orders one day's jobs so a remix or extension sits directly beneath what it
 * came from.
 *
 * Families are placed by their *newest* member, but read oldest-first inside —
 * so recent work still surfaces at the top of the list while a source and what
 * came out of it stay together, in the order they actually happened.
 *
 * A derived job whose source is not in the same day, or has been deleted from
 * history, is simply a root of its own. Nothing here assumes the chain is
 * complete, because history is per-device and gets pruned.
 */
export function lineageOrder(jobs: Job[]): LineageRow[] {
  const present = new Map(jobs.map((job) => [job.promptId, job]));
  const parentOf = (job: Job) =>
    job.derivedFrom ? present.get(job.derivedFrom) : undefined;

  const rootOf = new Map<string, string>();
  const depthOf = new Map<string, number>();

  for (const job of jobs) {
    let current = job;
    let depth = 0;
    // `seen` guards against a cycle in stored data, which would otherwise be
    // an infinite loop on a value that came out of localStorage.
    const seen = new Set([job.promptId]);
    for (
      let parent = parentOf(current);
      parent && !seen.has(parent.promptId);
      parent = parentOf(current)
    ) {
      seen.add(parent.promptId);
      current = parent;
      depth += 1;
    }
    rootOf.set(job.promptId, current.promptId);
    depthOf.set(job.promptId, depth);
  }

  // Insertion order gives families their position: `jobs` arrives newest
  // first, so a family lands where its most recent member would have.
  const families = new Map<string, Job[]>();
  for (const job of jobs) {
    const root = rootOf.get(job.promptId)!;
    const existing = families.get(root);
    if (existing) existing.push(job);
    else families.set(root, [job]);
  }

  const rows: LineageRow[] = [];
  // Shared across families, not per family: a cycle can make two families name
  // each other's root, and a set scoped to one of them would emit both jobs
  // twice.
  const emitted = new Set<string>();

  for (const [rootId, members] of families) {
    // Siblings under each parent, oldest first, so a family reads downward in
    // the order it was actually made.
    const childrenOf = new Map<string, Job[]>();
    for (const member of members) {
      if (member.promptId === rootId) continue;
      const parent =
        member.derivedFrom && present.has(member.derivedFrom)
          ? member.derivedFrom
          : rootId;
      const siblings = childrenOf.get(parent);
      if (siblings) siblings.push(member);
      else childrenOf.set(parent, [member]);
    }
    for (const siblings of childrenOf.values()) {
      siblings.sort((a, b) => a.submittedAt - b.submittedAt);
    }

    // Depth-first, so a remix of a remix sits under the remix it came from
    // rather than merely later in the family.
    const walk = (job: Job) => {
      if (emitted.has(job.promptId)) return;
      emitted.add(job.promptId);
      rows.push({ job, depth: Math.min(depthOf.get(job.promptId) ?? 0, 2) });
      for (const child of childrenOf.get(job.promptId) ?? []) walk(child);
    };

    const root = present.get(rootId);
    if (root) walk(root);
    // A cycle in stored data can leave members unreachable from the root.
    // Losing an entry from the history would be worse than showing it flat.
    for (const member of [...members].sort((a, b) => a.submittedAt - b.submittedAt)) {
      walk(member);
    }
  }
  return rows;
}

export function formatWhen(timestamp: number, now = Date.now()): string {
  const elapsed = now - timestamp;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
