"use client";

import { upload as uploadToBlob } from "@vercel/blob/client";
import { api, getToken } from "./client";
import {
  BLOB_UPLOAD_PREFIX,
  DIRECT_UPLOAD_MAX_BYTES,
} from "./upload-limits";

/** What every upload route answers with: the reference a loader node takes. */
export interface UploadResponse {
  ref: string;
  name: string;
  subfolder: string;
  type: string;
}

/**
 * Past this a Blob upload is sent in parts, in parallel, so a large clip on a
 * slow connection is not one long request that a blip throws away.
 */
const MULTIPART_FROM_BYTES = 32 * 1024 * 1024;

/**
 * Puts a file the user chose into ComfyUI's input directory, by whichever route
 * fits its size.
 *
 * Small files are posted to /api/upload, as they always were. Anything over
 * the 4.5 MB Vercel caps a function's request body at goes straight from the
 * browser to the private Blob store, and /api/upload/blob then copies it to
 * ComfyUI and deletes it there. Callers get the same answer either way.
 */
export async function uploadToComfy(
  file: Blob,
  name: string,
): Promise<UploadResponse> {
  if (file.size <= DIRECT_UPLOAD_MAX_BYTES) {
    const form = new FormData();
    form.append("file", file, name);
    // api() deliberately leaves the Content-Type off FormData so the browser
    // can set the multipart boundary itself.
    return api<UploadResponse>("/api/upload", { method: "POST", body: form });
  }

  const token = getToken();
  const safeName = name.split(/[\\/]/).pop() || "upload";
  const blob = await uploadToBlob(`${BLOB_UPLOAD_PREFIX}${safeName}`, file, {
    access: "private",
    handleUploadUrl: "/api/upload/token",
    // The same header api() sends; auth.ts names it server-side, and is not
    // importable here because it reads the server's environment.
    headers: token ? { "x-app-token": token } : undefined,
    contentType: file.type || undefined,
    multipart: file.size >= MULTIPART_FROM_BYTES,
  });

  return api<UploadResponse>("/api/upload/blob", {
    method: "POST",
    body: JSON.stringify({ pathname: blob.pathname, name: safeName }),
  });
}
