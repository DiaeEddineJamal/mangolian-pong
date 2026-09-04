import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mangolian Pong",
  description: "A local and online retro Pong game.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en"><body>{children}</body></html>
  );
}
