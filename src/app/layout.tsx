import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { siteUrl } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soran’t",
  description: "Generate video on a local ComfyUI instance.",
  /*
    What the Open Graph image's URL is resolved against. The image itself is
    `opengraph-image.png` beside this file, which Next finds on its own — but an
    OG URL has to be absolute, and without this it resolves to localhost on
    every build, warning as it goes. See `siteUrl`, which reads the deployment
    rather than naming a domain this repo cannot know.

    The icons are not here for the same reason: `favicon.ico`, `icon.svg` and
    `apple-icon.png` are found by filename and need no declaration.
  */
  metadataBase: siteUrl(),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/**
 * Applied before paint so a stored theme choice does not flash the wrong
 * colours. Kept tiny and dependency-free on purpose.
 */
const themeScript = `
try {
  var stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /*
      The font variables belong on <html>, not <body>.

      Tailwind declares --font-sans and --default-font-family on :root as
      `var(--font-geist-sans), …`. A custom property is substituted using the
      variables of the element it is declared on, so with --font-geist-sans
      defined a level lower there is nothing for :root to resolve against and
      --font-sans computes to the guaranteed-invalid value. Everything
      inheriting it then silently falls back to the browser default, and a
      var() fallback does not help — those apply to undefined properties, not
      invalid ones. Utilities like font-sans still worked, because they are
      applied inside <body> where the variable does inherit, which is what made
      it look like a button problem rather than a page-wide one.
    */
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div className="app-backdrop" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
