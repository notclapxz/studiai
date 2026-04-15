// Toast.tsx — Sistema de notificaciones de StudiAI usando Sonner
//
// API pública intencionalmente igual a la anterior para no cambiar callers:
//   useToasts() → { addToast, toasts: [], dismissToast }
//   <ToastContainer /> → monta el <Toaster /> de Sonner
//
// addToast() delega a sonner toast() internamente. Los campos `toasts` y
// `dismissToast` se mantienen por compatibilidad pero están vacíos/no-op
// (Sonner gestiona su propia lista internamente).

import { toast, Toaster } from "sonner";

// ─── Types ───────────────────────────────────────────────────────

export type ToastVariant = "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id?: string;
  message: string;
  variant: ToastVariant;
  /** ms. Default 5000. 0 = persistente. */
  duration?: number;
  /** Botón de acción opcional (ej: "Instalar", "Reintentar") */
  action?: ToastAction;
}

// ─── Toaster (montar UNA VEZ en el árbol) ────────────────────────

interface ToastContainerProps {
  /** No usados — mantenidos por compatibilidad */
  toasts?: ToastData[];
  onDismiss?: (id: string) => void;
}

export function ToastContainer(_props: ToastContainerProps) {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        style: {
          background: "var(--bg-surface-active)",
          border: "1px solid var(--border-ui)",
          color: "var(--text-strong)",
          fontFamily: "var(--font-sans)",
          fontSize: "13px",
          borderRadius: "10px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        },
        classNames: {
          // Botón de acción (ej: "Instalar") — usa accent-warm para destacar
          actionButton: "!bg-[var(--accent-warm)] !text-[var(--bg-modal)] !rounded-md !text-xs !font-semibold hover:!opacity-85 !transition-opacity",
          cancelButton: "!bg-transparent !text-[var(--text-weak)] !text-xs",
        },
      }}
    />
  );
}

// ─── Hook: useToasts ─────────────────────────────────────────────
// Mantiene la misma firma que antes para no cambiar ningún caller.

export function useToasts() {
  function addToast(data: Omit<ToastData, "id">) {
    const duration = data.duration === 0 ? Infinity : (data.duration ?? 5000);

    const options: Parameters<typeof toast>[1] = {
      duration,
      ...(data.action && {
        action: {
          label: data.action.label,
          onClick: data.action.onClick,
        },
      }),
    };

    switch (data.variant) {
      case "success":
        toast.success(data.message, options);
        break;
      case "error":
        toast.error(data.message, options);
        break;
      case "warning":
        toast.warning(data.message, options);
        break;
    }
  }

  // toasts y dismissToast son no-op — Sonner gestiona su propio estado
  return {
    toasts: [] as ToastData[],
    addToast,
    dismissToast: (_id: string) => {},
  };
}

export default ToastContainer;
