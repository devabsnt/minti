"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CopyButtonProps {
  /** Text to copy to the clipboard. */
  value: string;
  /** Optional aria-label override. Default: "Copy". */
  label?: string;
  /** ms to show the "copied" state. */
  flashMs?: number;
  className?: string;
  /** Optional children — replaces the default icon. */
  children?: React.ReactNode;
}

/**
 * Tiny copy-to-clipboard button. Renders a clipboard icon by default;
 * accepts children to render any custom content.
 *
 * Falls back to a hidden <textarea> + execCommand on older browsers
 * (rare, but the clipboard API is gated behind HTTPS so localhost tests
 * occasionally hit this path).
 */
export function CopyButton({
  value,
  label = "Copy",
  flashMs = 1200,
  className = "",
  children,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const handle = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Legacy fallback for non-secure-context browsers.
        const el = document.createElement("textarea");
        el.value = value;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), flashMs);
    } catch {
      // Permission denied / no clipboard — silently swallow. The user
      // sees the unchanged button which is acceptable degradation.
    }
  }, [value, flashMs]);

  return (
    <button
      type="button"
      onClick={handle}
      aria-label={copied ? `${label}: copied!` : label}
      title={copied ? "Copied!" : label}
      className={`inline-flex items-center justify-center text-foreground-secondary hover:text-mint transition-colors ${className}`}
    >
      {children ?? (copied ? <CheckIcon /> : <CopyIcon />)}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3.5 h-3.5"
      aria-hidden
    >
      <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
      <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3.5 h-3.5 text-mint"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
