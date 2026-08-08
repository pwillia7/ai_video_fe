"use client";

import { useMemo, useState } from "react";
import { Field } from "@/components/ui/field";
import {
  NumberInput,
  Select,
  Slider,
  TextArea,
  TextInput,
  Toggle,
} from "@/components/ui/inputs";
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Preserve declaration order of both groups and params within them.
  const groups = useMemo(() => {
    const ordered = new Map<string, ClientParam[]>();
    for (const param of params) {
      const key = param.group ?? DEFAULT_GROUP;
      const existing = ordered.get(key);
      if (existing) existing.push(param);
      else ordered.set(key, [param]);
    }
    return [...ordered.entries()];
  }, [params]);

  const hasAdvanced = params.some((param) => param.advanced);

  return (
    <div className="flex flex-col gap-7">
      {groups.map(([group, groupParams]) => {
        const visible = groupParams.filter(
          (param) => showAdvanced || !param.advanced,
        );
        if (visible.length === 0) return null;

        return (
          <fieldset key={group} className="flex flex-col gap-4" disabled={disabled}>
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
          </fieldset>
        );
      })}

      {hasAdvanced ? (
        <button
          type="button"
          onClick={() => setShowAdvanced((previous) => !previous)}
          className="self-start text-[12px] font-medium text-fg-muted transition-colors
            hover:text-fg inline-flex items-center gap-1.5"
        >
          <svg
            viewBox="0 0 16 16"
            className={`size-3 transition-transform duration-200 ${
              showAdvanced ? "rotate-90" : ""
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
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>
      ) : null}
    </div>
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
  const describedBy = error
    ? `${id}-error`
    : param.help
      ? `${id}-help`
      : undefined;

  switch (param.type) {
    case "text":
      return (
        <Field id={id} label={param.label} help={param.help} error={error}>
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
        <Field id={id} label={param.label} help={param.help} error={error}>
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
        <Field id={id} label={param.label} help={param.help} error={error}>
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
        <Field id={id} label={param.label} help={param.help} error={error}>
          <Toggle
            id={id}
            checked={Boolean(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            disabled={disabled}
            describedBy={describedBy}
          />
        </Field>
      );

    case "seed": {
      const current = Number(value ?? param.default);
      const isRandom = current < 0;
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          error={error}
          trailing={
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(param.id, isRandom ? 0 : -1)}
              className="text-[11px] font-medium text-fg-muted transition-colors
                hover:text-accent disabled:opacity-50"
            >
              {isRandom ? "Set manually" : "Randomise"}
            </button>
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
