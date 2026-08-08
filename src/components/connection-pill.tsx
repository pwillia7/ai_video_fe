"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Dot } from "@/components/ui/panel";

interface Health {
  reachable: boolean;
  authorized?: boolean;
  secure?: boolean;
  error?: string;
  queueRunning?: number;
  queuePending?: number;
  device?: string;
  vramTotalMb?: number;
  vramFreeMb?: number;
}

/**
 * Live view of the GPU box. Polls slowly — it is a reassurance indicator, not
 * something to hammer the endpoint over.
 */
export function ConnectionPill() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const next = await api<Health>("/api/health");
        if (!cancelled) setHealth(next);
      } catch {
        if (!cancelled) setHealth({ reachable: false });
      }
    };

    check();
    const id = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const busy = (health?.queueRunning ?? 0) > 0;
  const unauthorized = health?.reachable === true && health.authorized === false;

  const label = !health
    ? "Checking…"
    : !health.reachable
      ? "Offline"
      : unauthorized
        ? "Auth failed"
        : busy
          ? "Busy"
          : "Ready";

  const insecure = health?.secure === false;

  const title = health?.reachable && !unauthorized
    ? [
        insecure ? "Connected over plain HTTP — traffic is not encrypted" : null,
        health.device,
        health.vramFreeMb && health.vramTotalMb
          ? `${(health.vramFreeMb / 1024).toFixed(1)} / ${(health.vramTotalMb / 1024).toFixed(1)} GB VRAM free`
          : null,
        `${health.queuePending ?? 0} queued`,
      ]
        .filter(Boolean)
        .join(" · ")
    : (health?.error ?? "Waiting for the first health check");

  return (
    <div
      title={title}
      className="inline-flex items-center gap-2 rounded-full border border-border-default
        bg-surface px-2.5 py-1 text-[12px] text-fg-muted"
    >
      <Dot
        tone={
          !health
            ? "neutral"
            : !health.reachable || unauthorized
              ? "danger"
              : busy
                ? "warning"
                : "success"
        }
        pulse={busy || !health}
      />
      <span className="font-medium text-fg">{label}</span>
      {/* Unlocked padlock while the ComfyUI leg is unencrypted. */}
      {insecure && health?.reachable ? (
        <svg
          viewBox="0 0 16 16"
          className="size-3 text-warning"
          fill="none"
          aria-label="Unencrypted connection to ComfyUI"
          role="img"
        >
          <rect
            x="3.5"
            y="7"
            width="9"
            height="6"
            rx="1.2"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path
            d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
      {health?.reachable && !unauthorized && (health.queuePending ?? 0) > 0 ? (
        <span className="font-mono tabular-nums">+{health.queuePending}</span>
      ) : null}
    </div>
  );
}
