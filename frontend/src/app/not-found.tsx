import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};

/**
 * Catch-all 404 page. Next will render this for any URL that doesn't
 * match a route or whose dynamic segment fails to resolve.
 */
export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 flex flex-col items-center text-center">
      <Image
        src="/mintiMascot.png"
        alt="Minti mascot, looking around"
        width={120}
        height={120}
        className="mb-6 opacity-60"
      />
      <h1 className="text-2xl font-bold mb-2">Nothing here</h1>
      <p className="text-foreground-secondary mb-6 max-w-md">
        The page you&rsquo;re looking for doesn&rsquo;t exist, or the link
        you followed is incorrect.
      </p>
      <div className="flex gap-3">
        <Link
          href="/"
          className="px-4 py-2 bg-mint text-background font-medium text-sm rounded-lg hover:bg-mint-dim transition-colors"
        >
          Home
        </Link>
        <Link
          href="/explore"
          className="px-4 py-2 text-sm border border-border rounded-lg hover:border-mint/50 hover:text-mint transition-colors"
        >
          Explore collections
        </Link>
      </div>
    </div>
  );
}
