/**
 * The favourite mark, in one place because two components draw it — the row in
 * the history and the finished result on the stage — and a star that was hollow
 * in one and solid in the other would read as two different states.
 *
 * Filled when on, outlined when off. That is the whole signal: colour alone
 * would not survive the muted palette these sit in, and a second glyph would
 * make the off state look like something other than the same control.
 */
export function StarIcon({
  filled,
  className = "size-3.5",
}: {
  filled: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      fill={filled ? "currentColor" : "none"}
      aria-hidden="true"
    >
      <path
        d="M8 2.2l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 11.16l-3.52 1.85.67-3.92L2.3 6.34l3.94-.57L8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
