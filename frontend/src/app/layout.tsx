import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { SoundProvider } from "@/providers/SoundProvider";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CornerBamboo } from "@/components/layout/CornerBamboo";
import { ToastProvider } from "@/components/ui/Toast";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Editorial serif for postcard-feel headings and Nº numerals.
// Fraunces has the right warmth: a hint of decorative flair without
// being too display-y, and supports italic + bold weights we use.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://minti.art"),
  title: {
    default: "minti.art - fully on-chain NFT marketplace",
    template: "%s · minti.art",
  },
  description:
    "Launch and trade NFTs with art and metadata stored 100% on chain via EVMFS. Zero backend, fully on-chain order book, 0.1% protocol fee. Monad mainnet.",
  applicationName: "minti.art",
  authors: [{ name: "minti" }],
  keywords: [
    "NFT marketplace",
    "Monad",
    "EVMFS",
    "on-chain NFT",
    "ERC-721",
    "ERC-1155",
    "decentralized marketplace",
  ],
  icons: {
    icon: "/mintiSVG.svg",
    apple: "/mintiMascot.png",
  },
  openGraph: {
    type: "website",
    siteName: "minti.art",
    url: "https://minti.art",
    title: "minti.art - fully on-chain NFT marketplace",
    description:
      "Launch and trade NFTs stored 100% on chain via EVMFS. Zero backend, fully on-chain order book.",
    images: [
      {
        url: "/mintiMascot.png",
        width: 512,
        height: 512,
        alt: "minti mascot",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "minti.art - fully on-chain NFT marketplace",
    description:
      "Launch and trade NFTs stored 100% on chain via EVMFS. Zero backend.",
    images: ["/mintiMascot.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
  manifest: "/site.webmanifest",
};

/**
 * Viewport + theme-color. Drives the address-bar tint on mobile browsers
 * (Chrome on Android, Safari on iOS) so the chrome blends into the dark
 * page instead of flashing white.
 */
export const viewport: Viewport = {
  themeColor: "#0a0a0f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        {/*
          Pre-resolve DNS + open TCP/TLS to the IPFS cache and fallback
          gateways before the first image request fires. Saves 100-300ms
          on every cold image load.
        */}
        <link rel="preconnect" href="https://ipfs-cache.devskibb.workers.dev" crossOrigin="" />
        <link rel="dns-prefetch" href="https://ipfs-cache.devskibb.workers.dev" />
        <link rel="dns-prefetch" href="https://ipfs.io" />
        <link rel="dns-prefetch" href="https://dweb.link" />
        <link rel="dns-prefetch" href="https://w3s.link" />
        {/* arweave.net is hit by every ar:// metadata fetch */}
        <link rel="dns-prefetch" href="https://arweave.net" />
        {/* wallet scan path (Hypersync proxy) */}
        <link rel="dns-prefetch" href="https://monad-hypersync-proxy.devskibb.workers.dev" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased min-h-screen flex flex-col`}
      >
        <Web3Provider>
          <SoundProvider>
            <ToastProvider>
              <Header />
              <main className="flex-1">{children}</main>
              <Footer />
              <CornerBamboo />
            </ToastProvider>
          </SoundProvider>
        </Web3Provider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
