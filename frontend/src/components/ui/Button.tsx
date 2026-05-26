import { type ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const baseClasses =
    "font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";

  // Primary + secondary use the .stamp-button utilities defined in
  // globals.css for the postcard "postage stamp" look (double-frame
  // inset, slight rotation, ink-press shadow). Danger uses a plain
  // bordered look so it doesn't compete with the vermillion accent.
  const variantClasses = {
    primary: "stamp-button",
    secondary: "stamp-button-secondary",
    ghost:
      "text-foreground-secondary hover:text-foreground hover:bg-background-secondary transition-colors",
    danger:
      "border border-danger/40 text-danger hover:bg-danger/10 transition-colors",
  };

  const sizeClasses = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-sm",
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
