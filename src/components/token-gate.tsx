"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/inputs";
import { api, ApiError, setToken } from "@/lib/client";

/**
 * Shown when APP_ACCESS_TOKEN is set on the server. The token is checked by
 * making a real authenticated call rather than trusting anything client-side.
 */
export function TokenGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!value.trim() || checking) return;
    setChecking(true);
    setError(null);
    setToken(value.trim());

    try {
      await api("/api/workflows");
      onUnlocked();
    } catch (cause) {
      setToken(null);
      setError(
        cause instanceof ApiError && cause.status === 401
          ? "That password was not accepted."
          : "Could not verify the password. Try again.",
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="rise w-full max-w-sm rounded-xl border border-border-default
          bg-surface p-6"
      >
        <h1 className="text-base font-medium tracking-[-0.02em] text-fg">
          Soran’t
        </h1>
        <p className="mt-1 mb-5 text-[13px] leading-relaxed text-fg-muted">
          This instance is protected. Enter the password to continue.
        </p>

        <Field id="token" label="Password" error={error ?? undefined}>
          <PasswordInput
            id="token"
            value={value}
            onChange={setValue}
            placeholder="Enter password"
            disabled={checking}
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          className="mt-5 w-full"
          loading={checking}
          disabled={!value.trim()}
        >
          Unlock
        </Button>
      </form>
    </main>
  );
}
