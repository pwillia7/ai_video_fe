import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "quiet-danger" | "danger";
type Size = "xs" | "sm" | "md" | "lg";

/**
 * Four weights, and the gap between them is what makes a screen readable: one
 * primary action, a bordered secondary, and quiet actions for everything that
 * should be reachable without competing.
 *
 * Every variant carries a border at rest, including the quiet one. That is the
 * point of it — a bare label with a hover colour reads as text until you happen
 * to point at it, so the affordance only exists for people who already suspect
 * it is there. A hairline costs almost nothing visually and says "control"
 * immediately, which is how the rest of this interface draws its edges.
 */
const VARIANTS: Record<Variant, string> = {
  // Geist's primary is a solid fill that inverts on hover rather than dimming.
  primary:
    "bg-accent text-accent-fg border border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary:
    "bg-surface text-fg border border-border-default hover:border-border-strong hover:bg-surface-hover",
  quiet:
    "bg-transparent text-fg-muted border border-border-default hover:border-border-strong hover:bg-surface-hover hover:text-fg",
  // Destructive, but not shouting about it until you reach for it. Its own
  // variant rather than a className override on `quiet`: two hover:border-*
  // utilities have no defined precedence, so which one won would come down to
  // the order Tailwind happened to emit them in.
  "quiet-danger":
    "bg-transparent text-fg-muted border border-border-default hover:border-danger hover:bg-surface-hover hover:text-danger",
  danger:
    "bg-transparent text-danger border border-border-default hover:border-danger hover:bg-surface-hover",
};

/**
 * `xs` is for actions that sit inside another component's furniture — a panel
 * header, a day divider, the footer of a file preview.
 *
 * It shares its type size with `sm` rather than stepping down again: 11px read
 * as a footnote next to the 12px controls it sits beside, and small text is
 * where legibility goes first. The two differ in density — how much room the
 * action takes — not in how readable it is.
 */
const SIZES: Record<Size, string> = {
  xs: "h-6 px-2 text-[12px] rounded gap-1",
  sm: "h-7 px-2.5 text-[12px] rounded-md gap-1.5",
  md: "h-10 px-4 text-sm rounded-md gap-2",
  lg: "h-12 px-5 text-[15px] rounded-lg gap-2",
};

/**
 * `font-sans` is stated rather than inherited. A <button> only gets the page
 * font through `font: inherit` in the preflight, and the `font` shorthand
 * resets every font longhand it does not mention — so the family survives only
 * as long as nothing later in the cascade touches that rule. Naming it here
 * costs one utility and takes the question off the table.
 */
const BASE = `inline-flex items-center justify-center font-sans font-medium
  tracking-[-0.01em] transition-colors duration-150 select-none whitespace-nowrap
  disabled:opacity-45 disabled:pointer-events-none`;

/**
 * The same recipe as a class string, for the handful of controls that have to
 * be an anchor rather than a button — a download link cannot be a <button>
 * without losing what makes it a link.
 */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  className = "",
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, className })}
    >
      {loading ? <Spinner className={size === "xs" ? "size-3" : ""} /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`spin size-3.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
