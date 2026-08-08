import { unauthorized } from "@/lib/auth";
import { ComfyAuthError, ComfyError, getQueue, systemStats } from "@/lib/comfy";
import { comfyUrl } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface HealthPayload {
  reachable: boolean;
  /** False when ComfyUI answered but rejected our token. */
  authorized?: boolean;
  /**
   * Whether COMFY_URL is https. Only the scheme is exposed, never the host —
   * enough to confirm a TLS cutover from the UI without publishing the endpoint.
   */
  secure: boolean;
  error?: string;
  queueRunning?: number;
  queuePending?: number;
  device?: string;
  vramTotalMb?: number;
  vramFreeMb?: number;
}

/**
 * Is the GPU box actually up? Drives the connection pill in the header, so a
 * failure here is reported as a normal 200 payload rather than an error.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const secure = comfyUrl().startsWith("https:");

  try {
    const [stats, queue] = await Promise.all([systemStats(), getQueue()]);

    const typed = stats as {
      devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
    };
    const device = typed.devices?.[0];

    return Response.json({
      reachable: true,
      authorized: true,
      secure,
      queueRunning: queue.queue_running?.length ?? 0,
      queuePending: queue.queue_pending?.length ?? 0,
      device: device?.name,
      vramTotalMb: device?.vram_total
        ? Math.round(device.vram_total / 1024 / 1024)
        : undefined,
      vramFreeMb: device?.vram_free
        ? Math.round(device.vram_free / 1024 / 1024)
        : undefined,
    } satisfies HealthPayload);
  } catch (error) {
    // An auth failure means the box is up and talking — it just refused us.
    // Reporting that as "offline" would send you debugging the wrong thing.
    if (error instanceof ComfyAuthError) {
      return Response.json({
        reachable: true,
        authorized: false,
        secure,
        error: error.message,
      } satisfies HealthPayload);
    }

    return Response.json({
      reachable: false,
      secure,
      error:
        error instanceof ComfyError
          ? error.message
          : "Could not reach ComfyUI.",
    } satisfies HealthPayload);
  }
}
