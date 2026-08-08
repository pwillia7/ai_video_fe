import type { CSSProperties, ReactNode } from "react";

export function Panel({
  children,
  className = "",
  padded = true,
  style,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  /** Carries the `--delay` custom property for staggered reveals. */
  style?: CSSProperties;
}) {
  return (
    <section
      style={style}
      className={`rounded-xl border border-border-default bg-surface ${
        padded ? "p-4 sm:p-5" : ""
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 mb-4">
      <div className="min-w-0">
        <h2 className="text-sm font-medium tracking-[-0.01em] text-fg">
          {title}
        </h2>
        {hint ? (
          <p className="mt-0.5 text-[13px] leading-snug text-fg-subtle">{hint}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-border-default text-fg-muted",
  accent: "border-accent/40 text-accent",
  success: "border-success/40 text-success",
  warning: "border-warning/40 text-warning",
  danger: "border-danger/40 text-danger",
};

export function Badge({
  children,
  tone = "neutral",
  mono = false,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5
        text-[11px] leading-4 font-medium whitespace-nowrap
        ${mono ? "font-mono" : ""} ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Small status dot. `pulse` marks work in flight. */
export function Dot({
  tone = "neutral",
  pulse = false,
}: {
  tone?: Tone;
  pulse?: boolean;
}) {
  const colors: Record<Tone, string> = {
    neutral: "bg-fg-subtle",
    accent: "bg-accent",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  };
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${colors[tone]} ${
        pulse ? "breathe" : ""
      }`}
    />
  );
}
