import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
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

export const metadata: Metadata = {
  title: "minti.art — Decentralized NFT Marketplace",
  description:
    "Buy, sell, and bid on NFTs across EVM chains. Zero backend, fully on-chain order book. 0.1% protocol fee.",
  icons: {
    icon: "/mintiSVG.svg",
  },
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
        <link rel="dns-prefetch" href="https://4everland.io" />
        <link rel="dns-prefetch" href="https://w3s.link" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen flex flex-col`}
      >
        <Web3Provider>
          <ToastProvider>
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </ToastProvider>
        </Web3Provider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
