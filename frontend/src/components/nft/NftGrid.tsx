import { type ReactNode } from "react";
import { Spinner } from "../ui/Spinner";

interface NftGridProps {
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  /**
   * Add a tiny per-card rotation so a wall of cards reads as
   * postcards loosely arranged on a desk. The hover state un-rotates
   * to "pick up" the card. Default true since this is part of the
   * postcard aesthetic now. Pass false for grids where rotation
   * would interfere (e.g. selection grids inside modals).
   */
  scatter?: boolean;
}

export function NftGrid({
  children,
  loading = false,
  empty = false,
  emptyMessage = "No items found",
  scatter = true,
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
    <div
      className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5 ${
        scatter ? "scatter-grid" : ""
      }`}
    >
      {children}
    </div>
  );
}
