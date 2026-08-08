"use client";

/**
 * Desktop notifications for finished generations.
 *
 * Deliberately only fires while the tab is hidden. If you are already looking
 * at the progress bar, a notification is noise — the point is to let you go do
 * something else.
 *
 * Note the ceiling: the Notifications API needs the page alive, so this covers
 * a backgrounded tab, not a closed one. Notifying after the tab is gone would
 * need a service worker and a push server, which is a different piece of
 * infrastructure entirely.
 */

const STORAGE_KEY = "sorant-notifications";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function permissionState(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

/** Whether the user has opted in *and* the browser still allows it. */
export function notificationsEnabled(): boolean {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage disabled; the preference just will not persist.
  }
}

/**
 * Must be called from a user gesture — browsers reject a bare programmatic
 * request, which is why this is wired to a button rather than run on load.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function notify(title: string, body: string, tag: string): void {
  if (!notificationsEnabled()) return;
  // Visible tab means the user is already watching; stay quiet.
  if (typeof document !== "undefined" && !document.hidden) return;

  try {
    // No icon: the app ships no favicon, and pointing at a missing one just
    // produces a broken image in the notification on some platforms.
    const notification = new Notification(title, {
      body,
      tag, // Replaces an earlier notification for the same job rather than stacking.
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some platforms throw when constructing without a service worker.
  }
}
