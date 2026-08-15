import type { SVGProps } from "react";

/**
 * The Soran’t mark: a film frame with the play triangle entering from the left
 * and perforations punched out of the right edge.
 *
 * Paths are the supplied vectors verbatim — this is artwork rather than code to
 * improve, and the same geometry ships as `src/app/icon.svg` and the PNG app
 * icons, which cannot be regenerated from here.
 *
 * The three blues are fixed, because the mark is the mark on either theme. The
 * play triangle is the exception and takes `currentColor`, which is what makes
 * one component serve both: at `text-fg` it resolves to near-black on light and
 * near-white on dark, matching the two static variants the bundle ships as
 * `sorant-mark-on-light.svg` and `sorant-mark-on-dark.svg`.
 *
 * Decorative wherever the name is already written beside it — pass
 * `aria-hidden`, as the header does, and the `role`/`aria-label` below stop
 * mattering. They are the default so the mark is still announced when it stands
 * on its own.
 */
export function SorantMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Soran’t"
      className={className}
      {...props}
    >
      <defs>
        {/* Punched through rather than drawn on: the perforations have to be
            holes, or they would be black dots on whatever the mark sits on. */}
        <mask id="sorant-film-mask">
          <rect width="64" height="64" fill="white" />
          <rect x="47" y="17" width="6" height="7" rx="2" fill="black" />
          <rect x="47" y="28.5" width="6" height="7" rx="2" fill="black" />
          <rect x="47" y="40" width="6" height="7" rx="2" fill="black" />
        </mask>
      </defs>
      <path
        d="M21 13 36 17v30l-15 4c-2-.7-3-2.3-3-5V18c0-2.7 1-4.3 3-5Z"
        fill="#6E9CFF"
        opacity=".72"
      />
      <path
        d="m26 11.5 13 4v33l-13 4c-2-.7-3-2.3-3-5v-31c0-2.7 1-4.3 3-5Z"
        fill="#4D82FF"
        opacity=".78"
      />
      <path
        d="M34 10h16c4 0 6 2 6 6v32c0 4-2 6-6 6H34c-4 0-6-2-6-6V16c0-4 2-6 6-6Z"
        fill="#2F6BFF"
        mask="url(#sorant-film-mask)"
      />
      <path
        d="M11 20.5c0-1.5 1-2 2-1l22.5 11.1c1.8.9 1.8 1.9 0 2.8L13 44.55c-1 .55-2 .05-2-1.05Z"
        fill="currentColor"
      />
    </svg>
  );
}
