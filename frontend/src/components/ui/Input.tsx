import { type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  suffix?: string;
}

export function Input({ label, suffix, className = "", ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-sm text-foreground-secondary">{label}</label>
      )}
      <div className="relative">
        <input
          className={`w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-secondary/50 focus:border-mint focus:outline-none transition-colors ${suffix ? "pr-12" : ""} ${className}`}
          {...props}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-foreground-secondary">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
