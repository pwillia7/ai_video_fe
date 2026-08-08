/**
 * Thin client for the ComfyUI HTTP API.
 *
 * Every call runs server-side. The browser never talks to ComfyUI directly:
 * the instance is plain HTTP, and an HTTPS page is not allowed to call an
 * http:// origin, so all traffic is proxied through our route handlers.
 */

import { comfyApiToken, comfyAuthHeaders, comfyUrl } from "./env";

/** A node in ComfyUI's "API format" graph, as exported by Save (API Format). */
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** API-format graph: node id -> node. */
export type ComfyGraph = Record<string, ComfyNode>;

/** A single produced file as ComfyUI reports it in history outputs. */
export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
}

export interface QueuePromptResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface ComfyHistoryEntry {
  prompt: unknown;
  outputs: Record<string, Record<string, ComfyFileRef[] | undefined>>;
  status?: {
    completed: boolean;
    status_str: string;
    messages?: unknown[];
  };
}

export interface ComfyQueue {
  queue_running: unknown[][];
  queue_pending: unknown[][];
}

export class ComfyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ComfyError";
  }
}

/** Raised when ComfyUI-Login rejects our token. A server misconfiguration. */
export class ComfyAuthError extends ComfyError {
  constructor(message: string) {
    // Deliberately surfaced as 502, not 401. A 401 from our own API means the
    // caller's APP_ACCESS_TOKEN is wrong, and the UI reacts by clearing it and
    // showing the token gate. This failure is ours to fix, not the user's.
    super(message, 502);
    this.name = "ComfyAuthError";
  }
}

async function comfyFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  const url = `${comfyUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: { ...comfyAuthHeaders(), ...(rest.headers ?? {}) },
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      // Do not chase a redirect to a login page — following it would return
      // 200 with HTML and surface as an unintelligible JSON parse error.
      redirect: "manual",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ComfyError(
      `Could not reach ComfyUI at ${comfyUrl()} (${reason}). Check the machine is on and the port is reachable from the internet.`,
      502,
      cause,
    );
  }

  // A redirect on an API call means a login wall stood in front of it.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    await response.body?.cancel();
    throw new ComfyAuthError(
      `ComfyUI redirected ${path} to ${location || "a login page"} instead of answering. ` +
        "That means the request was not authenticated — check COMFY_API_TOKEN.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ComfyAuthError(
      comfyApiToken()
        ? "ComfyUI rejected the API token. Check COMFY_API_TOKEN matches the token printed in the ComfyUI console — and that every $ is escaped as \\$ in .env.local."
        : "ComfyUI requires authentication but COMFY_API_TOKEN is not set. Add the token that the ComfyUI-Login node printed to its console.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ComfyError(
      `ComfyUI returned ${response.status} for ${path}${body ? `: ${body.slice(0, 500)}` : ""}`,
      response.status === 404 ? 404 : 502,
      body,
    );
  }

  return response;
}

async function comfyJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const response = await comfyFetch(path, init);

  // A 200 carrying HTML is the other shape a login wall takes. Catch it here
  // rather than letting JSON.parse produce "Unexpected token <".
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const preview = (await response.text().catch(() => "")).slice(0, 200);
    if (preview.trimStart().startsWith("<")) {
      throw new ComfyAuthError(
        `ComfyUI returned an HTML page for ${path} instead of JSON, which usually means a login page. Check COMFY_API_TOKEN.`,
      );
    }
    throw new ComfyError(
      `ComfyUI returned ${contentType || "an unknown content type"} for ${path} instead of JSON.`,
      502,
      preview,
    );
  }

  return (await response.json()) as T;
}

/** Submit a graph for execution. Returns the prompt id used to track it. */
export async function queuePrompt(
  graph: ComfyGraph,
  clientId: string,
): Promise<QueuePromptResult> {
  const result = await comfyJson<QueuePromptResult>("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    timeoutMs: 30_000,
  });

  if (result.node_errors && Object.keys(result.node_errors).length > 0) {
    throw new ComfyError(
      "ComfyUI rejected the workflow. This usually means a model file named in the workflow is missing, or an input is out of range.",
      400,
      result.node_errors,
    );
  }

  return result;
}

export async function getHistoryEntry(
  promptId: string,
): Promise<ComfyHistoryEntry | undefined> {
  const history = await comfyJson<Record<string, ComfyHistoryEntry>>(
    `/history/${encodeURIComponent(promptId)}`,
  );
  return history[promptId];
}

export async function getQueue(): Promise<ComfyQueue> {
  return comfyJson<ComfyQueue>("/queue");
}

/** Remove a not-yet-started prompt from the pending queue. No-op if running. */
export async function deleteFromQueue(promptId: string): Promise<void> {
  await comfyFetch("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
}

/**
 * Interrupt a specific prompt.
 *
 * The prompt_id matters. Without it ComfyUI does a *global* interrupt — it
 * kills whatever happens to be executing, which with a queue is quite possibly
 * not the job the user asked to cancel. Given an id, ComfyUI checks it against
 * the running list first and does nothing if it does not match.
 */
export async function interruptPrompt(promptId: string): Promise<void> {
  await comfyFetch("/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId }),
  });
}

/**
 * Cancel a prompt whatever state it is in.
 *
 * Newer ComfyUI has a jobs API that handles both states in one idempotent
 * call. Older builds do not, so fall back to doing both halves unconditionally:
 * de-queueing is a no-op for a running prompt and the targeted interrupt is a
 * no-op for a pending one, so there is no state to check and no window in
 * which the job can move between the check and the action.
 */
export async function cancelPrompt(promptId: string): Promise<boolean> {
  try {
    const result = await comfyJson<{ cancelled?: boolean }>(
      `/api/jobs/${encodeURIComponent(promptId)}/cancel`,
      { method: "POST", timeoutMs: 20_000 },
    );
    return result?.cancelled ?? true;
  } catch (error) {
    // Anything other than "this build has no jobs API" is a real failure.
    if (!(error instanceof ComfyError) || error.status !== 404) throw error;
  }

  await Promise.all([
    deleteFromQueue(promptId).catch(() => undefined),
    interruptPrompt(promptId).catch(() => undefined),
  ]);
  return true;
}

export async function systemStats(): Promise<unknown> {
  return comfyJson<unknown>("/system_stats", { timeoutMs: 8_000 });
}

export interface UploadedImage {
  name: string;
  subfolder: string;
  type: string;
}

/**
 * Push an image into ComfyUI's input directory so a LoadImage node can find it.
 *
 * LoadImage takes a filename, not image data, so an image-to-video workflow
 * needs the file to exist server-side before the prompt is queued.
 */
export async function uploadImage(
  file: Blob,
  filename: string,
): Promise<UploadedImage> {
  const form = new FormData();
  form.append("image", file, filename);
  // Let ComfyUI de-duplicate by suffixing rather than clobbering an existing
  // file that another workflow may still reference.
  form.append("overwrite", "false");
  form.append("type", "input");

  // Content-Type is deliberately unset: fetch must generate the multipart
  // boundary itself, and supplying the header would break the body framing.
  return comfyJson<UploadedImage>("/upload/image", {
    method: "POST",
    body: form,
    timeoutMs: 120_000,
  });
}

/**
 * How LoadImage refers to an uploaded file: bare name at the input root, or
 * "subfolder/name" when ComfyUI filed it under one.
 */
export function loadImageRef(uploaded: UploadedImage): string {
  return uploaded.subfolder
    ? `${uploaded.subfolder}/${uploaded.name}`
    : uploaded.name;
}

/** One node class as ComfyUI describes it in /object_info. */
export interface NodeSchema {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
}

// /object_info for the whole install is multiple megabytes, so fetch per class
// and hold it briefly. Node schemas only change when ComfyUI restarts.
const SCHEMA_TTL_MS = 60_000;
const schemaCache = new Map<string, { at: number; schema: NodeSchema | null }>();

export async function getNodeSchema(
  className: string,
): Promise<NodeSchema | null> {
  const cached = schemaCache.get(className);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;

  let schema: NodeSchema | null = null;
  try {
    const response = await comfyJson<Record<string, NodeSchema>>(
      `/object_info/${encodeURIComponent(className)}`,
      { timeoutMs: 15_000 },
    );
    schema = response?.[className] ?? null;
  } catch {
    // Leave schema null; callers fall back to their static options.
    schema = null;
  }

  schemaCache.set(className, { at: Date.now(), schema });
  return schema;
}

/**
 * Pull the allowed values for one input. ComfyUI describes an enum as a spec
 * whose first element is the array of choices: ["euler", "heun", ...].
 */
export function enumValuesFor(
  schema: NodeSchema | null,
  input: string,
): string[] | null {
  if (!schema) return null;

  const spec =
    schema.input?.required?.[input] ?? schema.input?.optional?.[input];
  if (!Array.isArray(spec) || spec.length === 0) return null;

  const choices = spec[0];
  if (Array.isArray(choices)) {
    return choices.filter((c): c is string => typeof c === "string");
  }

  // Newer COMBO form: { options: [...] } in the second slot.
  const meta = spec[1];
  if (meta && typeof meta === "object" && "options" in meta) {
    const options = (meta as { options?: unknown }).options;
    if (Array.isArray(options)) {
      return options.filter((c): c is string => typeof c === "string");
    }
  }

  return null;
}

/**
 * Stream a produced file back to the caller without buffering it in memory.
 * `headers` exists so a Range request can be forwarded, which is what lets the
 * browser scrub through the video instead of only playing it start to finish.
 */
export async function viewFile(
  ref: ComfyFileRef,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const query = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type || "output",
  });
  return comfyFetch(`/view?${query}`, {
    timeoutMs: 120_000,
    headers: options.headers,
    signal: options.signal,
  });
}

/**
 * ComfyUI groups outputs by an arbitrary key that depends on the save node:
 * `gifs` for VHS_VideoCombine, `videos` for SaveVideo/SaveWEBM, `images` for
 * still savers. Collect everything, then rank so real video lands first.
 */
const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|mov|m4v|gif|webp)$/i;
const KEY_PRIORITY = ["videos", "gifs", "animated", "images", "audio"];

export function collectOutputs(entry: ComfyHistoryEntry): ComfyFileRef[] {
  const files: Array<{ ref: ComfyFileRef; rank: number }> = [];

  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const [key, refs] of Object.entries(nodeOutput ?? {})) {
      if (!Array.isArray(refs)) continue;

      const keyRank = KEY_PRIORITY.indexOf(key);
      for (const ref of refs) {
        if (!ref?.filename) continue;
        const looksLikeVideo = VIDEO_EXTENSIONS.test(ref.filename);
        files.push({
          ref,
          rank: (looksLikeVideo ? 0 : 100) + (keyRank === -1 ? 50 : keyRank),
        });
      }
    }
  }

  return files.sort((a, b) => a.rank - b.rank).map((f) => f.ref);
}

export function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mov":
      return "video/quicktime";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
