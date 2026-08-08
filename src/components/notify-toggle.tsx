"use client";

import { useEffect, useState } from "react";
import {
  notificationsEnabled,
  notificationsSupported,
  permissionState,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "@/lib/notifications";

/**
 * Opt-in toggle for finish notifications. Rendered only where a click can
 * carry the permission prompt, since browsers reject a request that is not
 * tied to a user gesture.
 */
export function NotifyToggle() {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported" | null
  >(null);

  useEffect(() => {
    setPermission(permissionState());
    setEnabled(notificationsEnabled());
  }, []);

  if (permission === null) return null;
  if (permission === "unsupported") return null;

  const blocked = permission === "denied";

  const toggle = async () => {
    if (blocked) return;

    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }

    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      setNotificationsEnabled(true);
      setEnabled(true);
    }
  };

  const label = blocked
    ? "Notifications are blocked for this site — re-enable them in your browser settings"
    : enabled
      ? "Notifications on. You will be told when a generation finishes while this tab is in the background."
      : "Notify me when a generation finishes";

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={blocked}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      className={`grid size-8 place-items-center rounded-md border transition-colors duration-150
        disabled:cursor-not-allowed disabled:opacity-40
        ${
          enabled
            ? "border-accent/40 bg-accent-subtle/40 text-accent"
            : "border-border-default bg-surface text-fg-muted hover:border-border-strong hover:text-fg"
        }`}
    >
      {enabled ? (
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
          <path
            d="M4 6.5a4 4 0 0 1 8 0c0 2.5.6 3.6 1.1 4.2.3.3.1.8-.3.8H3.2c-.4 0-.6-.5-.3-.8C3.4 10.1 4 9 4 6.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M6.5 13a1.6 1.6 0 0 0 3 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
          <path
            d="M4 6.5a4 4 0 0 1 8 0c0 2.5.6 3.6 1.1 4.2.3.3.1.8-.3.8H3.2c-.4 0-.6-.5-.3-.8C3.4 10.1 4 9 4 6.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M6.5 13a1.6 1.6 0 0 0 3 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path
            d="M2.5 2.5l11 11"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
