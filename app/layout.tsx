import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "POK Cross-Venue Terminal",
  description: "Read-only Kalshi and Polymarket BTC binary arbitrage terminal.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
