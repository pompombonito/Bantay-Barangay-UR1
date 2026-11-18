import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bantay Barangay · Remote Desk",
  description: "Review monitoring prompts for your assigned barangay and respond to the Bantay Barangay desktop operator.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
