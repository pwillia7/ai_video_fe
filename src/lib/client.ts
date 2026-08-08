"use client";

/** Browser-side wrapper around this app's own API. Never talks to ComfyUI. */

const TOKEN_KEY = "video-studio-token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Session storage, not local: the token dies with the tab. */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing with storage disabled — the token just will not persist.
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("x-app-token", token);

  // Only JSON bodies get a JSON content-type. FormData must be left alone: the
  // browser generates a `multipart/form-data; boundary=...` header itself, and
  // overwriting it strips the boundary so the server can parse nothing back out.
  const bodyIsFormData =
    typeof FormData !== "undefined" && init.body instanceof FormData;

  if (init.body && !bodyIsFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      detail?: unknown;
    };
    throw new ApiError(
      body.error ?? `Request failed with ${response.status}.`,
      response.status,
      body.field,
      body.detail,
    );
  }

  return (await response.json()) as T;
}

/** Attach the token to a media URL, since <video src> cannot send headers. */
export function withToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
