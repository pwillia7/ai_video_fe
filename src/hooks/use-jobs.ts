"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusPayload } from "@/app/api/status/route";
import { api, ApiError } from "@/lib/client";
import {
  expireStale,
  learnedEstimateSeconds,
  isActive,
  readJobs,
  sortJobs,
  writeJobs,
  type Job,
} from "@/lib/jobs";
import { notify } from "@/lib/notifications";
import { workflowLabel } from "@/lib/workflows/turbo";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

const POLL_INTERVAL_MS = 1500;
/**
 * ComfyUI reports nothing for a moment between accepting a prompt and queueing
 * it. Only treat "unknown" as lost once a job has had well past that to appear.
 */
const SETTLE_GRACE_MS = 60_000;

interface GenerateResponse {
  promptId: string;
  queueNumber: number;
  resolved: Record<string, ParamValue>;
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
    options?: {
      /** Run with the distilled LoRA. Only offered where the workflow declares it. */
      turbo?: boolean;
      /** The generation whose clip this one was made from, if any. */
      derivedFrom?: string;
    },
  ) => Promise<void>;
  cancel: (promptId: string) => Promise<void>;
  remove: (promptId: string) => void;
  /** Drop several at once, so a day's worth is one state write. */
  removeMany: (promptIds: string[]) => void;
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
        notify("Video ready", job.workflowName, job.promptId);
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

  // One batched request per tick regardless of how many jobs are in flight,
  // so a deep queue does not multiply load on the ComfyUI box.
  useEffect(() => {
    if (!activeIds) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { statuses } = await api<{
          statuses: Record<string, StatusPayload>;
        }>(`/api/status?promptIds=${encodeURIComponent(activeIds)}`);
        if (cancelled) return;
        setJobs((previous) =>
          previous.map((job) => applyStatus(job, statuses[job.promptId])),
        );
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled) return;
        // An auth failure will not fix itself; anything else is usually a blip.
        if (cause instanceof ApiError && cause.status === 401) return;
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
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
  }, [activeIds]);

  const submit = useCallback(
    async (
      workflow: WorkflowSummary,
      values: Record<string, ParamValue>,
      options?: { turbo?: boolean; derivedFrom?: string },
    ) => {
      const turbo = Boolean(options?.turbo);
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
          }),
        });

        const job: Job = {
          promptId: response.promptId,
          workflowId: workflow.id,
          // The mode is part of what the run was, so it belongs in the name
          // that shows in the history and in the notification.
          workflowName: workflowLabel(workflow.name, turbo),
          prompt: String(values.prompt ?? ""),
          turbo,
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

  const clearFinished = useCallback(() => {
    setJobs((previous) => previous.filter(isActive));
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
    clearFinished,
    dismissSubmitError,
  };
}
