"use client";

import { useEffect, useRef } from "react";
import type { WorkflowTips } from "@/lib/workflows/tips";

/**
 * Built on the native <dialog> so focus trapping, Esc-to-close and inertness of
 * the page behind come from the platform rather than being reimplemented.
 *
 * Presented as a bottom sheet on small screens and a centred panel from sm up:
 * a centred box on a phone leaves the content in the hardest place to reach,
 * while a sheet sits under the thumb and can be dismissed downward by habit.
 */
export function TipsModal({
  open,
  onClose,
  title,
  tips,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  tips: WorkflowTips;
}) {
  const ref = useRef<HTMLDialogElement>(null);

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
      aria-labelledby="tips-title"
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
              id="tips-title"
              className="text-sm font-medium tracking-[-0.01em] text-fg"
            >
              Prompting tips
            </h2>
            <p className="mt-0.5 truncate text-[12px] text-fg-subtle">{title}</p>
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
          {tips.sections.map((section) => (
            <section key={section.heading}>
              <h3
                className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em]
                  text-fg-subtle"
              >
                {section.heading}
              </h3>
              <ul className="flex flex-col gap-2">
                {section.items.map((item) => (
                  <li
                    key={item}
                    className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-subtle"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="border-t border-border-default px-5 py-3">
          <a
            href="https://docs.comfy.org/tutorials/video/minimax/minimax-h3"
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-fg-subtle transition-colors hover:text-accent"
          >
            From ComfyUI&rsquo;s MiniMax H3 guide ↗
          </a>
        </footer>
      </div>
    </dialog>
  );
}
