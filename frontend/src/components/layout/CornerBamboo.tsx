"use client";

import { useEffect, useRef } from "react";

/**
 * Corner bamboo decorations on the landing page.
 *
 * Two bamboo clumps anchored to the bottom-left and bottom-right
 * corners of the viewport. At rest they lean inward toward the page
 * center, like the entrance to a paper-craft theater set. As the
 * user scrolls down, they translate outward and rotate further from
 * center, parting like a curtain.
 *
 * Visuals:
 * - Multi-stalk SVG clumps. Paper Mario style flat shading, two
 *   sage tones per stalk to suggest paper-cutout layering.
 * - A subtle `<feTurbulence>` displacement filter wobbles every
 *   edge so the cuts look hand-made rather than machine-precise.
 * - The right clump is the same SVG mirrored via `scaleX(-1)`.
 *
 * Scroll mapping:
 * - Progress = scrollY / viewportHeight, clamped to [0, 1].
 * - At progress 0: rotate inward 14deg, no translate.
 * - At progress 1: rotate outward 16deg, translate 35% off-screen.
 * - Updated via a CSS custom property so the transform stays on
 *   the compositor (no React re-renders per scroll frame).
 *
 * Pointer events: disabled on the wrapper so the bamboo never
 * intercepts clicks on the hero content sitting above it.
 */
export function CornerBamboo() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let ticking = false;

    const update = () => {
      ticking = false;
      const el = ref.current;
      if (!el) return;
      const progress = Math.min(
        1,
        Math.max(0, window.scrollY / window.innerHeight),
      );
      el.style.setProperty("--bamboo-progress", String(progress));
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    // Initial set so first paint isn't at 0 if the page loaded scrolled.
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      ref={ref}
      className="corner-bamboo"
      aria-hidden
      style={{ ["--bamboo-progress" as string]: 0 }}
    >
      <div className="corner-bamboo-left">
        <BambooClump />
      </div>
      <div className="corner-bamboo-right">
        <BambooClump />
      </div>
    </div>
  );
}

/**
 * A single bamboo clump SVG. Three stalks at different heights and
 * lean angles, plus leaf clusters at the top of each. Flat sage
 * colors with one shadow tone per stalk to suggest the back face of
 * a paper cutout. Edges are wobbled by an SVG turbulence filter so
 * cuts read as hand-made.
 *
 * The viewBox is set wide enough that leaves can extend slightly
 * outside the central "stalks" column without being clipped.
 */
function BambooClump() {
  return (
    <svg
      viewBox="0 0 320 480"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYEnd meet"
      role="img"
      aria-label="Bamboo decoration"
    >
      <defs>
        {/* Rough-cut edge filter: small turbulent displacement that
            wobbles every stroke and fill boundary. Subtle enough that
            shapes are still recognizable, strong enough to break the
            "vector perfection" look. */}
        <filter id="bamboo-rough" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.022"
            numOctaves="2"
            seed="3"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="2.4"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>

      <g filter="url(#bamboo-rough)">
        {/* ─── Back stalk (tallest, slight right lean) ───────────── */}
        <g transform="translate(150 0)">
          {/* Back-face shadow (offset darker copy) */}
          <path
            d="M 12 460 C 14 360 18 230 22 60 L 38 60 C 34 230 30 360 28 460 Z"
            fill="#5c7d57"
          />
          {/* Front face */}
          <path
            d="M 8 460 C 10 360 14 230 18 60 L 34 60 C 30 230 26 360 24 460 Z"
            fill="#82a87b"
          />
          {/* Joint bands */}
          <path
            d="M 9 360 C 14 358 22 358 34 360 L 33 366 C 22 364 14 364 10 366 Z"
            fill="#5c7d57"
          />
          <path
            d="M 11 250 C 16 248 23 248 32 250 L 31 256 C 23 254 17 254 12 256 Z"
            fill="#5c7d57"
          />
          <path
            d="M 14 140 C 18 138 24 138 30 140 L 29 146 C 23 144 19 144 15 146 Z"
            fill="#5c7d57"
          />
          {/* Highlight stripe */}
          <path
            d="M 10 460 C 12 360 16 220 20 70 L 23 70 C 19 220 15 360 13 460 Z"
            fill="#a8c79f"
            opacity="0.55"
          />
          {/* Top leaf cluster */}
          <g transform="translate(20 60) rotate(-6)">
            <path
              d="M 0 0 C -22 -14 -42 -32 -52 -52 C -34 -42 -14 -28 0 -8 Z"
              fill="#6b9874"
            />
            <path
              d="M 0 0 C 22 -16 42 -36 50 -58 C 36 -46 16 -30 0 -10 Z"
              fill="#82a87b"
            />
            <path
              d="M -6 -6 C -16 -34 -16 -60 -8 -78 C -4 -58 -2 -34 -4 -10 Z"
              fill="#5c7d57"
            />
          </g>
        </g>

        {/* ─── Middle stalk (medium, more vertical) ─────────────── */}
        <g transform="translate(95 0)">
          <path
            d="M 14 460 C 16 380 18 280 22 160 L 36 160 C 32 280 28 380 26 460 Z"
            fill="#5c7d57"
          />
          <path
            d="M 10 460 C 12 380 14 280 18 160 L 32 160 C 28 280 24 380 22 460 Z"
            fill="#7ea478"
          />
          <path
            d="M 11 380 C 15 378 22 378 31 380 L 30 386 C 22 384 16 384 12 386 Z"
            fill="#5c7d57"
          />
          <path
            d="M 14 280 C 17 278 23 278 30 280 L 29 286 C 23 284 18 284 15 286 Z"
            fill="#5c7d57"
          />
          <path
            d="M 12 460 C 14 380 16 280 20 170 L 23 170 C 19 280 17 380 15 460 Z"
            fill="#a8c79f"
            opacity="0.5"
          />
          {/* Leaf cluster at top */}
          <g transform="translate(20 160) rotate(8)">
            <path
              d="M 0 0 C -18 -10 -34 -24 -42 -42 C -28 -34 -12 -22 0 -6 Z"
              fill="#82a87b"
            />
            <path
              d="M 0 0 C 16 -14 30 -28 36 -46 C 26 -34 12 -22 0 -8 Z"
              fill="#6b9874"
            />
          </g>
        </g>

        {/* ─── Front stalk (shortest, slight left lean) ─────────── */}
        <g transform="translate(40 0)">
          <path
            d="M 18 460 C 16 400 14 320 12 240 L 28 240 C 28 320 28 400 30 460 Z"
            fill="#5c7d57"
          />
          <path
            d="M 14 460 C 12 400 10 320 8 240 L 24 240 C 24 320 24 400 26 460 Z"
            fill="#7aa172"
          />
          <path
            d="M 9 400 C 13 398 19 398 26 400 L 25 406 C 19 404 14 404 10 406 Z"
            fill="#5c7d57"
          />
          <path
            d="M 8 320 C 12 318 18 318 25 320 L 24 326 C 18 324 13 324 9 326 Z"
            fill="#5c7d57"
          />
          <path
            d="M 11 460 C 9 400 7 320 5 245 L 8 245 C 10 320 12 400 14 460 Z"
            fill="#a8c79f"
            opacity="0.45"
          />
          {/* Leaves at top */}
          <g transform="translate(16 240) rotate(-12)">
            <path
              d="M 0 0 C -16 -8 -28 -22 -34 -38 C -22 -28 -8 -16 0 -4 Z"
              fill="#7aa172"
            />
            <path
              d="M 0 0 C 14 -10 26 -22 30 -38 C 22 -28 10 -16 0 -6 Z"
              fill="#6b9874"
            />
          </g>
        </g>

        {/* ─── Ground tuft: short grass-like sprouts at the base ── */}
        <g transform="translate(60 460)">
          <path
            d="M 0 0 C 4 -18 6 -28 4 -40 C 12 -32 12 -16 8 0 Z"
            fill="#6b9874"
          />
        </g>
        <g transform="translate(210 460)">
          <path
            d="M 0 0 C -4 -20 -2 -30 -10 -42 C -16 -28 -14 -14 -8 0 Z"
            fill="#82a87b"
          />
        </g>

      </g>
    </svg>
  );
}
