"use client";

import { useEffect, useRef } from "react";

/**
 * Corner bamboo decoration on the landing page.
 *
 * Two dense bushes (left + right) each composed of two layers:
 * - Back layer: smaller, lighter, more washed-out sage. Recedes
 *   slowly on scroll.
 * - Front layer: taller, brighter, fuller leaves. Recedes faster on
 *   scroll, creating a parallax sense of depth.
 *
 * At rest the bushes mostly obscure the page. As the user scrolls
 * down, the front layer slides outward by ~60% and the back layer
 * by ~25%, until both are only peeking in from the page edges.
 *
 * The scroll transform is driven by a CSS custom property
 * `--bamboo-progress` (0 -> 1) updated from `window.scrollY /
 * window.innerHeight`. The variable is set on a ref-held DOM node,
 * so React does not re-render every frame; the transform stays on
 * the compositor.
 *
 * Right-side mirroring is done with `scaleX(-1)` on the side
 * wrapper. The parallax translateX values on inner layers are
 * negative on both sides; on the right that negative becomes
 * positive in viewport coordinates because of the parent flip.
 *
 * Pointer events are disabled at the wrapper so the bamboo never
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
      <div className="corner-bamboo-side corner-bamboo-left">
        <div className="bamboo-layer bamboo-back">
          <BambooBush variant="back" />
        </div>
        <div className="bamboo-layer bamboo-front">
          <BambooBush variant="front" />
        </div>
      </div>
      <div className="corner-bamboo-side corner-bamboo-right">
        <div className="bamboo-layer bamboo-back">
          <BambooBush variant="back" />
        </div>
        <div className="bamboo-layer bamboo-front">
          <BambooBush variant="front" />
        </div>
      </div>
    </div>
  );
}

interface StalkConfig {
  /** Horizontal position of the stalk base (in viewBox units). */
  x: number;
  /** Y position of the top of the stalk (lower number = taller). */
  topY: number;
  /** Width of the stalk in viewBox units. */
  thickness: number;
  /** Degrees of lean. Positive leans right. */
  lean: number;
  /** Body color (front face). */
  body: string;
  /** Shadow color (back face / shaded side). */
  shadow: string;
  /** Highlight color (the thin bright strip on the front face). */
  highlight: string;
  /** Joint band color (the darker rings between segments). */
  joint: string;
  /** Rotation direction for the top leaf cluster (degrees). */
  leafTilt: number;
  /** Light-leaf and dark-leaf colors for the top cluster. */
  leafLight: string;
  leafDark: string;
}

/**
 * Render a single bamboo stalk with joints, highlight, and a top
 * leaf cluster. Coordinates assume a 600x720 viewBox; positions are
 * relative to the stalk base at the bottom.
 */
function BambooStalk({ s, baseY = 720 }: { s: StalkConfig; baseY?: number }) {
  const t = s.thickness;
  const stalkHeight = baseY - s.topY;
  // Joint positions, every ~70 units along the stalk height.
  const joints: number[] = [];
  for (let y = s.topY + 50; y < baseY - 30; y += 70) joints.push(y);
  return (
    <g
      transform={`translate(${s.x} 0) rotate(${s.lean} 0 ${baseY})`}
      style={{ transformOrigin: `0 ${baseY}px` }}
    >
      {/* Shadow / back face: identical silhouette, offset slightly */}
      <path
        d={`M ${1.5} ${baseY} L ${t + 1.5} ${baseY} L ${t + 1.5} ${s.topY} L ${1.5} ${s.topY} Z`}
        fill={s.shadow}
      />
      {/* Front face */}
      <path
        d={`M 0 ${baseY} L ${t} ${baseY} L ${t} ${s.topY} L 0 ${s.topY} Z`}
        fill={s.body}
      />
      {/* Highlight stripe (left edge, thin) */}
      <path
        d={`M 1 ${baseY - 4} L ${Math.max(2, t * 0.18)} ${baseY - 4} L ${Math.max(2, t * 0.18)} ${s.topY + 6} L 1 ${s.topY + 6} Z`}
        fill={s.highlight}
        opacity="0.55"
      />
      {/* Joint bands */}
      {joints.map((y, i) => (
        <path
          key={`j${i}`}
          d={`M -1 ${y} L ${t + 1} ${y} L ${t + 1} ${y + 5} L -1 ${y + 5} Z`}
          fill={s.joint}
        />
      ))}
      {/* Top leaf cluster: three lobes around the top of the stalk */}
      <g
        transform={`translate(${t / 2} ${s.topY}) rotate(${s.leafTilt})`}
      >
        <path
          d="M 0 0 C -22 -10 -42 -28 -54 -50 C -38 -38 -18 -22 0 -6 Z"
          fill={s.leafLight}
        />
        <path
          d="M 0 0 C 22 -12 42 -32 52 -54 C 38 -38 16 -22 0 -8 Z"
          fill={s.leafDark}
        />
        <path
          d="M -4 -4 C -12 -32 -10 -58 -2 -76 C 2 -56 4 -30 -2 -8 Z"
          fill={s.leafLight}
          opacity="0.85"
        />
      </g>
    </g>
  );
}

/**
 * One bush. The back variant has fewer, paler stalks with smaller
 * leaf clusters. The front variant is the showpiece - taller stalks,
 * fuller leaves, richer color. Same SVG viewBox so the two layers
 * register with each other and stack into a single visual.
 */
function BambooBush({ variant }: { variant: "back" | "front" }) {
  const stalks: StalkConfig[] = variant === "back"
    ? [
        // Back layer - washed sage, slightly tilted toward center.
        {
          x: 60, topY: 180, thickness: 22, lean: 6,
          body: "#a3bea0", shadow: "#7a9778", highlight: "#c6dac4", joint: "#7a9778",
          leafTilt: -4, leafLight: "#9bb898", leafDark: "#7a9778",
        },
        {
          x: 130, topY: 230, thickness: 20, lean: 3,
          body: "#a8c2a4", shadow: "#809d7d", highlight: "#c6dac4", joint: "#809d7d",
          leafTilt: 8, leafLight: "#9bb898", leafDark: "#7a9778",
        },
        {
          x: 210, topY: 160, thickness: 24, lean: 10,
          body: "#a3bea0", shadow: "#7a9778", highlight: "#c6dac4", joint: "#7a9778",
          leafTilt: 12, leafLight: "#9bb898", leafDark: "#7a9778",
        },
        {
          x: 300, topY: 240, thickness: 19, lean: 4,
          body: "#a8c2a4", shadow: "#809d7d", highlight: "#c6dac4", joint: "#809d7d",
          leafTilt: -8, leafLight: "#9bb898", leafDark: "#7a9778",
        },
        {
          x: 380, topY: 200, thickness: 22, lean: 8,
          body: "#a3bea0", shadow: "#7a9778", highlight: "#c6dac4", joint: "#7a9778",
          leafTilt: 6, leafLight: "#9bb898", leafDark: "#7a9778",
        },
        {
          x: 460, topY: 260, thickness: 18, lean: 2,
          body: "#a8c2a4", shadow: "#809d7d", highlight: "#c6dac4", joint: "#809d7d",
          leafTilt: -12, leafLight: "#9bb898", leafDark: "#7a9778",
        },
      ]
    : [
        // Front layer - richer green, fuller, taller. The front
        // stalks staircase from the inside-edge upward so the bush
        // reads as "growing toward page center."
        {
          x: 30, topY: 130, thickness: 30, lean: 4,
          body: "#7aa172", shadow: "#56755e", highlight: "#a5c79b", joint: "#56755e",
          leafTilt: -6, leafLight: "#82a87b", leafDark: "#56755e",
        },
        {
          x: 95, topY: 90, thickness: 32, lean: 8,
          body: "#82a87b", shadow: "#5c7d57", highlight: "#a8c79f", joint: "#5c7d57",
          leafTilt: -2, leafLight: "#82a87b", leafDark: "#5c7d57",
        },
        {
          x: 175, topY: 60, thickness: 36, lean: 12,
          body: "#7aa172", shadow: "#56755e", highlight: "#a5c79b", joint: "#56755e",
          leafTilt: 6, leafLight: "#82a87b", leafDark: "#56755e",
        },
        {
          x: 265, topY: 110, thickness: 30, lean: 5,
          body: "#82a87b", shadow: "#5c7d57", highlight: "#a8c79f", joint: "#5c7d57",
          leafTilt: 10, leafLight: "#82a87b", leafDark: "#5c7d57",
        },
        {
          x: 345, topY: 80, thickness: 34, lean: 9,
          body: "#7aa172", shadow: "#56755e", highlight: "#a5c79b", joint: "#56755e",
          leafTilt: -10, leafLight: "#82a87b", leafDark: "#56755e",
        },
        {
          x: 430, topY: 140, thickness: 28, lean: 6,
          body: "#82a87b", shadow: "#5c7d57", highlight: "#a8c79f", joint: "#5c7d57",
          leafTilt: 4, leafLight: "#82a87b", leafDark: "#5c7d57",
        },
        {
          x: 510, topY: 180, thickness: 26, lean: 3,
          body: "#7aa172", shadow: "#56755e", highlight: "#a5c79b", joint: "#56755e",
          leafTilt: -6, leafLight: "#82a87b", leafDark: "#56755e",
        },
      ];

  return (
    <svg
      viewBox="0 0 600 720"
      width="100%"
      height="100%"
      preserveAspectRatio="xMinYEnd meet"
      role="img"
      aria-label={`Bamboo (${variant})`}
    >
      <defs>
        {/* Edge displacement filter - wobbles every outline so the
            cuts read as hand-made paper rather than vector-perfect.
            Stronger seed/freq on the front layer for visual contrast. */}
        <filter
          id={`bamboo-rough-${variant}`}
          x="-5%"
          y="-5%"
          width="110%"
          height="110%"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={variant === "front" ? "0.024" : "0.018"}
            numOctaves="2"
            seed={variant === "front" ? "7" : "3"}
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={variant === "front" ? "3" : "2"}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>

      <g filter={`url(#bamboo-rough-${variant})`}>
        {stalks.map((s, i) => (
          <BambooStalk key={i} s={s} />
        ))}
      </g>
    </svg>
  );
}
