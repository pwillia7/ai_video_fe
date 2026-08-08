import { unauthorized } from "@/lib/auth";
import {
  collectOutputs,
  getHistoryEntry,
  getQueue,
  type ComfyFileRef,
  type ComfyHistoryEntry,
} from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type GenerationState =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "unknown";

export interface StatusPayload {
  state: GenerationState;
  /** 0-based position in the pending queue; null when running or finished. */
  queuePosition: number | null;
  outputs: Array<ComfyFileRef & { url: string }>;
  error?: string;
}

/** Build the proxied URL the <video> element will actually load. */
function mediaUrl(ref: ComfyFileRef): string {
  const query = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type || "output",
  });
  return `/api/media?${query}`;
}

/**
 * ComfyUI reports failures as ["execution_error", { exception_message, ... }]
 * tuples in the history status. Pull out the first useful message.
 */
function extractError(entry: ComfyHistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;

  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const detail = message[1] as
      | { exception_message?: string; node_type?: string; node_id?: string }
      | undefined;
    if (!detail) continue;

    const where = detail.node_type
      ? ` in ${detail.node_type}${detail.node_id ? ` (node ${detail.node_id})` : ""}`
      : "";
    return `${detail.exception_message ?? "Execution failed"}${where}`;
  }

  return undefined;
}

/** Queue entries are positional arrays; the prompt id sits at index 1. */
function promptIdOf(entry: unknown): string | undefined {
  return Array.isArray(entry) ? (entry[1] as string | undefined) : undefined;
}

export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const promptId = new URL(request.url).searchParams.get("promptId");
    if (!promptId) throw new ParamError("promptId is required.");

    // History is authoritative: a finished prompt lands here whether it
    // succeeded or failed, so check it before the queue.
    const entry = await getHistoryEntry(promptId);
    if (entry) {
      const failure = extractError(entry);
      const outputs = collectOutputs(entry);

      if (failure) {
        return Response.json({
          state: "error",
          queuePosition: null,
          outputs: [],
          error: failure,
        } satisfies StatusPayload);
      }

      // A completed prompt with nothing to show means the graph has no save
      // node wired to an output, which is a workflow bug worth naming.
      if (entry.status?.completed && outputs.length === 0) {
        return Response.json({
          state: "error",
          queuePosition: null,
          outputs: [],
          error:
            "The workflow finished but produced no file. Check that a save node (SaveWEBM, SaveVideo or VHS_VideoCombine) is connected in the graph.",
        } satisfies StatusPayload);
      }

      if (outputs.length > 0) {
        return Response.json({
          state: "done",
          queuePosition: null,
          outputs: outputs.map((ref) => ({ ...ref, url: mediaUrl(ref) })),
        } satisfies StatusPayload);
      }
    }

    const queue = await getQueue();

    if (queue.queue_running?.some((item) => promptIdOf(item) === promptId)) {
      return Response.json({
        state: "running",
        queuePosition: null,
        outputs: [],
      } satisfies StatusPayload);
    }

    const pendingIndex =
      queue.queue_pending?.findIndex(
        (item) => promptIdOf(item) === promptId,
      ) ?? -1;

    if (pendingIndex >= 0) {
      return Response.json({
        state: "queued",
        queuePosition: pendingIndex,
        outputs: [],
      } satisfies StatusPayload);
    }

    // Not in history and not in the queue. Usually a race right after
    // submitting; the client keeps polling for a short grace period.
    return Response.json({
      state: "unknown",
      queuePosition: null,
      outputs: [],
    } satisfies StatusPayload);
  } catch (error) {
    return errorResponse(error);
  }
}
