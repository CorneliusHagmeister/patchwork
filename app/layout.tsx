import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Patchwork",
  description: "A crowd-powered swarm for open-source security — every bug ships with a fix.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
