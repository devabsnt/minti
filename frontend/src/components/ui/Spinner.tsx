export function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-10 h-10",
  };

  return (
    <div
      role="status"
      aria-label="Loading"
      className={`${sizeClasses[size]} border-2 border-border border-t-mint rounded-full animate-spin`}
    />
  );
}
