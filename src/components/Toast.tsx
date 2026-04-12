// Toast.tsx — Minimal toast notification system for StudyAI
// Renders fixed-position toasts at the bottom-right of the screen.
// No external dependencies.

import { useState, useEffect, useCallback } from "react";
import { CheckCircle, AlertTriangle, XCircle, X } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToastVariant = "success" | "warning" | "error";

export interface ToastData {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss after this many ms. Default 5000. Set 0 to disable. */
  duration?: number;
}

interface ToastItemProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

// ─── Styling per variant ─────────────────────────────────────────────────────

const variantStyles: Record<ToastVariant, {
  bg: string;
  border: string;
  iconColor: string;
  icon: React.ReactNode;
}> = {
  success: {
    bg: "#252525",
    border: "#4b4c5c",
    iconColor: "#7fd88f",
    icon: <CheckCircle size={16} strokeWidth={2} />,
  },
  warning: {
    bg: "#252525",
    border: "#4b4c5c",
    iconColor: "#fab283",
    icon: <AlertTriangle size={16} strokeWidth={2} />,
  },
  error: {
    bg: "rgba(224,108,117,0.1)",
    border: "#e06c75",
    iconColor: "#e06c75",
    icon: <XCircle size={16} strokeWidth={2} />,
  },
};

// ─── Single Toast ────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true));

    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => onDismiss(toast.id), 300);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.duration, onDismiss]);

  const style = variantStyles[toast.variant];

  return (
    <div
      style={{
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: "#e0e0e0",
        padding: "10px 14px",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        fontWeight: 500,
        maxWidth: 380,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.3s ease, transform 0.3s ease",
        pointerEvents: "auto" as const,
      }}
    >
      <span style={{ color: style.iconColor, flexShrink: 0, display: "flex" }}>
        {style.icon}
      </span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{toast.message}</span>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(toast.id), 300);
        }}
        style={{
          background: "none",
          border: "none",
          color: "#888",
          cursor: "pointer",
          padding: 2,
          display: "flex",
          flexShrink: 0,
        }}
        aria-label="Cerrar"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Toast Container ─────────────────────────────────────────────────────────

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ─── Hook: useToasts ─────────────────────────────────────────────────────────

export function useToasts() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((toast: Omit<ToastData, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}

export default ToastContainer;
