"use client";

import { Modal } from "@/components/ui/modal";
import type { WorkflowTips } from "@/lib/workflows/tips";

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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Prompting tips"
      subtitle={title}
      footer={
        <a
          href="https://docs.comfy.org/tutorials/video/minimax/minimax-h3"
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-fg-subtle transition-colors hover:text-accent"
        >
          From ComfyUI&rsquo;s MiniMax H3 guide ↗
        </a>
      }
    >
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
    </Modal>
  );
}
