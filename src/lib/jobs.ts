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
  hasAudio: boolean;
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
/** Enough to be useful as history without crowding storage. */
const MAX_JOBS = 50;
/** A job still unresolved after this long is not coming back. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isActive(job: Job): boolean {
  return job.phase === "queued" || job.phase === "running";
}

export function readJobs(): Job[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Job[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((job) => typeof job?.promptId === "string");
  } catch {
    return [];
  }
}

export function writeJobs(jobs: Job[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, MAX_JOBS)));
  } catch {
    // Quota exceeded or storage disabled. History is a convenience, so drop it
    // rather than letting a storage failure break generation.
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

/** Render time, excluding any wait in the queue. */
export function renderMs(job: Job): number | null {
  if (job.completedAt === undefined) return null;
  return job.completedAt - (job.startedAt ?? job.submittedAt);
}

/**
 * How long this workflow actually takes on this machine.
 *
 * ComfyUI's API carries no estimate — a running job reports only its id,
 * status, priority and creation time, and step-level progress exists solely on
 * the WebSocket, which cannot be proxied. But the history here already holds
 * real completion times, so the honest estimate is the user's own median
 * rather than a number hardcoded when the workflow was written.
 *
 * Median over the last few runs, so one anomalous render does not skew it.
 */
export function learnedEstimateSeconds(
  jobs: Job[],
  workflowId: string,
  fallback: number | null,
): number | null {
  const samples = jobs
    .filter((job) => job.workflowId === workflowId && job.phase === "done")
    .map(renderMs)
    .filter((ms): ms is number => ms !== null && ms > 0)
    .slice(0, 5);

  if (samples.length === 0) return fallback;

  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] / 1000);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
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
