import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { unauthorized } from "@/lib/auth";
import {
  BLOB_UPLOAD_PREFIX,
  LARGE_UPLOAD_MAX_BYTES,
} from "@/lib/upload-limits";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Long enough for a large file on a slow connection, short enough to be no use later. */
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Issues the short-lived token a browser needs to upload one file straight to
 * the private Blob store — the way past the 4.5 MB Vercel caps a function's
 * request body at. The file itself never comes through here.
 *
 * Checked against the app's access token before anything is issued: without
 * that, anyone who found this route could fill the store. Nothing is listening
 * for Vercel's upload-completed callback, which would arrive without the
 * token; the browser claims the file itself, through /api/upload/blob, as soon
 * as its upload resolves.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (
          !pathname.startsWith(BLOB_UPLOAD_PREFIX) ||
          pathname.includes("..")
        ) {
          throw new Error("Uploads go under uploads/.");
        }
        return {
          allowedContentTypes: ["image/*", "video/*", "audio/*"],
          maximumSizeInBytes: LARGE_UPLOAD_MAX_BYTES,
          // Two files of the same name uploaded together must not land on
          // one path, and one claim must not delete the other's file.
          addRandomSuffix: true,
          validUntil: Date.now() + TOKEN_LIFETIME_MS,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload refused." },
      { status: 400 },
    );
  }
}
