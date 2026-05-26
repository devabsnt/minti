"use client";

/**
 * Simple corner bamboo decoration shown on every page except the
 * landing page (which uses the denser CornerBamboo with parallax).
 *
 * One small bamboo clump per side, mirrored on the right via
 * `scaleX(-1)`. No scroll behavior, no animation: static decoration
 * that frames the page edges with a hint of the postcard motif.
 *
 * The clump itself is the same SVG shape used by the landing-page
 * dense version (front-layer style), just rendered as a single
 * piece per side.
 */
export function SideBamboo() {
  return (
    <div className="side-bamboo" aria-hidden>
      <div className="side-bamboo-left">
        <SimpleBambooClump />
      </div>
      <div className="side-bamboo-right">
        <SimpleBambooClump />
      </div>
    </div>
  );
}

function SimpleBambooClump() {
  return (
    <svg
      viewBox="0 0 280 560"
      width="100%"
      height="100%"
      preserveAspectRatio="xMinYEnd meet"
      role="img"
      aria-label="Bamboo decoration"
    >
      <defs>
        <filter
          id="side-bamboo-rough"
          x="-5%"
          y="-5%"
          width="110%"
          height="110%"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.022"
            numOctaves="2"
            seed="11"
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

      <g filter="url(#side-bamboo-rough)">
        {/* Stalk 1: tall, slight right lean */}
        <Stalk x={30} topY={120} thickness={30} lean={6} />
        {/* Stalk 2: medium */}
        <Stalk x={100} topY={180} thickness={28} lean={3} />
        {/* Stalk 3: shorter, more lean */}
        <Stalk x={170} topY={240} thickness={26} lean={10} />
      </g>
    </svg>
  );
}

function Stalk({
  x,
  topY,
  thickness,
  lean,
}: {
  x: number;
  topY: number;
  thickness: number;
  lean: number;
}) {
  const t = thickness;
  const baseY = 560;
  const joints: number[] = [];
  for (let y = topY + 60; y < baseY - 30; y += 80) joints.push(y);
  return (
    <g
      transform={`translate(${x} 0) rotate(${lean} 0 ${baseY})`}
      style={{ transformOrigin: `0 ${baseY}px` }}
    >
      {/* Shadow / back face */}
      <path
        d={`M 1.5 ${baseY} L ${t + 1.5} ${baseY} L ${t + 1.5} ${topY} L 1.5 ${topY} Z`}
        fill="#56755e"
      />
      {/* Front face */}
      <path
        d={`M 0 ${baseY} L ${t} ${baseY} L ${t} ${topY} L 0 ${topY} Z`}
        fill="#82a87b"
      />
      {/* Highlight stripe */}
      <path
        d={`M 1 ${baseY - 6} L ${Math.max(2, t * 0.18)} ${baseY - 6} L ${Math.max(2, t * 0.18)} ${topY + 8} L 1 ${topY + 8} Z`}
        fill="#a8c79f"
        opacity="0.55"
      />
      {/* Joint bands */}
      {joints.map((y, i) => (
        <path
          key={i}
          d={`M -1 ${y} L ${t + 1} ${y} L ${t + 1} ${y + 5} L -1 ${y + 5} Z`}
          fill="#5c7d57"
        />
      ))}
      {/* Top leaf cluster */}
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
