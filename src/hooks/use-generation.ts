"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";
import type { StatusPayload } from "@/app/api/status/route";
import type { ParamValue } from "@/lib/workflows/types";

export type Phase =
  | "idle"
  | "submitting"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface GeneratedFile {
  url: string;
  filename: string;
  subfolder: string;
  type: string;
}

interface GenerateResponse {
  promptId: string;
  queueNumber: number;
  resolved: Record<string, ParamValue>;
  estimatedSeconds: number | null;
}

const POLL_INTERVAL_MS = 1500;
/** ComfyUI briefly reports nothing between accepting a job and queueing it. */
const MAX_UNKNOWN_POLLS = 20;

const STORAGE_KEY = "sorant-active-job";
/** Older than this and the job is almost certainly gone from ComfyUI. */
const MAX_RESTORE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Enough to re-attach to a job after a reload. The outputs are deliberately not
 * stored — they are re-derived from /api/status, so there is one source of
 * truth and no stale local copy to reconcile.
 */
interface StoredJob {
  promptId: string;
  workflowId: string;
  startedAt: number;
  resolved: Record<string, ParamValue>;
  estimatedSeconds: number | null;
}

function readStoredJob(): StoredJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredJob;
    return parsed?.promptId ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredJob(job: StoredJob): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch {
    // Storage disabled — recovery just will not be available.
  }
}

function clearStoredJob(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

export interface GenerationController {
  phase: Phase;
  promptId: string | null;
  queuePosition: number | null;
  elapsedMs: number;
  estimatedSeconds: number | null;
  outputs: GeneratedFile[];
  resolved: Record<string, ParamValue> | null;
  error: string | null;
  /** Param id the error belongs to, when the server blamed a specific field. */
  errorField: string | null;
  isBusy: boolean;
  /**
   * Set when a job was re-attached from a previous session, so the UI can
   * select the workflow it belonged to.
   */
  restoredWorkflowId: string | null;
  start: (
    workflowId: string,
    values: Record<string, ParamValue>,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function useGeneration(timeoutSeconds: number): GenerationController {
  const [phase, setPhase] = useState<Phase>("idle");
  const [promptId, setPromptId] = useState<string | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<GeneratedFile[]>([]);
  const [resolved, setResolved] = useState<Record<string, ParamValue> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

  const [restoredWorkflowId, setRestoredWorkflowId] = useState<string | null>(
    null,
  );

  const startedAtRef = useRef<number | null>(null);
  const unknownPollsRef = useRef(0);
  /**
   * True between re-attaching to a stored job and its first meaningful poll.
   * A restored job that ComfyUI no longer knows about is almost always just
   * stale — the server restarted and dropped its history — so it is discarded
   * quietly rather than reported as a failure the user never caused.
   */
  const recoveringRef = useRef(false);

  const isBusy =
    phase === "submitting" || phase === "queued" || phase === "running";

  const start = useCallback(
    async (workflowId: string, values: Record<string, ParamValue>) => {
      setPhase("submitting");
      setError(null);
      setErrorField(null);
      setOutputs([]);
      setRestoredWorkflowId(null);
      recoveringRef.current = false;
      clearStoredJob();
      setQueuePosition(null);
      setElapsedMs(0);
      setPromptId(null);
      unknownPollsRef.current = 0;
      startedAtRef.current = Date.now();

      try {
        const response = await api<GenerateResponse>("/api/generate", {
          method: "POST",
          body: JSON.stringify({ workflowId, params: values }),
        });

        setPromptId(response.promptId);
        setResolved(response.resolved);
        setEstimatedSeconds(response.estimatedSeconds);
        setPhase("queued");

        writeStoredJob({
          promptId: response.promptId,
          workflowId,
          startedAt: startedAtRef.current ?? Date.now(),
          resolved: response.resolved,
          estimatedSeconds: response.estimatedSeconds,
        });
      } catch (cause) {
        startedAtRef.current = null;
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not submit the job.",
        );
        // A ParamError names the offending field so the form can flag it inline.
        setErrorField(cause instanceof ApiError ? (cause.field ?? null) : null);
        setPhase("error");
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!promptId) {
      startedAtRef.current = null;
      setPhase("idle");
      return;
    }
    try {
      await api("/api/cancel", {
        method: "POST",
        body: JSON.stringify({ promptId }),
      });
    } catch {
      // Cancelling is best effort; the poll loop will settle the real state.
    }
    startedAtRef.current = null;
    recoveringRef.current = false;
    clearStoredJob();
    setPhase("cancelled");
  }, [promptId]);

  const reset = useCallback(() => {
    startedAtRef.current = null;
    unknownPollsRef.current = 0;
    recoveringRef.current = false;
    clearStoredJob();
    setRestoredWorkflowId(null);
    setPhase("idle");
    setPromptId(null);
    setOutputs([]);
    setError(null);
    setErrorField(null);
    setQueuePosition(null);
    setElapsedMs(0);
  }, []);

  // Re-attach to a job from a previous session. ComfyUI keeps rendering with
  // the tab closed, so without this the video is produced and then orphaned:
  // no progress, no result, no download.
  useEffect(() => {
    const stored = readStoredJob();
    if (!stored) return;

    if (Date.now() - stored.startedAt > MAX_RESTORE_AGE_MS) {
      clearStoredJob();
      return;
    }

    recoveringRef.current = true;
    startedAtRef.current = stored.startedAt;
    setPromptId(stored.promptId);
    setResolved(stored.resolved);
    setEstimatedSeconds(stored.estimatedSeconds);
    setRestoredWorkflowId(stored.workflowId);
    // The poll loop corrects this immediately to running/done/error.
    setPhase("queued");
  }, []);

  // Elapsed clock. Separate from polling so the timer stays smooth even when a
  // status request is slow.
  useEffect(() => {
    if (!isBusy || startedAtRef.current === null) return;

    const tick = () => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isBusy]);

  // Poll loop. Runs only while there is a live prompt to ask about.
  useEffect(() => {
    if (!promptId) return;
    if (phase !== "queued" && phase !== "running") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await api<StatusPayload>(
          `/api/status?promptId=${encodeURIComponent(promptId)}`,
        );
        if (cancelled) return;

        if (status.state === "done") {
          recoveringRef.current = false;
          setOutputs(status.outputs);
          setQueuePosition(null);
          startedAtRef.current = null;
          setPhase("done");
          // Deliberately kept in storage: reopening the tab should still show
          // the finished video rather than an empty stage.
          return;
        }

        if (status.state === "error") {
          recoveringRef.current = false;
          clearStoredJob();
          setError(status.error ?? "The workflow failed while executing.");
          startedAtRef.current = null;
          setPhase("error");
          return;
        }

        if (status.state === "unknown") {
          // A restored job ComfyUI has never heard of is stale, not broken —
          // usually the server restarted and dropped its history. Drop it
          // silently instead of opening with an error nobody caused.
          if (recoveringRef.current) {
            recoveringRef.current = false;
            clearStoredJob();
            startedAtRef.current = null;
            setPromptId(null);
            setRestoredWorkflowId(null);
            setPhase("idle");
            return;
          }
          unknownPollsRef.current += 1;
          if (unknownPollsRef.current > MAX_UNKNOWN_POLLS) {
            setError(
              "The job disappeared from ComfyUI's queue and history. It may have been cancelled or the server restarted.",
            );
            startedAtRef.current = null;
            setPhase("error");
            return;
          }
        } else {
          // ComfyUI knows the job, so a restore has succeeded.
          recoveringRef.current = false;
          unknownPollsRef.current = 0;
          setQueuePosition(status.queuePosition);
          setPhase(status.state === "running" ? "running" : "queued");
        }

        const elapsed = startedAtRef.current
          ? Date.now() - startedAtRef.current
          : 0;
        if (elapsed > timeoutSeconds * 1000) {
          setError(
            `Gave up waiting after ${Math.round(timeoutSeconds / 60)} minutes. The job may still be running on the GPU.`,
          );
          startedAtRef.current = null;
          setPhase("error");
          return;
        }

        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled) return;
        // A single failed poll is usually a blip; keep trying, and only give
        // up on an auth failure, which will not fix itself.
        if (cause instanceof ApiError && cause.status === 401) {
          setError(cause.message);
          setPhase("error");
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      } finally {
        inFlight = false;
      }
    };

    timer = setTimeout(poll, 400);

    // Browsers throttle timers in a hidden tab — down to about once a minute
    // after a few minutes — so a backgrounded job can sit on stale state.
    // Polling the moment the tab is looked at again makes that invisible.
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
  }, [promptId, phase, timeoutSeconds]);

  return {
    phase,
    promptId,
    queuePosition,
    elapsedMs,
    estimatedSeconds,
    outputs,
    resolved,
    error,
    errorField,
    isBusy,
    restoredWorkflowId,
    start,
    cancel,
    reset,
  };
}
