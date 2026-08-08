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

  const startedAtRef = useRef<number | null>(null);
  const unknownPollsRef = useRef(0);

  const isBusy =
    phase === "submitting" || phase === "queued" || phase === "running";

  const start = useCallback(
    async (workflowId: string, values: Record<string, ParamValue>) => {
      setPhase("submitting");
      setError(null);
      setErrorField(null);
      setOutputs([]);
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
    setPhase("cancelled");
  }, [promptId]);

  const reset = useCallback(() => {
    startedAtRef.current = null;
    unknownPollsRef.current = 0;
    setPhase("idle");
    setPromptId(null);
    setOutputs([]);
    setError(null);
    setErrorField(null);
    setQueuePosition(null);
    setElapsedMs(0);
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

    const poll = async () => {
      try {
        const status = await api<StatusPayload>(
          `/api/status?promptId=${encodeURIComponent(promptId)}`,
        );
        if (cancelled) return;

        if (status.state === "done") {
          setOutputs(status.outputs);
          setQueuePosition(null);
          startedAtRef.current = null;
          setPhase("done");
          return;
        }

        if (status.state === "error") {
          setError(status.error ?? "The workflow failed while executing.");
          startedAtRef.current = null;
          setPhase("error");
          return;
        }

        if (status.state === "unknown") {
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
      }
    };

    timer = setTimeout(poll, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
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
    start,
    cancel,
    reset,
  };
}
