"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/inputs";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/client";

interface Gateway {
  installed: boolean;
  configured?: boolean;
  configPath?: string;
  modelsCached?: number;
  error?: string;
}

/**
 * Where the key for the prompt rewrite is set.
 *
 * Every workflow runs the user's prompt through a language model before the
 * video model sees it, and that call is billed to a Vercel AI Gateway account.
 * The key belongs to whoever is using the app, not to whoever deployed it, and
 * it has to end up on the ComfyUI machine — which is typically a box the person
 * at the keyboard is not sitting in front of.
 *
 * So it is set from here, and it goes straight through: the app does not store
 * it, does not log it, and cannot read it back. It is written to a gitignored
 * config.json beside the node pack, on the GPU machine, and everything after
 * that is a boolean. Deliberately *not* written into the graph — a key set on a
 * node's widget is copied into the queued prompt, and ComfyUI stamps the prompt
 * into the metadata of every file a workflow saves, so it would travel inside
 * any video that got shared.
 *
 * The button carries the state rather than a panel somewhere: with no key
 * nothing generates at all, and that is worth a warning in the header. With one
 * set it is a quiet way back in to change it.
 */
export function RewriteKeyButton() {
  const [gateway, setGateway] = useState<Gateway | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGateway(await api<Gateway>("/api/gateway"));
    } catch {
      // The connection pill is already saying the box is unreachable. Saying it
      // twice, in a control about something else, is noise.
      setGateway(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Nothing to say until the first answer, and nothing to offer on an install
  // that has no gateway pack in it — there is no config.json to write to.
  if (!gateway?.installed) return null;

  const configured = gateway.configured === true;
  const label = configured
    ? "Change the key the prompt rewrite runs on"
    : "No rewrite key set — generations will fail until one is";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={`grid size-8 place-items-center rounded-md border transition-colors duration-150
          ${
            configured
              ? "border-border-default bg-surface text-fg-muted hover:border-border-strong hover:text-fg"
              : "border-warning/50 bg-warning/10 text-warning hover:border-warning"
          }`}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
          <circle cx="5.5" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8.25 8H14M11.5 8v2.25M13 8v1.75"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <RewriteKeyModal
        open={open}
        onClose={() => setOpen(false)}
        gateway={gateway}
        onSaved={setGateway}
      />
    </>
  );
}

function RewriteKeyModal({
  open,
  onClose,
  gateway,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  gateway: Gateway;
  onSaved: (next: Gateway) => void;
}) {
  const id = useId();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never leave a typed key sitting in state behind a closed dialog.
  useEffect(() => {
    if (!open) {
      setKey("");
      setError(null);
    }
  }, [open]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api<Gateway>("/api/gateway", {
        method: "POST",
        body: JSON.stringify({ apiKey: key }),
      });
      onSaved(next);
      setKey("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the key.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rewrite key"
      subtitle={
        gateway.configured
          ? "A key is set. Entering another replaces it."
          : "No key set — the prompt rewrite cannot run without one."
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || key.trim().length < 8}
          >
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed text-fg-muted">
        Every workflow expands what you type into a full shot description before
        the video model sees it, and that runs on the{" "}
        <a
          href="https://vercel.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          Vercel AI Gateway
        </a>
        . Create a key there under AI Gateway → API Keys; every team gets $5 of
        credit a month, and the free models in the Rewrite model list cost
        nothing against it.
      </p>

      {/*
        A form around one field, for the reason Chrome states in the console:
        "Password field is not contained in a form". A password input outside
        one is a field its password manager cannot offer to fill or save, and
        this modal lives in the DOM from page load, so the notice is there on
        every visit whether or not anyone opens it.

        It also buys the behaviour anyone typing a key into a box expects, which
        the modal did not have: Enter submits.
      */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && key.trim().length >= 8) void save();
        }}
      >
        {/*
          The username half of a password form, which Chrome asks for next:
          "Password forms should have (optionally hidden) username fields for
          accessibility". There is no account here — the key is the whole
          credential — so this names the thing the key belongs to, which is
          also what makes a password manager offer to save it under a useful
          label rather than under the site alone.
        */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value="Vercel AI Gateway"
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
        <Field
          id={id}
          label="Gateway API key"
          help="Sent straight to your ComfyUI machine and written next to the node pack. It is not stored here and cannot be read back."
        >
          <PasswordInput
            id={id}
            value={key}
            onChange={setKey}
            placeholder="vck_…"
            disabled={saving}
          />
        </Field>
      </form>

      {error ? (
        <p className="text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {gateway.configPath ? (
        <p className="text-[12px] break-all text-fg-subtle">
          Written to <span className="font-mono">{gateway.configPath}</span> on
          the ComfyUI machine. Setting <span className="font-mono">AI_GATEWAY_API_KEY</span>{" "}
          in that machine&rsquo;s environment does the same job and takes
          precedence.
        </p>
      ) : null}
    </Modal>
  );
}
