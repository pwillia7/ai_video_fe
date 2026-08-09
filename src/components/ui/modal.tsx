"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Built on the native <dialog> so focus trapping, Esc-to-close and inertness of
 * the page behind come from the platform rather than being reimplemented.
 *
 * Presented as a bottom sheet on small screens and a centred panel from sm up:
 * a centred box on a phone leaves the content in the hardest place to reach,
 * while a sheet sits under the thumb and can be dismissed downward by habit.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Second line in the header, usually what the content is about. */
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Fires for Esc as well as close(), so React state cannot drift out of
      // sync with the element's own open state.
      onClose={onClose}
      onClick={(event) => {
        // A click landing on the dialog itself is a click on the backdrop —
        // the content sits in a child element.
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby={titleId}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-hidden rounded-t-2xl
        border border-border-default bg-surface p-0 text-fg shadow-lg
        backdrop:bg-black/60 backdrop:backdrop-blur-[2px]
        sm:m-auto sm:max-h-[80dvh] sm:w-[min(32rem,calc(100vw-2rem))] sm:rounded-xl"
    >
      <div className="flex max-h-[85dvh] flex-col sm:max-h-[80dvh]">
        <header
          className="flex items-start justify-between gap-4 border-b border-border-default
            px-5 py-4"
        >
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-sm font-medium tracking-[-0.01em] text-fg"
            >
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-[12px] text-fg-subtle">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 grid size-8 shrink-0 place-items-center rounded-md
              text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>

        {footer ? (
          <footer className="border-t border-border-default px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}
