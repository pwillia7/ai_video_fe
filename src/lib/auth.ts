import { appAccessToken } from "./env";

export const ACCESS_TOKEN_HEADER = "x-app-token";

/**
 * Constant-time comparison so a wrong guess cannot be narrowed down by timing.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns a 401 response when the request fails the shared-secret check, or
 * null when it may proceed. With APP_ACCESS_TOKEN unset the app is open.
 *
 * The query-param fallback exists because <video src> cannot send headers, so
 * the media URL carries the secret. That does mean a copied video link leaks
 * the password — acceptable for a single shared credential, but the reason to
 * prefer a long random value over a memorable one.
 */
export function unauthorized(request: Request): Response | null {
  const expected = appAccessToken();
  if (!expected) return null;

  const provided =
    request.headers.get(ACCESS_TOKEN_HEADER) ??
    new URL(request.url).searchParams.get("token") ??
    "";

  if (safeEqual(provided, expected)) return null;

  return Response.json(
    { error: "Not authorised. Enter the password to continue." },
    { status: 401 },
  );
}

export function isAuthRequired(): boolean {
  return appAccessToken() !== undefined;
}
