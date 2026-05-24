import { type ReactNode } from "react";
import { Spinner } from "../ui/Spinner";

interface NftGridProps {
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
}

export function NftGrid({
  children,
  loading = false,
  empty = false,
  emptyMessage = "No items found",
}: NftGridProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-foreground-secondary">
        <span className="text-4xl mb-3 opacity-30">&#x2205;</span>
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {children}
    </div>
  );
}
