/**
 * Server-only configuration. Never import this from a client component —
 * COMFY_URL and the auth secrets must not reach the browser.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Base URL of the ComfyUI instance, normalised without a trailing slash. */
export function comfyUrl(): string {
  return required("COMFY_URL", process.env.COMFY_URL).replace(/\/+$/, "");
}

/**
 * Shared secret gating this app's own API routes. Unset means the app is open,
 * which is fine locally but leaves a public deployment able to drive the GPU.
 */
export function appAccessToken(): string | undefined {
  const token = process.env.APP_ACCESS_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * Where this deployment answers, for the metadata that has to be an absolute
 * URL — the Open Graph image is the only one so far.
 *
 * Found rather than configured, because there is no one right answer to write
 * down: this app is deployed by whoever cloned it, to their own project. Vercel
 * supplies the production domain in `VERCEL_PROJECT_PRODUCTION_URL` and the
 * per-deployment one in `VERCEL_URL`, and the production domain is preferred so
 * a link shared from a preview still points at the real site's image.
 *
 * Falls back to localhost, which is what Next assumes anyway and is correct for
 * `next dev` — the difference is that this way it says so without a warning at
 * every build.
 */
export function siteUrl(): URL {
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return new URL(host ? `https://${host}` : "http://localhost:3000");
}

export function generationTimeoutMs(): number {
  const raw = Number(process.env.GENERATION_TIMEOUT_SECONDS ?? 1800);
  return (Number.isFinite(raw) && raw > 0 ? raw : 1800) * 1000;
}

let warnedAboutTokenShape = false;

/**
 * Token for the ComfyUI-Login custom node. Its value is the bcrypt hash the
 * node prints to the ComfyUI console when you set a password, so it starts
 * with `$2b$` (or `$2a$`/`$2y$`).
 *
 * That leading `$` is a trap: dotenv expands `$NAME` references inside .env
 * files, so an unescaped hash silently becomes mangled. Each `$` must be
 * written `\$` in .env.local. Values set in the Vercel dashboard are literal
 * and need no escaping.
 */
export function comfyApiToken(): string | undefined {
  const token = process.env.COMFY_API_TOKEN?.trim();
  if (!token) return undefined;

  if (!/^\$2[aby]?\$/.test(token) && !warnedAboutTokenShape) {
    warnedAboutTokenShape = true;
    console.warn(
      "COMFY_API_TOKEN does not look like a bcrypt hash (expected it to start with $2b$). " +
        "If you pasted it into .env.local, escape every $ as \\$ — dotenv expanded it away.",
    );
  }

  return token;
}

/** Extra headers to reach ComfyUI when it sits behind a proxy or basic auth. */
export function comfyAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // ComfyUI-Login: Authorization: Bearer <token>. Preferred over the ?token=
  // query form because a bcrypt hash contains characters that need escaping
  // in a URL, and because it keeps the secret out of access logs.
  const token = comfyApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const basic = process.env.COMFY_BASIC_AUTH;
  if (basic) {
    // An explicit basic-auth proxy wins: the login node would not be in play.
    headers.Authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
  }

  const name = process.env.COMFY_AUTH_HEADER_NAME;
  const value = process.env.COMFY_AUTH_HEADER_VALUE;
  if (name && value) headers[name] = value;

  return headers;
}
