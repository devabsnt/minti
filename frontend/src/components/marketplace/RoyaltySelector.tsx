"use client";

import { useState } from "react";

interface RoyaltySelectorProps {
  value: number;
  onChange: (bps: number) => void;
}

const PRESETS = [
  { label: "0%", bps: 0 },
  { label: "2.5%", bps: 250 },
  { label: "5%", bps: 500 },
  { label: "7.5%", bps: 750 },
  { label: "10%", bps: 1000 },
];

export function RoyaltySelector({ value, onChange }: RoyaltySelectorProps) {
  const [custom, setCustom] = useState(false);

  return (
    <div className="space-y-2">
      <label className="text-sm text-foreground-secondary">
        Optional Creator Royalty
      </label>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.bps}
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(preset.bps);
            }}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              !custom && value === preset.bps
                ? "border-mint text-mint bg-mint/10"
                : "border-border text-foreground-secondary hover:border-mint/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustom(true)}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
            custom
              ? "border-mint text-mint bg-mint/10"
              : "border-border text-foreground-secondary hover:border-mint/50"
          }`}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={value / 100}
            onChange={(e) => {
              const pct = parseFloat(e.target.value) || 0;
              onChange(Math.min(5000, Math.max(0, Math.round(pct * 100))));
            }}
            className="w-20 bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:border-mint focus:outline-none"
          />
          <span className="text-sm text-foreground-secondary">%</span>
        </div>
      )}
    </div>
  );
}
