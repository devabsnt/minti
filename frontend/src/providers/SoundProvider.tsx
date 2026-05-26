"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

/**
 * Page-turn audio.
 *
 * The asset (`/pageTurn.mp3`) is one 9-second file containing five
 * distinct page-flip sounds back to back. Each segment is ~1.8s. We
 * play one at a time by seeking the audio element to the segment's
 * start and pausing once it has played for the segment duration. We
 * never play the same segment twice in a row.
 *
 * Triggers handled here:
 *   - Pathname change (route navigation)
 * Components can also dispatch a manual play via the context's
 * `playPageTurn()` for things like modal opens, modal closes, etc.
 *
 * Audio policy: browsers block sound until the user has interacted
 * with the page. The first navigation/open before any user gesture
 * is silently swallowed by the browser; subsequent ones work.
 */

const SEGMENT_COUNT = 5;
const TOTAL_DURATION = 9;             // seconds
const SEGMENT_DURATION = TOTAL_DURATION / SEGMENT_COUNT; // 1.8s

interface SoundContextValue {
  /** Play one of the page-turn segments, never repeating the last. */
  playPageTurn: () => void;
}

const SoundContext = createContext<SoundContextValue | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSegmentRef = useRef<number>(-1);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const previousPathnameRef = useRef<string | null>(null);

  // Lazy-init the audio element on the client. Building one element
  // and reusing it avoids re-decode work and respects the same
  // browser autoplay policy for every call.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const audio = new Audio("/pageTurn.mp3");
    audio.preload = "auto";
    audio.volume = 0.45;
    audioRef.current = audio;
    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  const playPageTurn = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Pick a segment index that isn't the one we just played.
    let next = Math.floor(Math.random() * SEGMENT_COUNT);
    if (next === lastSegmentRef.current) {
      next = (next + 1) % SEGMENT_COUNT;
    }
    lastSegmentRef.current = next;

    // Clear any in-flight stop timer from a previous play.
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    try {
      audio.pause();
      audio.currentTime = next * SEGMENT_DURATION;
      // The play() promise rejects when autoplay is blocked. Swallow
      // it - we'd rather be silent than throw.
      void audio.play().catch(() => {});
      stopTimerRef.current = setTimeout(() => {
        audio.pause();
        stopTimerRef.current = null;
      }, SEGMENT_DURATION * 1000);
    } catch {
      // Some browsers throw synchronously if currentTime is set
      // before metadata loads. Ignore - next call will try again.
    }
  }, []);

  // Fire on route changes. Skip the very first pathname (initial
  // page load) so the user doesn't get a page-flip greeting.
  useEffect(() => {
    if (previousPathnameRef.current === null) {
      previousPathnameRef.current = pathname;
      return;
    }
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    playPageTurn();
  }, [pathname, playPageTurn]);

  const value = useMemo<SoundContextValue>(
    () => ({ playPageTurn }),
    [playPageTurn],
  );

  return (
    <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
  );
}

/**
 * Hook to dispatch a page-turn sound from anywhere (modal opens,
 * tab switches, etc.). Returns a no-op outside the provider so it's
 * safe to call from server components or in tests.
 */
export function usePageTurnSound(): () => void {
  const ctx = useContext(SoundContext);
  return ctx ? ctx.playPageTurn : () => {};
}
