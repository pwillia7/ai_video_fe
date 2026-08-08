import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soran’t",
  description: "Generate video on a local ComfyUI instance.",
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <div className="app-backdrop" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
