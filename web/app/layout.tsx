import type { Metadata } from "next";
import { Fredoka, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./Nav";
import Icon from "./Icon";

// Carried over from the Telt brand: Fredoka for display, Hanken Grotesk for
// body, Space Mono for anything a machine produced. The mono is doing real work
// here — an attestation and a transaction hash have to read as machine-real,
// not as prose someone typed.
const display = Fredoka({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "700"],
});

const TITLE = "Telt · Your Binance AI agent";
const DESCRIPTION =
  "A Binance AI agent built with Agent OS. Research with a budget, record a decision, approve an exact order, and inspect signed receipts.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Telt",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Telt",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <head>
        {/* Applied before paint, so a dark-mode reader is not flashed white. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('telt-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}`,
          }}
        />
      </head>
      <body>
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <Nav />
        <div id="content" />
        {children}
        <footer className="wrap footer">
          <div>
            <a className="wordmark" href="/">
              telt<span className="wm-accent">.</span>
            </a>
            <p>
              An independent project built with Binance Agent OS. Trading
              involves risk. Research and signatures do not guarantee a
              profitable outcome.
            </p>
          </div>
          <div className="footer-links">
            <a href="/connect">Connect</a>
            <a href="/verify">Verify</a>
            <a href="https://github.com/Iziedking/kertel">GitHub <Icon name="arrow" /></a>
          </div>
        </footer>
      </body>
    </html>
  );
}
