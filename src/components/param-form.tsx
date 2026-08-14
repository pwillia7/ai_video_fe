"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ImageUpload } from "@/components/ui/image-upload";
import {
  NumberInput,
  Select,
  Slider,
  TextArea,
  TextInput,
  Toggle,
} from "@/components/ui/inputs";
import { VideoUpload } from "@/components/ui/video-upload";
import type { ClientParam, ParamValue } from "@/lib/workflows/types";

const DEFAULT_GROUP = "Settings";

export function ParamForm({
  params,
  values,
  onChange,
  disabled,
  fieldError,
}: {
  params: ClientParam[];
  values: Record<string, ParamValue>;
  onChange: (id: string, value: ParamValue) => void;
  disabled?: boolean;
  /** Server-side validation error keyed to a param id. */
  fieldError?: { field?: string; message: string } | null;
}) {
  /**
   * Which groups have their advanced params showing, keyed by group name.
   *
   * Per group rather than one switch for the form, because the disclosure now
   * sits inside the group it belongs to. It used to sit under the whole form,
   * which read as a control that did nothing: the only advanced param in the
   * app is in References, near the top of the reference workflow, so pressing a
   * button at the bottom of the panel revealed a control off-screen above it.
   */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Preserve declaration order of both groups and params within them.
  //
  // A `measured` param is dropped here rather than rendered as nothing: it has
  // no control, and leaving it in would let a group that holds only measured
  // params draw an empty heading.
  const groups = useMemo(() => {
    const ordered = new Map<string, ClientParam[]>();
    for (const param of params) {
      if (param.type === "measured") continue;
      const key = param.group ?? DEFAULT_GROUP;
      const existing = ordered.get(key);
      if (existing) existing.push(param);
      else ordered.set(key, [param]);
    }
    return [...ordered.entries()];
  }, [params]);

  return (
    <div className="flex flex-col gap-7">
      {groups.map(([group, groupParams]) => {
        const open = openGroups[group] ?? false;
        const advanced = groupParams.filter((param) => param.advanced);
        const visible = groupParams.filter(
          (param) => open || !param.advanced,
        );
        if (visible.length === 0) return null;

        return (
          // min-w-0 restates the globals.css rule at the call site: fieldset's
          // UA min-inline-size:min-content otherwise stops the whole group
          // shrinking around wide content.
          <fieldset
            key={group}
            className="flex min-w-0 flex-col gap-4"
            disabled={disabled}
          >
            <legend
              className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle"
            >
              {group}
            </legend>

            {visible.map((param) => (
              <Control
                key={param.id}
                param={param}
                value={values[param.id]}
                onChange={onChange}
                disabled={disabled}
                error={
                  fieldError && fieldError.field === param.id
                    ? fieldError.message
                    : undefined
                }
              />
            ))}

            {/* Nothing to disclose, no disclosure. Only one group in the app
                has an advanced param, so on most workflows this never draws. */}
            {advanced.length > 0 ? (
              <Disclosure
                open={open}
                onToggle={() =>
                  setOpenGroups((previous) => ({
                    ...previous,
                    [group]: !open,
                  }))
                }
              >
                {open ? "Hide advanced" : "Advanced"}
              </Disclosure>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

/** A quiet show/hide control with a chevron that turns. */
export function Disclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="quiet"
      size="xs"
      className="self-start"
      aria-expanded={open}
      onClick={onToggle}
      icon={
        <svg
          viewBox="0 0 16 16"
          className={`size-3 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      }
    >
      {children}
    </Button>
  );
}

function Control({
  param,
  value,
  onChange,
  disabled,
  error,
}: {
  param: ClientParam;
  value: ParamValue | undefined;
  onChange: (id: string, value: ParamValue) => void;
  disabled?: boolean;
  error?: string;
}) {
  const id = `param-${param.id}`;

  /**
   * The consequence of the value that is actually set, if this control has one
   * to declare — see `noteAt`. Compared loosely against the default so an
   * untouched control still reports it: `value` is undefined until something
   * writes it, and what the run would do is the same either way.
   */
  const note =
    param.noteAt && (value ?? param.default) === param.noteAt.value
      ? param.noteAt.text
      : undefined;

  const describedBy =
    [
      error ? `${id}-error` : param.help ? `${id}-help` : null,
      note ? `${id}-note` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  switch (param.type) {
    case "text":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <TextInput
            id={id}
            value={String(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            placeholder={param.placeholder}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "textarea":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <TextArea
            id={id}
            value={String(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            placeholder={param.placeholder}
            rows={param.rows}
            maxLength={param.maxLength}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "slider": {
      const current = Number(value ?? param.default);
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
          trailing={
            <span className="font-mono text-[12px] tabular-nums text-fg-muted">
              {current}
              {param.unit ? (
                <span className="ml-1 text-fg-subtle">{param.unit}</span>
              ) : null}
            </span>
          }
        >
          <Slider
            id={id}
            value={current}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    case "number":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
          trailing={
            param.unit ? (
              <span className="text-[12px] text-fg-subtle">{param.unit}</span>
            ) : undefined
          }
        >
          <NumberInput
            id={id}
            value={Number(value ?? param.default)}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "select":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <Select
            id={id}
            value={String(value ?? param.default)}
            options={param.options}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "toggle":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <Toggle
            id={id}
            checked={Boolean(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "image":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <ImageUpload
            id={id}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "video": {
      // Bound outside the closure so it stays narrowed to a string.
      const measures = param.measures;
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
        >
          <VideoUpload
            id={id}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            onMeasure={
              measures ? (seconds) => onChange(measures, seconds) : undefined
            }
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    // Filled in by whichever control measures it — see `measures` on the video
    // param. Nothing to draw.
    case "measured":
      return null;

    case "seed": {
      const current = Number(value ?? param.default);
      const isRandom = current < 0;
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          note={note}
          error={error}
          trailing={
            <Button
              variant="quiet"
              size="xs"
              disabled={disabled}
              onClick={() => onChange(param.id, isRandom ? 0 : -1)}
            >
              {isRandom ? "Set manually" : "Randomise"}
            </Button>
          }
        >
          {isRandom ? (
            <div
              className="flex h-10 items-center rounded-md border border-dashed
                border-border-strong bg-bg-subtle px-3 font-mono text-[13px] text-fg-subtle"
            >
              random each run
            </div>
          ) : (
            <NumberInput
              id={id}
              value={current}
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              onChange={(next) => onChange(param.id, next)}
              disabled={disabled}
              describedBy={describedBy}
            />
          )}
        </Field>
      );
    }
  }
}
