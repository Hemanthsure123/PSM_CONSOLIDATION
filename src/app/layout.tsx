import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NxtWave Placement Automation",
  description:
    "Consolidate candidate profiles, generate AI screening reports, and export company sheets.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-muted/30 antialiased">{children}</body>
    </html>
  );
}
