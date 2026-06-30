import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Single-Token Buyer Detector",
  description: "Find Solana wallets whose historical DEX buys only include one token."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
