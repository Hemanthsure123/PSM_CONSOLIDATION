import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted (Latin, variable weight) instead of next/font/google: Google Fonts' answers changed
// and Next 14's Google loader now fails the build ("Cannot read properties of null (reading '1')").
// Same families and weights as before; no request to Google at build or run time.

/** Page and section titles — a grotesque with character, used sparingly. */
const display = localFont({
  src: [{ path: "./fonts/bricolage-grotesque-latin.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-display",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

/** Everything else — sturdy and legible at small sizes, with tabular figures for data. */
const sans = localFont({
  src: [{ path: "./fonts/ibm-plex-sans-latin.woff2", weight: "100 700", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: "NxtWave Placements",
  description: "Screen, evaluate and shortlist candidates for hiring partners, and build company sheets.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
