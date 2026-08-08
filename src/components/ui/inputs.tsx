"use client";

import type { ChangeEvent } from "react";

const CONTROL_BASE = `w-full bg-bg-subtle border border-border-default rounded-md
  text-fg placeholder:text-fg-subtle transition-colors duration-150
  hover:border-border-strong focus:border-accent focus:outline-none
  focus:ring-2 focus:ring-accent/25 disabled:opacity-50`;

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_BASE} h-10 px-3 text-sm`}
    />
  );
}

/** Same as TextInput but masked, and hinted to password managers. */
export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="password"
      autoComplete="current-password"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_BASE} h-10 px-3 text-sm`}
    />
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  describedBy,
  maxLength,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  describedBy?: string;
  maxLength?: number;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      /*
        The prompt boxes ask for 10-12 rows, which is reasonable on a desktop
        column and swallows a phone screen whole. Capping at half the viewport
        only bites on small screens — a 12-row box is well under 50vh on a
        laptop — so no breakpoint is needed.
      */
      className={`${CONTROL_BASE} max-h-[50vh] resize-y overflow-y-auto px-3 py-2.5 text-sm leading-relaxed min-h-20`}
    />
  );
}

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL_BASE} h-10 pl-3 pr-9 text-sm appearance-none cursor-pointer`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M4 6l4 4 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className={`${CONTROL_BASE} h-10 px-3 text-sm font-mono tabular-nums`}
    />
  );
}

export function Slider({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  describedBy?: string;
}) {
  const handle = (event: ChangeEvent<HTMLInputElement>) =>
    onChange(Number(event.target.value));

  return (
    <input
      id={id}
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={handle}
    />
  );
}

export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full
        border transition-colors duration-200 disabled:opacity-50
        ${
          checked
            ? "bg-accent border-accent"
            : "bg-track border-border-default hover:border-border-strong"
        }`}
    >
      <span
        className={`absolute size-4 rounded-full bg-white shadow-sm transition-transform duration-200
          ${checked ? "translate-x-6" : "translate-x-1"}`}
      />
    </button>
  );
}
