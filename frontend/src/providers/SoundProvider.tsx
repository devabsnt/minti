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

  const playPaperHover = useCallback(() => {
    if (typeof window === "undefined") return;
    // Per-call throttle. Even at 60fps mouse moves, we won't fire more
    // than once per 180ms - keeps cursor sweeps from buzzing.
    const now = performance.now();
    if (now - lastHoverAtRef.current < 180) return;
    lastHoverAtRef.current = now;

    try {
      // Lazy-init the AudioContext on the first hover. The autoplay
      // policy needs a user gesture upstream - hover counts in modern
      // Chromium and Safari.
      if (!audioCtxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) return;
        audioCtxRef.current = new Ctor();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});

      // Synth a 90-110ms whisper of filtered noise. Bandpass tuned to
      // 2-5kHz so it reads as "paper" not "static". Volume kept very
      // low (peak gain ~0.05) so it never overpowers content.
      const duration = 0.08 + Math.random() * 0.04;
      const sampleRate = ctx.sampleRate;
      const buffer = ctx.createBuffer(1, sampleRate * duration, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.7;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.value = 2800 + Math.random() * 1500;
      bandpass.Q.value = 1.2;

      const gain = ctx.createGain();
      // Soft attack + decay envelope so it doesn't click.
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.05, t0 + 0.008);
      gain.gain.linearRampToValueAtTime(0.0, t0 + duration);

      source.connect(bandpass).connect(gain).connect(ctx.destination);
      source.start();
      source.stop(t0 + duration + 0.02);
    } catch {
      // Audio APIs sometimes throw in private mode / restrictive
      // contexts. Silently skip.
    }
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
