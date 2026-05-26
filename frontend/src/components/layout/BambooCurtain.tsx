"use client";

import { useEffect, useState } from "react";
import { usePageTurnSound } from "@/providers/SoundProvider";

/**
 * Bamboo curtain reveal on the landing page.
 *
 * Two halves of a bamboo image sit at the left and right edges of the
 * viewport. On first visit (per session) the curtain is briefly
 * visible, then parts outward to reveal the hero. A page-turn sound
 * plays at the moment of parting.
 *
 * Repeat-visit behavior:
 * - We set `sessionStorage.minti.curtainSeen` after the first reveal.
 *   Subsequent renders this session start in the open state, skipping
 *   the animation. Closing the tab and reopening shows it again.
 *
 * Accessibility:
 * - `aria-hidden` on the wrapper because it's purely decorative.
 * - `prefers-reduced-motion` skips the transition entirely and starts
 *   in the open state.
 *
 * The cutout aesthetic comes from a layered sepia drop-shadow that
 * traces the bamboo silhouette exactly (`filter: drop-shadow`
 * respects PNG alpha). The first layer is a thin dark outline; the
 * second is an offset paper-backing shadow.
 */
export function BambooCurtain() {
  const playPageTurn = usePageTurnSound();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already played this session: jump to open and don't animate.
    if (sessionStorage.getItem("minti.curtainSeen")) {
      setOpen(true);
      // Still unmount after a tick so we're not paying for fixed-
      // position children on every render.
      const timer = setTimeout(() => setMounted(false), 50);
      return () => clearTimeout(timer);
    }

    // Respect the user's motion preference.
    const reduce =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) {
      sessionStorage.setItem("minti.curtainSeen", "1");
      setOpen(true);
      const timer = setTimeout(() => setMounted(false), 50);
      return () => clearTimeout(timer);
    }

    // First visit this session. Let the page paint once with the
    // curtain visible, then open it.
    const openTimer = setTimeout(() => {
      setOpen(true);
      sessionStorage.setItem("minti.curtainSeen", "1");
      playPageTurn();
    }, 380);

    // Unmount after the open animation finishes so we don't keep the
    // pointer-event-blocking layer alive longer than needed.
    const unmountTimer = setTimeout(() => setMounted(false), 380 + 1200);

    return () => {
      clearTimeout(openTimer);
      clearTimeout(unmountTimer);
    };
  }, [playPageTurn]);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-40 pointer-events-none overflow-hidden"
      aria-hidden
    >
      <div className={`bamboo-half left ${open ? "open" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bamboo.png" alt="" />
      </div>
      <div className={`bamboo-half right ${open ? "open" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bamboo.png" alt="" />
      </div>
    </div>
  );
}
