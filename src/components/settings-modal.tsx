"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatDuration, formatWhen, renderMs, type Job } from "@/lib/jobs";
import {
  paramVisible,
  type ParamValue,
  type WorkflowSummary,
} from "@/lib/workflows/types";

/**
 * What a past generation was actually run with.
 *
 * The values come from the job's `resolved` map, which is what the server made
 * of the form rather than what the form held — so a randomised seed shows the
 * number that was really used, which is the whole point of being able to look.
 *
 * Labels come from the workflow definition, matched by param id. A generation
 * can outlive the workflow that made it: params get renamed, removed, or added
 * between the run and the reading. Anything the current definition no longer
 * recognises is still shown, under its raw id, because a stale label beats
 * silently dropping a value the user is trying to reconstruct.
 */
export function SettingsModal({
  open,
  onClose,
  job,
  workflow,
  onReuse,
}: {
  open: boolean;
  onClose: () => void;
  job: Job | null;
  /** Absent if the workflow has since been removed from the registry. */
  workflow: WorkflowSummary | undefined;
  /**
   * Loads this run's settings back into the form. Absent when there is nothing
   * to load them into — see the button below.
   */
  onReuse?: (job: Job) => void;
}) {
  if (!job) return null;

  const resolved = job.resolved ?? {};
  // Only what was actually in play. A control the form was hiding at these
  // values took no part in the run — the lyrics box while the lyricist was
  // switched on holds whatever was last typed there, and reading it back as
  // this generation's lyrics would be a plain lie about what was sung.
  const known = workflow
    ? workflow.params.filter(
        (param) => param.id in resolved && paramVisible(param, resolved),
      )
    : [];
  // Every id the workflow still declares, not only the ones shown above: a
  // param that was hidden at these values is accounted for, and must not fall
  // through to the raw-id list below as though the definition had lost it.
  const declaredIds = new Set(workflow?.params.map((param) => param.id) ?? []);
  const unknown = Object.keys(resolved).filter(
    (id) => !declaredIds.has(id) && id !== "prompt",
  );

  /**
   * The written fields, each under its own heading.
   *
   * A section rather than a row in the settings list because these are the ones
   * with newlines in them, and because they are what someone opening this is
   * usually here to read back. There used to be exactly one — the prompt — and
   * it was rendered from `job.prompt` while every other text control was
   * skipped outright. The music workflow has three, so they are all taken from
   * `resolved` now and the prompt is no longer a special case.
   */
  const written = known
    .filter((param) => param.type === "text" || param.type === "textarea")
    .map((param) => ({
      id: param.id,
      label: param.label,
      value: String(resolved[param.id] ?? "").trim(),
    }))
    .filter((field) => field.value !== "");

  // The fallback for a generation whose workflow is gone: there are no param
  // definitions to read labels off, but the prompt was stored on the job
  // itself and is the one field worth keeping in that case.
  const writtenFields =
    written.length > 0
      ? written
      : job.prompt.trim()
        ? [{ id: "prompt", label: "Prompt", value: job.prompt.trim() }]
        : [];

  const rendered = renderMs(job);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generation settings"
      subtitle={job.workflowName}
      footer={
        onReuse ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onReuse(job);
              onClose();
            }}
            title="Load these settings back into the form"
          >
            Reuse settings
          </Button>
        ) : undefined
      }
    >
      {writtenFields.map((field) => (
        <Section key={field.id} heading={field.label}>
          {/*
            Pre-wrap, not a single line: these are written with deliberate line
            breaks — a lyric sheet most of all — and this is the one place they
            can be read back exactly as submitted, ready to copy.
          */}
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg-muted">
            {field.value}
          </p>
        </Section>
      ))}

      {known.length > 0 || unknown.length > 0 ? (
        <Section heading="Settings">
          <dl className="flex flex-col">
            {known.map((param) =>
              param.type === "textarea" || param.type === "text" ? null : (
                <Row
                  key={param.id}
                  label={param.label}
                  value={format(resolved[param.id], param.id)}
                />
              ),
            )}
            {unknown.map((id) => (
              <Row key={id} label={id} value={format(resolved[id], id)} mono />
            ))}
          </dl>
        </Section>
      ) : null}

      <Section heading="Run">
        <dl className="flex flex-col">
          <Row label="Workflow" value={workflow?.name ?? job.workflowName} />
          <Row label="Started" value={formatWhen(job.submittedAt)} />
          {rendered !== null ? (
            <Row label="Render time" value={formatDuration(rendered)} />
          ) : null}
          {job.outputs[0] ? (
            <Row label="File" value={job.outputs[0].filename} mono />
          ) : null}
          <Row label="Prompt ID" value={job.promptId} mono />
        </dl>
      </Section>
    </Modal>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em]
          text-fg-subtle"
      >
        {heading}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    // Wraps rather than truncates: a filename or a reference is only useful in
    // full, and there is nothing below it competing for the space.
    <div
      className="flex items-baseline justify-between gap-4 border-b border-border-default
        py-1.5 last:border-0"
    >
      <dt className="shrink-0 text-[13px] text-fg-subtle">{label}</dt>
      <dd
        className={`min-w-0 break-all text-right text-[13px] text-fg ${
          mono ? "font-mono text-[12px]" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function format(value: ParamValue | undefined, id: string): string {
  if (value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  // The seed is the one number worth reading digit by digit, since reusing it
  // is how a take gets reproduced.
  if (typeof value === "number") return String(value);
  return id === "prompt" ? value : String(value);
}
