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

/**
 * Audio system.
 *
 * Two sounds:
 *   1. Page-turn ("/pageTurn.mp3") - five distinct page-flip recordings
 *      back to back in one 9.4s file. We never play the same one twice
 *      in a row. Segments below were measured with ffmpeg silence-detect
 *      so we cut precisely around each sound (no dead air leading or
 *      trailing).
 *   2. Paper-hover - a quiet synthesized paper-rustle generated on the
 *      fly via WebAudio. Plays on card hover. Synth not file because
 *      (a) we don't want another network round trip, (b) we want the
 *      hover sound to be subtly different every time so it doesn't feel
 *      mechanical, (c) the file is small (zero bytes).
 *
 * Trigger policy:
 *   - Page-turn fires on EXPLICIT user actions: clicking a card link,
 *     opening a modal, opening a collection. NOT on route changes from
 *     nav links - that felt off.
 *   - Hover fires on `pointerenter` from any card. Throttled per-card
 *     so dragging the cursor across a grid doesn't machine-gun.
 *
 * Autoplay: browsers block sound until a user gesture. We initialize
 * a single AudioContext lazily on the first user gesture so all
 * subsequent calls work.
 */

interface PageTurnSegment {
  start: number;   // seconds
  duration: number; // seconds
}

/**
 * Measured with `ffmpeg -af silencedetect=noise=-35dB:duration=0.1`
 * on `/pageTurn.mp3`. Each entry covers the active audio with ~50ms
 * head/tail padding so we don't clip the attack or release.
 */
const PAGE_TURN_SEGMENTS: PageTurnSegment[] = [
  { start: 0.232, duration: 0.430 },
  { start: 1.697, duration: 0.991 },
  { start: 3.748, duration: 0.807 },
  { start: 5.911, duration: 1.136 },
  { start: 8.003, duration: 0.668 },
];

interface SoundContextValue {
  /** Play one of the page-turn segments, never repeating the last. */
  playPageTurn: () => void;
  /** Play a short quiet paper-rustle. Safe to spam (throttled per call). */
  playPaperHover: () => void;
}

const SoundContext = createContext<SoundContextValue | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSegmentRef = useRef<number>(-1);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastHoverAtRef = useRef<number>(0);

  // Page-turn audio element. Built once and reused.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const audio = new Audio("/pageTurn.mp3");
    audio.preload = "auto";
    audio.volume = 0.5;
    audioRef.current = audio;
    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  const playPageTurn = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Pick a segment that isn't the one we just played.
    let next = Math.floor(Math.random() * PAGE_TURN_SEGMENTS.length);
    if (next === lastSegmentRef.current) {
      next = (next + 1) % PAGE_TURN_SEGMENTS.length;
    }
    lastSegmentRef.current = next;
    const seg = PAGE_TURN_SEGMENTS[next];

    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    try {
      audio.pause();
      audio.currentTime = seg.start;
      void audio.play().catch(() => {});
      stopTimerRef.current = setTimeout(() => {
        audio.pause();
        stopTimerRef.current = null;
      }, seg.duration * 1000);
    } catch {
      // currentTime can throw before metadata loads. Ignore.
    }
  }, []);

  // Paper-hover sound deliberately removed. The hook stays callable
  // (as a no-op) so every card's `onPointerEnter={playPaperHover}`
  // wiring continues to work without changes; if we ever want a
  // hover sound back, we drop the implementation in here in one
  // place and every card lights up.
  const playPaperHover = useCallback(() => {
    // intentionally empty
  }, []);

  const value = useMemo<SoundContextValue>(
    () => ({ playPageTurn, playPaperHover }),
    [playPageTurn, playPaperHover],
  );

  return (
    <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
  );
}

/**
 * Dispatch a page-turn sound. Use for clicks that "go somewhere":
 * card opens, modal opens, navigating into a collection. Do NOT use
 * for top-nav route changes - that felt off in practice.
 */
export function usePageTurnSound(): () => void {
  const ctx = useContext(SoundContext);
  return ctx ? ctx.playPageTurn : () => {};
}

/** Dispatch a quiet paper-rustle. Wire to pointerenter on cards. */
export function usePaperHoverSound(): () => void {
  const ctx = useContext(SoundContext);
  return ctx ? ctx.playPaperHover : () => {};
}
