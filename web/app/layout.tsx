import type { Metadata } from "next";
import { Fredoka, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./Nav";

// Carried over from the Telt brand: Fredoka for display, Hanken Grotesk for
// body, Space Mono for anything a machine produced. The mono is doing real work
// here — an attestation and a transaction hash have to read as machine-real,
// not as prose someone typed.
const display = Fredoka({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "700"] });

const TITLE = "Telt · a trading agent you can verify";
const DESCRIPTION =
  "Telt buys its own research over x402 and signs every conclusion with the same key that paid. The payment is on a public chain, the evidence is committed to by hash, and anyone can check the chain without trusting the agent. Binance spot and USDⓈ-M futures, over MCP.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Telt",
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: "Telt", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        {/* Applied before paint, so a dark-mode reader is not flashed white. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('telt-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
