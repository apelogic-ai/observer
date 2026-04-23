import type { Metadata } from "next";
import { Suspense } from "react";
import { Space_Grotesk, Inconsolata } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const inconsolata = Inconsolata({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Observer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${inconsolata.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <Image
                src="/ape-icon.svg"
                alt="Observer"
                width={28}
                height={28}
                priority
              />
              <span className="text-lg font-bold tracking-tight text-brand">
                Observer
              </span>
            </Link>
          </div>
        </header>
        <Suspense>{children}</Suspense>
      </body>
    </html>
  );
}
