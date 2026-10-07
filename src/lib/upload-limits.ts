/**
 * How big a file the browser can hand over, by the two routes it can take.
 *
 * Shared by the upload controls and the routes behind them, so the number a
 * control refuses at and the number a route enforces cannot drift apart. No
 * secrets here — this is imported by client components.
 */

/**
 * The most that can go through one of this app's own functions: Vercel
 * rejects a request body over 4.5 MB with a 413 before the handler runs.
 * Anything at or under it is posted to /api/upload as it always was.
 */
export const DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The most the browser may send at all. Past the direct limit a file goes to
 * Vercel Blob first — straight from the browser, never through a function —
 * and is copied from there to ComfyUI. See /api/upload/token and
 * /api/upload/blob.
 *
 * Matched to ComfyUI's own upload ceiling rather than Blob's (5 TB): the file
 * ends up posted to ComfyUI's /upload/image, which refuses anything over its
 * `--max-upload-size`. The user's box runs with `--max-upload-size 100`, so a
 * larger file here would upload to Blob only to be turned away at the last
 * step. Raise both together.
 */
export const LARGE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Where large uploads wait in the Blob store until they are claimed. */
export const BLOB_UPLOAD_PREFIX = "uploads/";
