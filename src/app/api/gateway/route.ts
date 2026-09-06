import { unauthorized } from "@/lib/auth";
import { ComfyError, gatewayStatus, setGatewayKey } from "@/lib/comfy";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface GatewayPayload {
  /** False when ComfyUI answered but has no `comfyui-vercel-ai-gateway` in it. */
  installed: boolean;
  /** Whether the pack can see a key. The key itself is never readable. */
  configured?: boolean;
  /** Where a key set from here is written, on the ComfyUI machine. */
  configPath?: string;
  modelsCached?: number;
  error?: string;
}

async function report(): Promise<GatewayPayload> {
  const status = await gatewayStatus();
  if (!status) return { installed: false };
  return {
    installed: true,
    configured: status.credentials_configured === true,
    configPath: status.config_path,
    modelsCached: status.models_cached,
  };
}

function failure(error: unknown): GatewayPayload {
  return {
    installed: false,
    error:
      error instanceof ComfyError
        ? error.message
        : "Could not reach ComfyUI.",
  };
}

/**
 * Whether the prompt rewrite has a key to run on.
 *
 * Reported as a normal 200 payload however it went, like /api/health: this
 * drives an indicator, and an indicator that throws is worse than one that says
 * it does not know.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    return Response.json(await report());
  } catch (error) {
    return Response.json(failure(error));
  }
}

/**
 * Hand a Vercel AI Gateway key to the ComfyUI machine.
 *
 * The key passes through and is not kept. It is not stored here, not written
 * into a graph — a key in a node's widget ends up in the queued prompt, and
 * ComfyUI copies the prompt into the metadata of the files a workflow saves —
 * and not echoed back: what comes out of this route is a boolean.
 *
 * Gated by APP_ACCESS_TOKEN like everything else, which is the right level.
 * Anyone who can reach this route can already queue work on the same GPU and
 * spend the same credits.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let apiKey: unknown;
  try {
    ({ apiKey } = (await request.json()) as { apiKey?: unknown });
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  // Length only. What a valid key looks like is the gateway's business, and a
  // pattern guessed at here would reject a format change as a typo.
  if (key.length < 8 || key.length > 400) {
    return Response.json(
      { error: "That does not look like a gateway key." },
      { status: 400 },
    );
  }

  try {
    await setGatewayKey(key);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ComfyError
            ? error.message
            : "ComfyUI would not accept the key.",
      },
      { status: 502 },
    );
  }

  // Read it back from the pack rather than assuming: what is being reported is
  // whether the rewrite can run now, and only the machine knows that.
  try {
    return Response.json(await report());
  } catch (error) {
    return Response.json(failure(error));
  }
}
