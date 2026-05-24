"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

interface Toast {
  id: string;
  type: "success" | "error" | "pending";
  message: string;
  txHash?: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => string;
  removeToast: (id: string) => void;
  updateToast: (id: string, updates: Partial<Omit<Toast, "id">>) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  addToast: () => "",
  removeToast: () => {},
  updateToast: () => {},
});

let toastCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `toast-${++toastCounter}`;
    setToasts((prev) => [...prev, { ...toast, id }]);

    // Auto-remove non-pending toasts after 5s
    if (toast.type !== "pending") {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    }

    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateToast = useCallback(
    (id: string, updates: Partial<Omit<Toast, "id">>) => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
      );

      // Auto-remove if updated to non-pending
      if (updates.type && updates.type !== "pending") {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 5000);
      }
    },
    []
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, updateToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

function ToastContainer({
  toasts,
  onRemove,
}: {
  toasts: Toast[];
  onRemove: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg border shadow-lg text-sm flex items-start gap-3 animate-in slide-in-from-right ${
            toast.type === "success"
              ? "bg-background-secondary border-mint/30 text-foreground"
              : toast.type === "error"
                ? "bg-background-secondary border-danger/30 text-foreground"
                : "bg-background-secondary border-border text-foreground"
          }`}
        >
          <span className="shrink-0 mt-0.5">
            {toast.type === "success" && (
              <span className="text-mint">&#10003;</span>
            )}
            {toast.type === "error" && (
              <span className="text-danger">&#10007;</span>
            )}
            {toast.type === "pending" && (
              <span className="inline-block w-4 h-4 border-2 border-border border-t-mint rounded-full animate-spin" />
            )}
          </span>

          <div className="flex-1 min-w-0">
            <p>{toast.message}</p>
            {toast.txHash && (
              <p className="text-xs text-foreground-secondary mt-1 truncate">
                Tx: {toast.txHash.slice(0, 10)}...{toast.txHash.slice(-8)}
              </p>
            )}
          </div>

          <button
            onClick={() => onRemove(toast.id)}
            aria-label="Dismiss notification"
            className="text-foreground-secondary hover:text-foreground shrink-0"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
