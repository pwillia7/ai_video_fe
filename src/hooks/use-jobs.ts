"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusPayload } from "@/app/api/status/route";
import { api, ApiError } from "@/lib/client";
import {
  expireStale,
  learnedEstimateSeconds,
  isActive,
  isAudioOnly,
  isFavorite,
  readJobs,
  sortJobs,
  writeJobs,
  type Job,
} from "@/lib/jobs";
import { notify } from "@/lib/notifications";
import { workflowLabel, type RunModes } from "@/lib/workflows/modes";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

const POLL_INTERVAL_MS = 1500;
/**
 * ComfyUI reports nothing for a moment between accepting a prompt and queueing
 * it. Only treat "unknown" as lost once a job has had well past that to appear.
 */
const SETTLE_GRACE_MS = 60_000;

/**
 * When to stop asking about a job and call the connection, rather than the run,
 * the thing that is broken.
 *
 * Both conditions have to hold, because either one alone gets a case wrong. A
 * count alone trips too early when the failures are instant — a refused
 * connection answers in milliseconds, so three of those are over in a few
 * seconds and a passing blip would kill a render that was going to be fine. A
 * duration alone trips on a single slow answer: an unreachable host is more
 * often blackholed than refused, and one poll then sits for the route's whole
 * 20-second ComfyUI timeout, which is not yet evidence of anything.
 *
 * Together they say: several failures in a row, spanning long enough that this
 * is not a hiccup. In practice that lands around a minute either way — well
 * past any blip, and well short of the day `expireStale` would otherwise take
 * to notice, which is the behaviour this replaces.
 */
const MAX_POLL_FAILURES = 3;
const GIVE_UP_AFTER_MS = 45_000;

/** Backoff for the nth consecutive failure, capped to stay responsive. */
function retryDelayMs(failures: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, 10_000);
}

interface GenerateResponse {
  promptId: string;
  queueNumber: number;
  resolved: Record<string, ParamValue>;
  /** The switches the run actually got, which can be fewer than were asked for. */
  patches?: string[];
  estimatedSeconds: number | null;
}

export interface JobsController {
  /** Newest first. */
  jobs: Job[];
  activeCount: number;
  /** Median render time for a job's workflow and mode, from this device's own history. */
  estimateFor: (job: Job) => number | null;
  submitting: boolean;
  submitError: string | null;
  submitErrorField: string | null;
  submit: (
    workflow: WorkflowSummary,
    values: Record<string, ParamValue>,
    /** Each mode is only offered where the workflow declares it. */
    options?: RunModes & {
      /** Apply the turbo LoRA the memory-sparing way. Nothing without turbo. */
      lowVram?: boolean;
      /** The generation whose clip this one was made from, if any. */
      derivedFrom?: string;
    },
  ) => Promise<void>;
  cancel: (promptId: string) => Promise<void>;
  remove: (promptId: string) => void;
  /** Drop several at once, so a day's worth is one state write. */
  removeMany: (promptIds: string[]) => void;
  /** Mark or unmark a generation as one to keep. */
  toggleFavorite: (promptId: string) => void;
  /** Everything finished except the favourites, which is the point of them. */
  clearFinished: () => void;
  dismissSubmitError: () => void;
}

/** Fold a poll result into a job, returning the same object when nothing moved. */
function applyStatus(job: Job, status: StatusPayload | undefined): Job {
  if (!status) return job;

  if (status.state === "done") {
    if (job.phase === "done") return job;
    return {
      ...job,
      phase: "done",
      queuePosition: null,
      outputs: status.outputs,
      completedAt: Date.now(),
    };
  }

  if (status.state === "error") {
    if (job.phase === "error") return job;
    return {
      ...job,
      phase: "error",
      queuePosition: null,
      error: status.error ?? "The workflow failed while executing.",
      completedAt: Date.now(),
    };
  }

  if (status.state === "unknown") {
    // Either still settling, or gone for good — ComfyUI restarted and dropped
    // its history, or it was cancelled outside this app.
    if (Date.now() - job.submittedAt < SETTLE_GRACE_MS) return job;
    if (job.phase === "unknown") return job;
    return { ...job, phase: "unknown", queuePosition: null };
  }

  const phase = status.state === "running" ? "running" : "queued";
  // Stamp the moment it leaves the queue, so progress and learned estimates
  // measure rendering rather than waiting.
  const startedAt =
    phase === "running" && job.startedAt === undefined
      ? Date.now()
      : job.startedAt;

  if (
    job.phase === phase &&
    job.queuePosition === status.queuePosition &&
    job.startedAt === startedAt
  ) {
    return job;
  }
  return { ...job, phase, queuePosition: status.queuePosition, startedAt };
}

export function useJobs(): JobsController {
  const [jobs, setJobs] = useState<Job[]>(() =>
    expireStale(sortJobs(readJobs())),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorField, setSubmitErrorField] = useState<string | null>(null);

  useEffect(() => {
    writeJobs(jobs);
  }, [jobs]);

  // Announce each finished job once. Held in a ref so a re-render cannot
  // produce a duplicate and a reload does not re-announce old history.
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const job of jobs) {
      if (job.phase !== "done" && job.phase !== "error") continue;
      if (notifiedRef.current.has(job.promptId)) continue;
      notifiedRef.current.add(job.promptId);

      // Skip anything already finished when the page loaded.
      if (!job.completedAt || Date.now() - job.completedAt > 10_000) continue;

      if (job.phase === "done") {
        // Named after what actually came back, for the same reason the Generate
        // button is: a desktop notification saying "Video ready" for an mp3 is
        // the app telling someone something untrue while they are elsewhere.
        notify(
          isAudioOnly(job) ? "Music ready" : "Video ready",
          job.workflowName,
          job.promptId,
        );
      } else {
        notify("Generation failed", job.error ?? job.workflowName, job.promptId);
      }
    }
  }, [jobs]);

  const activeIds = useMemo(
    () =>
      jobs
        .filter(isActive)
        .map((job) => job.promptId)
        .sort()
        .join(","),
    [jobs],
  );

  /**
   * Stop waiting on the given jobs, and try to stop the box working on them.
   *
   * Reached only from the poll loop, once the status checks have failed for long
   * enough that the connection is the broken thing. The alternative is what this
   * replaces: a job that sits at "Rendering" with a progress bar filling against
   * an estimate, indistinguishable from a slow render, until `expireStale`
   * quietly relabels it a day later. A generation nobody is waiting on any more
   * should say so.
   *
   * The cancel is best effort and deliberately sent after the state is settled.
   * If ComfyUI is unreachable it will fail exactly as the status checks did, and
   * making the user watch two more timeouts to be told what already happened
   * would be worse than telling them the run might outlive the tab. When it does
   * land — the box is up but something between here and it is not — it saves a
   * GPU several minutes of work on a clip nothing will collect.
   */
  const abandonActive = useCallback(
    async (promptIds: string[], cause: unknown) => {
      const detail =
        cause instanceof ApiError
          ? cause.message
          : "Lost contact with the server.";
      const doomed = new Set(promptIds);

      setJobs((previous) =>
        previous.map((job) =>
          doomed.has(job.promptId) && isActive(job)
            ? {
                ...job,
                phase: "error" as const,
                queuePosition: null,
                completedAt: Date.now(),
                error:
                  `${detail} Gave up after ${MAX_POLL_FAILURES} failed status checks ` +
                  "and sent a cancel — if the machine is unreachable the cancel will " +
                  "not have arrived either, so the run may still finish on its own.",
              }
            : job,
        ),
      );

      await Promise.all(
        promptIds.map((promptId) =>
          api("/api/cancel", {
            method: "POST",
            body: JSON.stringify({ promptId }),
          }).catch(() => {
            // Expected when the box is the thing that is gone.
          }),
        ),
      );
    },
    [],
  );

  // One batched request per tick regardless of how many jobs are in flight,
  // so a deep queue does not multiply load on the ComfyUI box.
  useEffect(() => {
    if (!activeIds) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;

    // The current run of consecutive failures. A closure variable rather than a
    // ref, so it resets whenever the set of active jobs changes: a successful
    // poll is what normally changes that set, and it would have reset anyway.
    let failures = 0;
    let firstFailureAt = 0;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { statuses } = await api<{
          statuses: Record<string, StatusPayload>;
        }>(`/api/status?promptIds=${encodeURIComponent(activeIds)}`);
        if (cancelled) return;
        failures = 0;
        // The same array back when nothing moved, not a fresh one holding the
        // same objects. `applyStatus` already returns the identical job when a
        // poll says nothing new, so this is a cheap identity check — and it is
        // what stops a tick that changed nothing from re-rendering the history
        // and rewriting the whole of localStorage. Most ticks change nothing:
        // a render sits in `running` for minutes. Without this the cost of
        // keeping history is paid every 1.5 seconds rather than when something
        // actually happens, which is what made its size worth rationing.
        setJobs((previous) => {
          const next = previous.map((job) =>
            applyStatus(job, statuses[job.promptId]),
          );
          return next.some((job, index) => job !== previous[index])
            ? next
            : previous;
        });
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled) return;
        // An auth failure will not fix itself.
        if (cause instanceof ApiError && cause.status === 401) return;

        failures += 1;
        if (failures === 1) firstFailureAt = Date.now();

        if (
          failures >= MAX_POLL_FAILURES &&
          Date.now() - firstFailureAt >= GIVE_UP_AFTER_MS
        ) {
          // Nothing reschedules from here: giving up settles every job in
          // flight, which empties activeIds and tears this loop down.
          void abandonActive(activeIds.split(","), cause);
          return;
        }

        timer = setTimeout(poll, retryDelayMs(failures));
      } finally {
        inFlight = false;
      }
    };

    timer = setTimeout(poll, 300);

    // Hidden tabs get their timers throttled to about once a minute, so catch
    // up the moment the tab is looked at again.
    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeIds, abandonActive]);

  const submit = useCallback(
    async (
      workflow: WorkflowSummary,
      values: Record<string, ParamValue>,
      options?: RunModes & { lowVram?: boolean; derivedFrom?: string },
    ) => {
      const turbo = Boolean(options?.turbo);
      const asked = options?.patches ?? [];
      setSubmitting(true);
      setSubmitError(null);
      setSubmitErrorField(null);

      try {
        const response = await api<GenerateResponse>("/api/generate", {
          method: "POST",
          body: JSON.stringify({
            workflowId: workflow.id,
            params: values,
            turbo,
            patches: asked,
            lowVram: Boolean(options?.lowVram),
          }),
        });

        // What the run got rather than what was asked for: a step count can
        // refuse a switch, and recording the request would put this generation
        // in the wrong bucket for the estimate and name a mode it did not use.
        const patches = response.patches ?? asked;

        const job: Job = {
          promptId: response.promptId,
          workflowId: workflow.id,
          // The modes are part of what the run was, so they belong in the name
          // that shows in the history and in the notification.
          workflowName: workflowLabel(
            workflow.name,
            { turbo, patches },
            workflow.patches,
          ),
          prompt: String(values.prompt ?? ""),
          turbo,
          patches,
          derivedFrom: options?.derivedFrom,
          hasAudio: Boolean(workflow.hasAudio),
          submittedAt: Date.now(),
          phase: "queued",
          queuePosition: null,
          outputs: [],
          resolved: response.resolved,
          estimatedSeconds: response.estimatedSeconds,
        };

        setJobs((previous) => [job, ...previous]);
      } catch (cause) {
        setSubmitError(
          cause instanceof ApiError ? cause.message : "Could not submit the job.",
        );
        setSubmitErrorField(
          cause instanceof ApiError ? (cause.field ?? null) : null,
        );
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const cancel = useCallback(async (promptId: string) => {
    // Optimistic: the poll loop settles the real state either way, and the
    // button should not sit there looking unresponsive.
    setJobs((previous) =>
      previous.map((job) =>
        job.promptId === promptId
          ? { ...job, phase: "cancelled", queuePosition: null, completedAt: Date.now() }
          : job,
      ),
    );
    try {
      await api("/api/cancel", {
        method: "POST",
        body: JSON.stringify({ promptId }),
      });
    } catch {
      // Best effort — ComfyUI may have finished it in the meantime.
    }
  }, []);

  const remove = useCallback((promptId: string) => {
    setJobs((previous) => previous.filter((job) => job.promptId !== promptId));
  }, []);

  const removeMany = useCallback((promptIds: string[]) => {
    const doomed = new Set(promptIds);
    setJobs((previous) => previous.filter((job) => !doomed.has(job.promptId)));
  }, []);

  const toggleFavorite = useCallback((promptId: string) => {
    setJobs((previous) =>
      previous.map((job) =>
        job.promptId === promptId ? { ...job, favorite: !job.favorite } : job,
      ),
    );
  }, []);

  // Favourites survive, which is most of what marking one is for: the whole
  // reason to keep a generation is so the tidy-up does not take it.
  const clearFinished = useCallback(() => {
    setJobs((previous) =>
      previous.filter((job) => isActive(job) || isFavorite(job)),
    );
  }, []);

  const dismissSubmitError = useCallback(() => setSubmitError(null), []);

  const estimateFor = useCallback(
    (job: Job) => learnedEstimateSeconds(jobs, job),
    [jobs],
  );

  return {
    jobs,
    activeCount: jobs.filter(isActive).length,
    estimateFor,
    submitting,
    submitError,
    submitErrorField,
    submit,
    cancel,
    remove,
    removeMany,
    toggleFavorite,
    clearFinished,
    dismissSubmitError,
  };
}
