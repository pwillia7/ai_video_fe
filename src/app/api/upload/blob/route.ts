import { del, get, list } from "@vercel/blob";
import { unauthorized } from "@/lib/auth";
import { inputFileRef, uploadInputFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";
import {
  BLOB_UPLOAD_PREFIX,
  LARGE_UPLOAD_MAX_BYTES,
} from "@/lib/upload-limits";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACCEPTED = /^(image|video|audio)\//;

/**
 * An upload left in the store longer than this was never claimed — the tab
 * closed mid-way, say — and is removed by the next claim. Long past any token's
 * lifetime, so nothing still uploading is touched.
 */
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Claims a file the browser has just uploaded to the Blob store: copies it into
 * ComfyUI's input directory, returns the reference a loader node needs — the
 * same answer /api/upload gives for a small file — and deletes it from the
 * store whether or not the copy succeeded. Blob is only ever the way past
 * Vercel's request-size cap, never where a file is kept.
 *
 * The copy runs function to ComfyUI, so the bytes never go back through the
 * browser. See /api/upload/token for how they got here.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let pathname: string | undefined;
  try {
    const body = (await request.json()) as { pathname?: string; name?: string };
    pathname = body.pathname?.trim();

    if (
      !pathname ||
      !pathname.startsWith(BLOB_UPLOAD_PREFIX) ||
      pathname.includes("..")
    ) {
      pathname = undefined;
      throw new ParamError("That is not an upload this app made.", "file");
    }

    const blob = await get(pathname, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200) {
      throw new ParamError(
        "The upload was not found — it may have expired. Try again.",
        "file",
      );
    }

    const contentType = blob.blob.contentType ?? "";
    if (!ACCEPTED.test(contentType)) {
      throw new ParamError(
        `${contentType || "That file"} is not an image, a video or a track.`,
        "file",
      );
    }
    if (blob.blob.size > LARGE_UPLOAD_MAX_BYTES) {
      throw new ParamError(
        `That file is ${(blob.blob.size / 1024 / 1024).toFixed(0)} MB; the limit is ${LARGE_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`,
        "file",
      );
    }

    const file = await new Response(blob.stream).blob();
    const safeName =
      (body.name || pathname.slice(BLOB_UPLOAD_PREFIX.length))
        .split(/[\\/]/)
        .pop() || "upload";
    const uploaded = await uploadInputFile(
      new Blob([file], { type: contentType }),
      safeName,
    );

    return Response.json({
      ref: inputFileRef(uploaded),
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    // Best effort, and never the reason a claim fails: the copy is what
    // mattered. Anything this misses is swept by a later claim.
    if (pathname) await del(pathname).catch(() => undefined);
    await sweepAbandoned().catch(() => undefined);
  }
}

/** Deletes uploads nobody claimed. See ABANDONED_AFTER_MS. */
async function sweepAbandoned(): Promise<void> {
  const { blobs } = await list({ prefix: BLOB_UPLOAD_PREFIX, limit: 100 });
  const cutoff = Date.now() - ABANDONED_AFTER_MS;
  const stale = blobs
    .filter((blob) => new Date(blob.uploadedAt).getTime() < cutoff)
    .map((blob) => blob.pathname);
  if (stale.length > 0) await del(stale);
}
