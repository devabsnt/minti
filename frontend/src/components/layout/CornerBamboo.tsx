"use client";

import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Landing-page corner bamboo. Three small bushels per side, each at
 * a slightly different position and base-lean angle. At the top of
 * the page every bushel leans toward the viewport center. As the
 * user scrolls down, the lean interpolates back toward 0deg
 * (straight up). No translation - the bushels stay anchored at the
 * side edges; only their tilt animates.
 *
 * Right-side bushels are the same SVG mirrored via `scaleX(-1)` on
 * the side wrapper, so the leans naturally face the right
 * direction without separate markup.
 *
 * Scroll value is propagated as `--bamboo-progress` (0 -> 1) on a
 * ref'd DOM node and consumed via `calc()` in CSS. Each bushel
 * also carries a `--lean-base` inline CSS variable so its
 * particular base rotation can be tuned independently while sharing
 * the same straightening curve.
 */
export function CornerBamboo() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let ticking = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Mark as "currently scrolling" so the breeze sway pauses
      // (the user is providing their own motion, two simultaneous
      // motions on the same element reads as jittery). Debounce to
      // 220ms idle before resuming sway.
      const el = ref.current;
      if (el) el.classList.add("bamboo-scrolling");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (el) el.classList.remove("bamboo-scrolling");
      }, 220);

      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="corner-bamboo"
      aria-hidden
      style={{ ["--bamboo-progress" as string]: 0 }}
    >
      <div className="corner-bamboo-side corner-bamboo-left">
        <div className="bamboo-back-layer">
          {BACK_BUSHELS.map((b, i) => (
            <BushelSlot key={i} {...b} side="left" />
          ))}
        </div>
        <div className="bamboo-front-layer">
          {FRONT_BUSHELS.map((b, i) => (
            <BushelSlot key={i} {...b} side="left" />
          ))}
        </div>
      </div>
      <div className="corner-bamboo-side corner-bamboo-right">
        <div className="bamboo-back-layer">
          {BACK_BUSHELS.map((b, i) => (
            <BushelSlot key={i} {...b} side="right" />
          ))}
        </div>
        <div className="bamboo-front-layer">
          {FRONT_BUSHELS.map((b, i) => (
            <BushelSlot key={i} {...b} side="right" />
          ))}
        </div>
      </div>
    </div>
  );
}

interface BushelDef {
  /** Distance from the inside edge of the side, in px. */
  inset: number;
  /** Width of the bushel container, in px. */
  width: number;
  /** Initial inward lean angle at the top of the page (degrees).
   *  Positive value: top tilts toward viewport center. Same value
   *  works for both sides because the side wrapper mirrors the SVG
   *  separately, but we negate it on the right via the `side` prop
   *  below so the rotation also points the right way. */
  leanBase: number;
  /** Which SVG variant to render. */
  variant: "a" | "b" | "c";
}

// Two layers of bushels per side. The back layer sits behind the
// front layer, smaller and more transparent, to give the cluster
// real depth. Inner-most insets are pushed further outward (smaller
// positive values) so they don't intrude on page content.
const FRONT_BUSHELS: BushelDef[] = [
  { inset: -80, width: 220, leanBase: 22, variant: "a" },
  { inset: -10, width: 260, leanBase: 14, variant: "b" },
  { inset: 70, width: 200, leanBase: 18, variant: "c" },
];

// Back-layer bushels sit slightly further inward than the front so
// they peek between the front stalks. Smaller width + lower opacity
// keep them visually subordinate (handled in CSS via `.bamboo-back-layer`).
const BACK_BUSHELS: BushelDef[] = [
  { inset: -50, width: 180, leanBase: 26, variant: "b" },
  { inset: 20, width: 200, leanBase: 16, variant: "c" },
  { inset: 100, width: 170, leanBase: 12, variant: "a" },
];

function BushelSlot({
  inset,
  width,
  leanBase,
  variant,
  side,
}: BushelDef & { side: "left" | "right" }) {
  // Right-side bushels: anchor with `right` instead of `left`, mirror
  // the SVG with scaleX(-1), and negate the lean so the top still
  // tilts toward viewport center.
  const positionStyle: CSSProperties =
    side === "left"
      ? { left: `${inset}px` }
      : { right: `${inset}px` };
  const effectiveLean = side === "left" ? leanBase : -leanBase;
  return (
    <div
      className="bamboo-bushel"
      style={
        {
          ...positionStyle,
          width: `${width}px`,
          ["--lean-base"]: `${effectiveLean}deg`,
        } as CSSProperties
      }
    >
      {/* Inner sway wrapper: the gentle breeze animation lives on
          this element so it composes with the outer bushel's
          scroll-driven lean rather than fighting it. */}
      <div className="bamboo-sway">
        <BushelSvg variant={variant} mirror={side === "right"} />
      </div>
    </div>
  );
}

/**
 * Bushel SVG. Three variants so a row of bushels doesn't read as
 * an obvious copy-paste. Each variant has 1-3 stalks with
 * hand-tuned heights and leaf clusters at the top.
 */
function BushelSvg({
  variant,
  mirror = false,
}: {
  variant: "a" | "b" | "c";
  mirror?: boolean;
}) {
  const stalks = STALK_DEFS[variant];
  return (
    <svg
      viewBox="0 0 240 560"
      width="100%"
      height="100%"
      preserveAspectRatio="xMinYMax meet"
      role="img"
      aria-label="Bamboo"
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    >
      <defs>
        <filter
          id={`bamboo-rough-${variant}`}
          x="-5%"
          y="-5%"
          width="110%"
          height="110%"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.022"
            numOctaves="2"
            seed={variant === "a" ? "3" : variant === "b" ? "7" : "11"}
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
      <g filter={`url(#bamboo-rough-${variant})`}>
        {stalks.map((s, i) => (
          <Stalk key={i} {...s} />
        ))}
      </g>
    </svg>
  );
}

interface StalkDef {
  x: number;
  topY: number;
  thickness: number;
  intraLean: number;
}

const STALK_DEFS: Record<"a" | "b" | "c", StalkDef[]> = {
  a: [
    { x: 30, topY: 160, thickness: 28, intraLean: 0 },
    { x: 90, topY: 110, thickness: 32, intraLean: 4 },
    { x: 160, topY: 200, thickness: 26, intraLean: -3 },
  ],
  b: [
    { x: 24, topY: 90, thickness: 30, intraLean: 2 },
    { x: 110, topY: 60, thickness: 36, intraLean: 0 },
    { x: 180, topY: 130, thickness: 28, intraLean: -2 },
  ],
  c: [
    { x: 50, topY: 220, thickness: 32, intraLean: 0 },
    { x: 130, topY: 180, thickness: 28, intraLean: 3 },
  ],
};

function Stalk({ x, topY, thickness, intraLean }: StalkDef) {
  const t = thickness;
  const baseY = 560;
  const joints: number[] = [];
  for (let y = topY + 60; y < baseY - 30; y += 80) joints.push(y);
  return (
    <g
      transform={`translate(${x} 0) rotate(${intraLean} 0 ${baseY})`}
      style={{ transformOrigin: `0 ${baseY}px` }}
    >
      <path
        d={`M 1.5 ${baseY} L ${t + 1.5} ${baseY} L ${t + 1.5} ${topY} L 1.5 ${topY} Z`}
        fill="#56755e"
      />
      <path
        d={`M 0 ${baseY} L ${t} ${baseY} L ${t} ${topY} L 0 ${topY} Z`}
        fill="#82a87b"
      />
      <path
        d={`M 1 ${baseY - 6} L ${Math.max(2, t * 0.18)} ${baseY - 6} L ${Math.max(2, t * 0.18)} ${topY + 8} L 1 ${topY + 8} Z`}
        fill="#a8c79f"
        opacity="0.55"
      />
      {joints.map((y, i) => (
        <path
          key={i}
          d={`M -1 ${y} L ${t + 1} ${y} L ${t + 1} ${y + 5} L -1 ${y + 5} Z`}
          fill="#5c7d57"
        />
      ))}
      <g transform={`translate(${t / 2} ${topY}) rotate(-4)`}>
        <path
          d="M 0 0 C -22 -10 -42 -28 -54 -50 C -38 -38 -18 -22 0 -6 Z"
          fill="#82a87b"
        />
        <path
          d="M 0 0 C 22 -12 42 -32 52 -54 C 38 -38 16 -22 0 -8 Z"
          fill="#5c7d57"
        />
        <path
          d="M -4 -4 C -12 -32 -10 -58 -2 -76 C 2 -56 4 -30 -2 -8 Z"
          fill="#7aa172"
          opacity="0.9"
        />
      </g>
    </g>
  );
}
