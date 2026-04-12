// SettingsModal.tsx — Modal overlay de configuracion para StudyAI
// Tres secciones: Cuenta, Canvas, Acerca de
// Se renderiza encima de MainLayout con backdrop blur

import { useState, useEffect, useRef, useCallback } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  X,
  User,
  BookOpen,
  Info,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  LogOut,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Clock,
  Sparkles,
} from "lucide-react";
import { SyncProgressPanel } from "./SyncProgress";
import type { SyncProgress, SyncEventPayload } from "./SyncProgress";
import { useAuthStore } from "../store/authStore";
import { supabase } from "../lib/supabase";

// ─── Tipos internos (migrados de Settings.tsx) ──────────────────────────────

interface CanvasCourse {
  id: number;
  name: string;
  code?: string;
  term?: string;
  course_code?: string;
}

interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  due_at?: string | null;
  points_possible?: number | null;
  description?: string | null;
  workflow_state?: string | null;
}

interface CanvasFile {
  id: number;
  course_id: number;
  name?: string;
  filename?: string;
  size_bytes?: number | null;
  content_type?: string | null;
  url?: string | null;
  tier?: string | null;
}

interface CanvasAnnouncement {
  id: number;
  course_id: number;
  title: string;
  message?: string | null;
  posted_at?: string | null;
}

interface CanvasUserInfo {
  name?: string;
  display_name?: string;
  short_name?: string;
  primary_email?: string;
}

type VerificationStatus = "idle" | "loading" | "success" | "error";

type SettingsSection = "cuenta" | "planes" | "canvas" | "acerca";

// ─── Helpers (migrados de Settings.tsx) ─────────────────────────────────────

function normalizeCanvasUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function isRecent(isoTimestamp: string): boolean {
  try {
    const ts = new Date(isoTimestamp).getTime();
    const now = Date.now();
    return now - ts < 48 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function eventToPercent(event: SyncEventPayload, currentPercent: number): number {
  switch (event.type) {
    case "start":
      return 5;
    case "courses":
      return 20;
    case "progress": {
      const { current, total } = event;
      if (total <= 0) return currentPercent;
      return 20 + Math.round((current / total) * 60);
    }
    case "done":
      return 100;
    default:
      return currentPercent;
  }
}

function formatLastSync(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "hace menos de un minuto";
    if (diffMin < 60) return `hace ${diffMin} minuto${diffMin !== 1 ? "s" : ""}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `hace ${diffH} hora${diffH !== 1 ? "s" : ""}`;
    const diffD = Math.floor(diffH / 24);
    return `hace ${diffD} dia${diffD !== 1 ? "s" : ""}`;
  } catch {
    return "hace un momento";
  }
}

const INITIAL_SYNC_PROGRESS: SyncProgress = {
  phase: "idle",
  label: "",
  percent: 0,
  completedSteps: [],
};

// ─── Persistencia SQLite de eventos de sync ─────────────────────────────────

async function persistSyncEvent(
  payload: SyncEventPayload,
  db: Database
): Promise<void> {
  switch (payload.type) {
    case "courses": {
      const courses = payload.data as CanvasCourse[];
      for (const course of courses) {
        await db.execute(
          `INSERT OR IGNORE INTO courses (canvas_id, name, code, semester, synced_at)
           VALUES ($1, $2, $3, $4, datetime('now'))`,
          [
            course.id,
            course.name,
            course.code ?? course.course_code ?? null,
            typeof course.term === "string"
              ? course.term
              : (course.term as { name?: string } | undefined)?.name ?? null,
          ]
        );
      }
      break;
    }

    case "assignments": {
      const assignments = payload.data as CanvasAssignment[];
      const canvasCourseId = (payload as { course_id: number }).course_id;
      const courseRows = await db.select<{ id: number }[]>(
        "SELECT id FROM courses WHERE canvas_id = $1 LIMIT 1",
        [canvasCourseId]
      );
      if (courseRows.length === 0) break;
      const localCourseId = courseRows[0].id;
      for (const assignment of assignments) {
        await db.execute(
          `INSERT OR IGNORE INTO assignments
             (course_id, canvas_id, title, description, due_at, points_possible, workflow_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            localCourseId,
            assignment.id,
            assignment.name,
            assignment.description ?? null,
            assignment.due_at ?? null,
            assignment.points_possible ?? null,
            assignment.workflow_state ?? null,
          ]
        );
      }
      break;
    }

    case "files_meta": {
      const files = payload.data as CanvasFile[];
      const canvasCourseIdFiles = (payload as { course_id: number }).course_id;
      const courseRowsFiles = await db.select<{ id: number }[]>(
        "SELECT id FROM courses WHERE canvas_id = $1 LIMIT 1",
        [canvasCourseIdFiles]
      );
      if (courseRowsFiles.length === 0) break;
      const localCourseIdFiles = courseRowsFiles[0].id;
      for (const file of files) {
        const fileTitle = file.name ?? file.filename ?? `Archivo ${file.id}`;
        const downloadUrl = file.url ?? null;
        await db.execute(
          `INSERT OR IGNORE INTO documents
             (course_id, canvas_file_id, title, file_type, download_url, synced_at)
           VALUES ($1, $2, $3, $4, $5, datetime('now'))`,
          [localCourseIdFiles, file.id, fileTitle, file.content_type ?? null, downloadUrl]
        );
        if (downloadUrl) {
          await db.execute(
            `UPDATE documents SET download_url = $1
             WHERE canvas_file_id = $2 AND download_url IS NULL`,
            [downloadUrl, file.id]
          );
        }
      }
      break;
    }

    case "announcements": {
      const announcements = payload.data as CanvasAnnouncement[];
      const canvasCourseIdAnn = (payload as { course_id: number }).course_id;
      const courseRowsAnn = await db.select<{ id: number }[]>(
        "SELECT id FROM courses WHERE canvas_id = $1 LIMIT 1",
        [canvasCourseIdAnn]
      );
      if (courseRowsAnn.length === 0) break;
      const localCourseIdAnn = courseRowsAnn[0].id;
      for (const ann of announcements) {
        await db.execute(
          `INSERT OR IGNORE INTO announcements
             (course_id, canvas_id, title, content, posted_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [localCourseIdAnn, ann.id, ann.title, ann.message ?? null, ann.posted_at ?? null]
        );
      }
      break;
    }

    default:
      break;
  }
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Sección inicial a mostrar cuando se abre el modal */
  initialSection?: SettingsSection;
}

// ─── Componente principal ───────────────────────────────────────────────────

export function SettingsModal({ open, onClose, initialSection }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection ?? "cuenta");

  // Sincronizar activeSection cuando cambia initialSection al abrir el modal
  useEffect(() => {
    if (open && initialSection) {
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);
  const [closing, setClosing] = useState(false);

  // Canvas form state
  const [canvasUrl, setCanvasUrl] = useState("");
  const [canvasToken, setCanvasToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>("idle");
  const [userInfo, setUserInfo] = useState<CanvasUserInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>(INITIAL_SYNC_PROGRESS);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [trustMode, setTrustMode] = useState(true); // default ON
  // Razonamiento visible del asistente (default OFF).
  // Nota UX: esta preferencia NO debe revelar proveedor/modelo en UI.
  const [showThinkingReasoning, setShowThinkingReasoning] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Auth store
  const { user, licenseStatus, daysRemaining, recoverFingerprint, processPago } = useAuthStore();

  // ── Culqi payment state ────────────────────────────────────────────────────
  const [isPaying, setIsPaying] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<"mensual" | "trimestral" | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // Cargar script Culqi v4 al montar
  useEffect(() => {
    const existing = document.querySelector('script[src="https://checkout.culqi.com/js/v4"]');
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://checkout.culqi.com/js/v4";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  function handlePagar(plan: "mensual" | "trimestral") {
    if (isPaying) return;
    setPaymentError(null);
    setPaymentSuccess(false);

    if (!window.Culqi) {
      setPaymentError("El módulo de pago no está listo. Intenta de nuevo.");
      return;
    }

    setSelectedPlan(plan);

    window.Culqi.publicKey = import.meta.env.VITE_CULQI_PUBLIC_KEY as string;
    window.Culqi.settings({
      title: "StudiAI Pro",
      currency: "PEN",
      description: plan === "mensual" ? "Plan Mensual" : "Plan Trimestral",
      amount: plan === "mensual" ? 2900 : 7500,
      order: "",
    });

    window.culqi = async () => {
      const token = window.Culqi.token;
      if (!token?.id) {
        setPaymentError(window.Culqi.error?.user_message ?? "Error al procesar la tarjeta.");
        return;
      }
      window.Culqi.close();
      setIsPaying(true);
      try {
        const result = await processPago(plan, token.id);
        if (!result.ok) {
          setPaymentError(result.error ?? "Pago fallido. Intenta de nuevo.");
        } else {
          setPaymentSuccess(true);
        }
      } finally {
        setIsPaying(false);
        setSelectedPlan(null);
      }
    };

    window.Culqi.open();
  }

  // Estado del flujo stub "recuperar acceso" (cambio de computadora).
  // Se muestra como mensaje inline debajo del link, auto-ocultandose
  // despues de unos segundos. No es un toast global — es un stub minimo.
  const [recoverState, setRecoverState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleRecoverFingerprint() {
    setRecoverState({ kind: "loading" });
    const result = await recoverFingerprint();
    if (result.ok) {
      setRecoverState({ kind: "ok", message: "Acceso recuperado" });
    } else if (result.reason === "forbidden") {
      setRecoverState({ kind: "error", message: "No autorizado" });
    } else if (result.reason === "fingerprint_in_use") {
      setRecoverState({
        kind: "error",
        message: "Este dispositivo ya esta asociado a otra cuenta",
      });
    } else {
      setRecoverState({
        kind: "error",
        message: "No se pudo recuperar el acceso",
      });
    }
    // Auto-ocultar despues de 5s
    setTimeout(() => setRecoverState({ kind: "idle" }), 5000);
  }

  // Load existing settings on mount
  useEffect(() => {
    if (open) {
      loadExistingSettings();
    }
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [open]);

  // Close with Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 150);
  }, [onClose]);

  async function loadExistingSettings() {
    try {
      const db = await Database.load("sqlite:studyai.db");
      const rows = await db.select<{ key: string; value: string }[]>(
        "SELECT key, value FROM settings WHERE key IN ('canvas_url', 'canvas_token', 'last_sync_at', 'trust_mode', 'show_thinking_reasoning')"
      );
      for (const row of rows) {
        if (row.key === "canvas_url") setCanvasUrl(row.value);
        if (row.key === "canvas_token") setCanvasToken(row.value);
        if (row.key === "last_sync_at") setLastSyncAt(row.value);
        if (row.key === "trust_mode") setTrustMode(row.value !== "false");
        if (row.key === "show_thinking_reasoning") setShowThinkingReasoning(row.value === "true");
      }
    } catch (error) {
      console.log("No hay configuracion previa:", error);
    }
  }

  function handleSyncEvent(payload: SyncEventPayload) {
    setSyncProgress((prev) => {
      const newPercent = eventToPercent(payload, prev.percent);
      switch (payload.type) {
        case "start": {
          const startLabel = payload.incremental
            ? payload.since && isRecent(payload.since)
              ? "Verificando novedades desde ayer..."
              : "Verificando novedades..."
            : "Conectando con Canvas...";
          return { ...prev, phase: "syncing", label: startLabel, percent: newPercent };
        }
        case "courses": {
          const count = payload.data.length;
          return {
            ...prev,
            phase: "syncing",
            label: "Cargando tareas y archivos...",
            percent: newPercent,
            completedSteps: [
              ...prev.completedSteps,
              `${count} curso${count !== 1 ? "s" : ""} encontrado${count !== 1 ? "s" : ""}`,
            ],
          };
        }
        case "progress":
          return { ...prev, phase: "syncing", label: payload.label || prev.label, percent: newPercent };
        case "assignments": {
          const count = payload.data.length;
          if (count === 0) return prev;
          return {
            ...prev,
            completedSteps: [
              ...prev.completedSteps,
              `${count} tarea${count !== 1 ? "s" : ""} cargada${count !== 1 ? "s" : ""}`,
            ],
          };
        }
        case "files_meta": {
          const count = payload.data.length;
          if (count === 0) return prev;
          return {
            ...prev,
            completedSteps: [
              ...prev.completedSteps,
              `${count} archivo${count !== 1 ? "s" : ""} indexado${count !== 1 ? "s" : ""}`,
            ],
          };
        }
        case "done": {
          saveSyncTimestamp();
          return {
            phase: "done",
            label: "Sincronizacion completada!",
            percent: 100,
            completedSteps: prev.completedSteps,
            stats: payload.stats,
          };
        }
        case "error":
          if (payload.fatal) {
            return { ...prev, phase: "error", error: payload.message };
          }
          console.warn("[canvas-sync] Error no fatal:", payload.message);
          return prev;
        case "warning":
          // Advertencia no fatal — sigue el sync pero algo pasó. El toast
          // a nivel UI lo dispara MainLayout a través de su propio listener.
          console.warn(
            `[canvas-sync] Warning (${payload.code}):`,
            payload.message
          );
          return prev;
        case "rate_limited":
          return { ...prev, label: `Rate limited — reintentando en ${payload.retry_after}s...` };
        case "process_done":
          if (prev.phase === "syncing") {
            return {
              ...prev,
              phase: payload.exit_code === 0 ? prev.phase : "error",
              error: payload.exit_code !== 0 ? `El proceso termino con codigo ${payload.exit_code}` : undefined,
            };
          }
          return prev;
        default:
          return prev;
      }
    });
  }

  async function saveSyncTimestamp() {
    try {
      const now = new Date().toISOString();
      const db = await Database.load("sqlite:studyai.db");
      await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sync_at', $1)", [now]);
      setLastSyncAt(now);
    } catch (err) {
      console.error("[Settings] Error guardando timestamp de sync:", err);
    }
  }

  async function startSync(url: string, token: string, force = false) {
    if (!force) {
      try {
        const db = await Database.load("sqlite:studyai.db");
        const rows = await db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM courses");
        if (rows[0]?.count > 0) return;
      } catch {
        // continue
      }
    }

    let since: string | null = null;
    if (!force) {
      try {
        const db = await Database.load("sqlite:studyai.db");
        const settingsRows = await db.select<{ value: string }[]>(
          "SELECT value FROM settings WHERE key = 'last_sync_at' LIMIT 1"
        );
        since = settingsRows[0]?.value ?? null;
      } catch {
        since = null;
      }
    }

    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    setSyncProgress({
      phase: "syncing",
      label: since ? "Verificando novedades..." : "Iniciando sincronizacion...",
      percent: 0,
      completedSteps: [],
    });

    try {
      const db = await Database.load("sqlite:studyai.db");
      const unlisten = await listen<SyncEventPayload>("canvas-sync-event", async (event) => {
        const payload = event.payload;
        handleSyncEvent(payload);
        await persistSyncEvent(payload, db).catch((err: unknown) => {
          console.error("[DB persist]", err);
        });
      });
      unlistenRef.current = unlisten;

      invoke("start_canvas_sync", {
        canvasUrl: `https://${normalizeCanvasUrl(url)}`,
        token: token.trim(),
        modo: "metadata",
        courseId: null,
        since,
      }).catch((err: unknown) => {
        console.error("[canvas-sync] Error al invocar start_canvas_sync:", err);
        setSyncProgress((prev) => ({
          ...prev,
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    } catch (err) {
      console.error("[canvas-sync] Error al suscribir eventos:", err);
      setSyncProgress((prev) => ({
        ...prev,
        phase: "error",
        error: "No se pudo iniciar la sincronizacion",
      }));
    }
  }

  async function verifyAndSave() {
    if (!canvasUrl.trim() || !canvasToken.trim()) {
      setErrorMessage("Por favor completa todos los campos");
      setVerificationStatus("error");
      return;
    }

    setVerificationStatus("loading");
    setErrorMessage("");
    setUserInfo(null);

    try {
      const data = await invoke<CanvasUserInfo>("verify_canvas_token", {
        canvasUrl: canvasUrl.trim(),
        token: canvasToken.trim(),
      });
      setUserInfo(data);
      setVerificationStatus("success");
      await saveToDatabase();
      await startSync(canvasUrl, canvasToken);
    } catch (error) {
      setVerificationStatus("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveToDatabase() {
    setIsSaving(true);
    try {
      const db = await Database.load("sqlite:studyai.db");
      const normalizedUrl = normalizeCanvasUrl(canvasUrl);
      await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('canvas_url', $1)", [normalizedUrl]);
      await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('canvas_token', $1)", [
        canvasToken.trim(),
      ]);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleResync() {
    if (!canvasUrl || !canvasToken) return;
    await startSync(canvasUrl, canvasToken, true);
  }

  async function handleLogout() {
    // Limpiar el cache de licencia ANTES del signOut para evitar que el
    // proximo usuario en el mismo dispositivo vea brevemente el estado
    // de licencia del usuario anterior mientras el check online resuelve.
    // Esto limpia tanto el Zustand store como la tabla settings de SQLite.
    try {
      await useAuthStore.getState().resetLicenseCache();
    } catch (err) {
      console.warn("[Logout] Error limpiando cache de licencia:", err);
    }
    await supabase.auth.signOut();
  }

  // Derived state
  const isSyncing =
    syncProgress.phase === "syncing" || syncProgress.phase === "done" || syncProgress.phase === "error";
  const hasExistingSync =
    lastSyncAt !== null && verificationStatus === "idle" && syncProgress.phase === "idle";
  const showSyncPanel = isSyncing;

  if (!open) return null;

  // Section nav items
  const sections: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { key: "cuenta", label: "Cuenta", icon: <User size={16} strokeWidth={1.5} /> },
    { key: "planes", label: "Planes", icon: <CreditCard size={16} strokeWidth={1.5} /> },
    { key: "canvas", label: "Canvas", icon: <BookOpen size={16} strokeWidth={1.5} /> },
    { key: "acerca", label: "Acerca de", icon: <Info size={16} strokeWidth={1.5} /> },
  ];

  // User info from supabase
  const userName = user?.user_metadata?.full_name ?? user?.email ?? "Usuario";
  const userEmail = user?.email ?? "";
  const userAvatar = user?.user_metadata?.avatar_url as string | undefined;

  // Trial progress (14 days total)
  const trialTotalDays = 14;
  const trialUsedDays = trialTotalDays - daysRemaining;
  const trialPercent = Math.min(100, Math.round((trialUsedDays / trialTotalDays) * 100));

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center settings-modal-backdrop ${closing ? "settings-modal-backdrop-out" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className={`settings-modal-content flex overflow-hidden ${closing ? "settings-modal-content-out" : ""}`}
        style={{
          background: "#212121",
          borderRadius: 16,
          border: "1px solid #4b4c5c",
          maxWidth: 560,
          width: "92vw",
          maxHeight: "80vh",
          minHeight: 400,
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Left sidebar ─────────────────────────────────────── */}
        <nav
          className="flex flex-col shrink-0 py-4 px-2 gap-1"
          style={{
            width: 140,
            background: "#1a1a1a",
            borderRight: "1px solid #4b4c5c",
          }}
        >
          <p
            className="text-[11px] font-semibold uppercase tracking-wider px-2 mb-2"
            style={{ color: "#6a6a6a" }}
          >
            Ajustes
          </p>
          {sections.map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveSection(s.key)}
              className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors duration-100 text-left w-full"
              style={
                activeSection === s.key
                  ? { background: "#fab283", color: "#1a1a1a" }
                  : { color: "#e0e0e0" }
              }
              onMouseEnter={(e) => {
                if (activeSection !== s.key) {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
                }
              }}
              onMouseLeave={(e) => {
                if (activeSection !== s.key) {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        {/* ── Right content area ───────────────────────────────── */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Header with close button */}
          <div
            className="flex items-center justify-between px-5 py-3 shrink-0"
            style={{ borderBottom: "1px solid rgba(75,76,92,0.5)" }}
          >
            <h2 className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
              {sections.find((s) => s.key === activeSection)?.label}
            </h2>
            <button
              onClick={handleClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-100"
              style={{ color: "#6a6a6a" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)";
                (e.currentTarget as HTMLElement).style.color = "#e0e0e0";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = "#6a6a6a";
              }}
              aria-label="Cerrar configuracion"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* ── Cuenta section ─────────────────────────────── */}
            {activeSection === "cuenta" && (
              <div className="space-y-5 animate-fade-in">
                {/* User info */}
                <div className="flex items-center gap-3">
                  {userAvatar ? (
                    <img
                      src={userAvatar}
                      alt={userName}
                      className="w-11 h-11 rounded-full shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div
                      className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-sm font-bold"
                      style={{ background: "#fab283", color: "#1a1a1a" }}
                    >
                      {userName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: "#e0e0e0" }}>
                      {userName}
                    </p>
                    <p className="text-xs truncate" style={{ color: "#6a6a6a" }}>
                      {userEmail}
                    </p>
                  </div>
                </div>

                {/* Plan badge */}
                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                >
                  {licenseStatus === "trial" && (
                    <>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{ background: "rgba(250,178,131,0.15)", color: "#fab283" }}
                        >
                          Trial · {daysRemaining} dia{daysRemaining !== 1 ? "s" : ""} restante{daysRemaining !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {/* Progress bar */}
                      <div>
                        <div
                          className="h-1.5 rounded-full overflow-hidden"
                          style={{ background: "#1a1a1a" }}
                        >
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${trialPercent}%`,
                              background: trialPercent > 75 ? "#e06c75" : "#fab283",
                            }}
                          />
                        </div>
                        <p className="text-[11px] mt-1.5" style={{ color: "#6a6a6a" }}>
                          {trialUsedDays} de {trialTotalDays} dias usados
                        </p>
                      </div>
                    </>
                  )}

                  {licenseStatus === "pro" && (
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: "rgba(127,216,143,0.15)", color: "#7fd88f" }}
                    >
                      Plan Pro
                    </span>
                  )}

                  {licenseStatus === "expired" && (
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: "rgba(224,108,117,0.15)", color: "#e06c75" }}
                    >
                      Trial expirado
                    </span>
                  )}

                  {(licenseStatus === "unknown" || licenseStatus === "loading") && (
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: "rgba(250,178,131,0.15)", color: "#fab283" }}
                    >
                      Verificando licencia...
                    </span>
                  )}

                  {licenseStatus !== "pro" && licenseStatus !== "loading" && (
                    <button
                      onClick={() => setActiveSection("planes")}
                      className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150"
                      style={{ background: "#fab283", color: "#1a1a1a" }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.opacity = "0.85";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.opacity = "1";
                      }}
                    >
                      Ver planes
                    </button>
                  )}
                </div>

                {/* Trust mode toggle */}
                <div
                  className="rounded-xl p-4 space-y-2"
                  style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 mr-3">
                      <p className="text-sm font-medium" style={{ color: "#e0e0e0" }}>
                        Modo confianza
                      </p>
                      <p className="text-[11px] leading-relaxed mt-0.5" style={{ color: "#6a6a6a" }}>
                        Permitir al asistente ejecutar comandos sin confirmacion
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={trustMode}
                      onClick={async () => {
                        const next = !trustMode;
                        setTrustMode(next);
                        try {
                          const db = await Database.load("sqlite:studyai.db");
                          await db.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('trust_mode', $1)",
                            [next ? "true" : "false"]
                          );
                        } catch (err) {
                          console.error("[settings] Error al guardar trust_mode:", err);
                        }
                      }}
                      className="relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none"
                      style={{ background: trustMode ? "#fab283" : "#3a3a3a" }}
                    >
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: trustMode ? "translateX(18px)" : "translateX(3px)" }}
                      />
                    </button>
                  </div>
                  {trustMode && (
                    <p className="text-[11px]" style={{ color: "#fab283" }}>
                      El asistente puede ejecutar comandos en tu terminal
                    </p>
                  )}
                </div>

                {/* Mostrar razonamiento del asistente (toggle) */}
                <div
                  className="rounded-xl p-4 space-y-2"
                  style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 mr-3">
                      <p className="text-sm font-medium" style={{ color: "#e0e0e0" }}>
                        Mostrar razonamiento del asistente
                      </p>
                      <p className="text-[11px] leading-relaxed mt-0.5" style={{ color: "#6a6a6a" }}>
                        Muestra un resumen del proceso interno antes de responder.
                        Este detalle puede aparecer en ingles segun el contenido.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={showThinkingReasoning}
                      onClick={async () => {
                        const next = !showThinkingReasoning;
                        setShowThinkingReasoning(next);
                        try {
                          const db = await Database.load("sqlite:studyai.db");
                          await db.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('show_thinking_reasoning', $1)",
                            [next ? "true" : "false"]
                          );
                        } catch (err) {
                          console.error(
                            "[settings] Error al guardar show_thinking_reasoning:",
                            err
                          );
                        }
                      }}
                      className="relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none"
                      style={{ background: showThinkingReasoning ? "#fab283" : "#3a3a3a" }}
                    >
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200"
                        style={{ transform: showThinkingReasoning ? "translateX(18px)" : "translateX(3px)" }}
                      />
                    </button>
                  </div>
                </div>

                {/* Logout */}
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 text-xs transition-colors duration-150 py-1"
                  style={{ color: "#6a6a6a" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#e06c75";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#6a6a6a";
                  }}
                >
                  <LogOut size={14} strokeWidth={1.5} />
                  Cerrar sesion
                </button>
              </div>
            )}

            {/* ── Planes section ─────────────────────────────── */}
            {activeSection === "planes" && (
              <div className="space-y-4 animate-fade-in">
                {/* Current plan status */}
                <div
                  className="rounded-xl p-4 border"
                  style={{ background: "#252525", borderColor: "#4b4c5c" }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {licenseStatus === "trial" && (
                      <>
                        <Clock size={16} style={{ color: "#fab283" }} />
                        <span className="text-sm font-semibold" style={{ color: "#fab283" }}>
                          Trial activo · {daysRemaining} dias restantes
                        </span>
                      </>
                    )}
                    {licenseStatus === "pro" && (
                      <>
                        <Sparkles size={16} style={{ color: "#7fd88f" }} />
                        <span className="text-sm font-semibold" style={{ color: "#7fd88f" }}>
                          Plan Pro activo
                        </span>
                      </>
                    )}
                    {licenseStatus === "expired" && (
                      <>
                        <Clock size={16} style={{ color: "#e06c75" }} />
                        <span className="text-sm font-semibold" style={{ color: "#e06c75" }}>
                          Trial expirado
                        </span>
                      </>
                    )}
                  </div>
                  {licenseStatus === "trial" && (
                    <>
                      <div
                        className="w-full h-1.5 rounded-full mt-2"
                        style={{ background: "#3a3a3a" }}
                      >
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${trialPercent}%`,
                            background: "#fab283",
                          }}
                        />
                      </div>
                      <p className="text-xs mt-1.5" style={{ color: "#6a6a6a" }}>
                        {trialUsedDays} de {trialTotalDays} dias usados
                      </p>
                    </>
                  )}
                  {licenseStatus === "expired" && (
                    <>
                      <p className="text-xs mt-1" style={{ color: "#6a6a6a" }}>
                        El chat con IA requiere una suscripcion. Tus tareas, calendario y datos de Canvas siguen disponibles.
                      </p>
                      {user && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={handleRecoverFingerprint}
                            disabled={recoverState.kind === "loading"}
                            className="text-xs underline disabled:opacity-50"
                            style={{ color: "#fab283" }}
                          >
                            {recoverState.kind === "loading"
                              ? "Verificando..."
                              : "¿Cambiaste de computadora? Recuperar acceso"}
                          </button>
                          {recoverState.kind === "ok" && (
                            <p
                              className="text-[11px] mt-1"
                              style={{ color: "#7fd88f" }}
                            >
                              {recoverState.message}
                            </p>
                          )}
                          {recoverState.kind === "error" && (
                            <p
                              className="text-[11px] mt-1"
                              style={{ color: "#e06c75" }}
                            >
                              {recoverState.message}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Plan cards */}
                <div className="space-y-3">
                  {/* Monthly plan */}
                  <div
                    className="rounded-xl p-4 border transition-colors duration-150"
                    style={{ background: "#252525", borderColor: "#4b4c5c" }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Clock size={16} style={{ color: "#e0e0e0" }} />
                        <span className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
                          Plan Mensual
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-bold" style={{ color: "#e0e0e0" }}>
                          S/.29
                        </span>
                        <span className="text-xs" style={{ color: "#6a6a6a" }}>
                          {" "}/mes
                        </span>
                      </div>
                    </div>
                    <p className="text-xs mb-3" style={{ color: "#6a6a6a" }}>
                      Chat con IA ilimitado, acceso a todas las funciones
                    </p>
                    <button
                      onClick={() => handlePagar("mensual")}
                      disabled={isPaying}
                      className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
                      style={isPaying ? { background: "#3a3a3a", color: "#6a6a6a", cursor: "not-allowed" } : { background: "#4b4c5c", color: "#e0e0e0", cursor: "pointer" }}
                    >
                      {isPaying && selectedPlan === "mensual" ? (
                        <><Loader2 size={12} className="animate-spin" />Procesando...</>
                      ) : "Suscribirse — S/.29/mes"}
                    </button>
                  </div>

                  {/* Quarterly plan */}
                  <div className="relative">
                    <div
                      className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[10px] font-bold z-10"
                      style={{ background: "#5c9cf5", color: "#121212" }}
                    >
                      Ahorra 14%
                    </div>
                    <div
                      className="rounded-xl p-4 border-2 transition-colors duration-150"
                      style={{ background: "#252525", borderColor: "#5c9cf5" }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <Sparkles size={16} style={{ color: "#5c9cf5" }} />
                          <span className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
                            Plan Trimestral
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-bold" style={{ color: "#e0e0e0" }}>
                            S/.75
                          </span>
                          <span className="text-xs" style={{ color: "#6a6a6a" }}>
                            {" "}/3 meses
                          </span>
                        </div>
                      </div>
                      <p className="text-xs mb-3" style={{ color: "#6a6a6a" }}>
                        Todo del plan mensual + precio preferencial
                      </p>
                      <button
                        onClick={() => handlePagar("trimestral")}
                        disabled={isPaying}
                        className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
                        style={isPaying ? { background: "#3a4a6b", color: "#6a6a6a", cursor: "not-allowed" } : { background: "#5c9cf5", color: "#121212", cursor: "pointer" }}
                      >
                        {isPaying && selectedPlan === "trimestral" ? (
                          <><Loader2 size={12} className="animate-spin" />Procesando...</>
                        ) : "Suscribirse — S/.75/3 meses"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Feedback pago */}
                {paymentError && (
                  <p className="text-xs text-center" style={{ color: "#e06c75" }}>{paymentError}</p>
                )}
                {paymentSuccess && (
                  <p className="text-xs text-center" style={{ color: "#7fd88f" }}>¡Pago exitoso! Tu plan Pro está activo.</p>
                )}

                {/* Features list */}
                <div
                  className="rounded-xl p-4 border"
                  style={{ background: "#252525", borderColor: "#4b4c5c" }}
                >
                  <p className="text-xs font-semibold mb-2" style={{ color: "#e0e0e0" }}>
                    Incluido en todos los planes
                  </p>
                  <ul className="space-y-1.5">
                    {[
                      "Chat con IA ilimitado",
                      "Sincronizacion de Canvas automatica",
                      "Busqueda inteligente en tus materiales",
                      "Flashcards generadas por IA",
                      "Acceso a tareas y calendario",
                    ].map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-xs" style={{ color: "#6a6a6a" }}>
                        <CheckCircle size={12} style={{ color: "#7fd88f" }} />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* ── Canvas section ─────────────────────────────── */}
            {activeSection === "canvas" && (
              <div className="space-y-4 animate-fade-in">
                {/* Sync panel */}
                {showSyncPanel && (
                  <SyncProgressPanel
                    progress={syncProgress}
                    userName={
                      userInfo?.name ??
                      userInfo?.display_name ??
                      userInfo?.short_name ??
                      (canvasUrl ? normalizeCanvasUrl(canvasUrl) : "tu cuenta")
                    }
                    onGoToCourses={handleClose}
                    onRetry={handleResync}
                  />
                )}

                {/* Last sync banner */}
                {hasExistingSync && (
                  <div
                    className="rounded-xl p-3 flex items-center justify-between gap-3"
                    style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                  >
                    <div>
                      <p className="text-xs font-medium" style={{ color: "#e0e0e0" }}>
                        Canvas conectado
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: "#6a6a6a" }}>
                        Ultima sync: {formatLastSync(lastSyncAt!)}
                      </p>
                    </div>
                    <button
                      onClick={handleResync}
                      className="flex items-center gap-1 text-[11px] shrink-0 transition-colors duration-150"
                      style={{ color: "#5c9cf5" }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.opacity = "0.7";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.opacity = "1";
                      }}
                    >
                      <RefreshCw size={12} strokeWidth={1.5} />
                      Re-sincronizar
                    </button>
                  </div>
                )}

                {/* Form */}
                <div className="space-y-3">
                  {/* Canvas URL */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium" style={{ color: "#e0e0e0" }}>
                      URL de Canvas
                    </label>
                    <input
                      type="text"
                      value={canvasUrl}
                      onChange={(e) => setCanvasUrl(e.target.value)}
                      placeholder="usil.instructure.com"
                      className="w-full rounded-lg px-3 py-2 text-xs outline-none transition-colors duration-150"
                      style={{
                        background: "#1a1a1a",
                        border: "1px solid #4b4c5c",
                        color: "#e0e0e0",
                      }}
                      onFocus={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = "#fab283";
                      }}
                      onBlur={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = "#4b4c5c";
                      }}
                    />
                    <p className="text-[11px]" style={{ color: "#6a6a6a" }}>
                      Solo el dominio, sin https:// — ej: <code style={{ color: "#9d7cd8" }}>canvas.upc.edu.pe</code>
                    </p>
                  </div>

                  {/* Token */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium" style={{ color: "#e0e0e0" }}>
                      Token de Acceso Personal
                    </label>
                    <div className="relative">
                      <input
                        type={showToken ? "text" : "password"}
                        value={canvasToken}
                        onChange={(e) => setCanvasToken(e.target.value)}
                        placeholder="Token generado en Canvas"
                        className="w-full rounded-lg px-3 py-2 pr-10 text-xs outline-none transition-colors duration-150 font-mono"
                        style={{
                          background: "#1a1a1a",
                          border: "1px solid #4b4c5c",
                          color: "#e0e0e0",
                        }}
                        onFocus={(e) => {
                          (e.currentTarget as HTMLElement).style.borderColor = "#fab283";
                        }}
                        onBlur={(e) => {
                          (e.currentTarget as HTMLElement).style.borderColor = "#4b4c5c";
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors duration-100"
                        style={{ color: "#6a6a6a" }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.color = "#e0e0e0";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.color = "#6a6a6a";
                        }}
                        aria-label={showToken ? "Ocultar token" : "Mostrar token"}
                      >
                        {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Save button */}
                  <button
                    onClick={verifyAndSave}
                    disabled={verificationStatus === "loading" || isSaving || syncProgress.phase === "syncing"}
                    className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-1.5 disabled:opacity-40"
                    style={{ background: "#5c9cf5", color: "#fff" }}
                    onMouseEnter={(e) => {
                      if (!(e.currentTarget as HTMLButtonElement).disabled) {
                        (e.currentTarget as HTMLElement).style.opacity = "0.85";
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.opacity = "1";
                    }}
                  >
                    {verificationStatus === "loading" || isSaving ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        Verificando...
                      </>
                    ) : (
                      "Guardar y verificar"
                    )}
                  </button>

                  {/* Success message */}
                  {verificationStatus === "success" && userInfo && !isSyncing && (
                    <div
                      className="flex items-start gap-2 rounded-lg p-3"
                      style={{ background: "rgba(127,216,143,0.1)", border: "1px solid rgba(127,216,143,0.25)" }}
                    >
                      <CheckCircle size={14} className="mt-0.5 shrink-0" style={{ color: "#7fd88f" }} />
                      <div>
                        <p className="text-xs font-medium" style={{ color: "#7fd88f" }}>
                          Conectado exitosamente
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: "#7fd88f", opacity: 0.8 }}>
                          {userInfo.name ?? userInfo.display_name ?? userInfo.short_name}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error message */}
                  {verificationStatus === "error" && errorMessage && (
                    <div
                      className="flex items-start gap-2 rounded-lg p-3"
                      style={{ background: "rgba(224,108,117,0.1)", border: "1px solid rgba(224,108,117,0.25)" }}
                    >
                      <XCircle size={14} className="mt-0.5 shrink-0" style={{ color: "#e06c75" }} />
                      <div>
                        <p className="text-xs font-medium" style={{ color: "#e06c75" }}>
                          Error de verificacion
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: "#e06c75", opacity: 0.8 }}>
                          {errorMessage}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Instructions collapsible */}
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                >
                  <button
                    onClick={() => setShowInstructions(!showInstructions)}
                    className="flex items-center justify-between w-full px-3 py-2.5 text-xs font-medium transition-colors duration-100"
                    style={{ color: "#e0e0e0" }}
                  >
                    <span>Como obtener el token de Canvas?</span>
                    {showInstructions ? (
                      <ChevronUp size={14} style={{ color: "#6a6a6a" }} />
                    ) : (
                      <ChevronDown size={14} style={{ color: "#6a6a6a" }} />
                    )}
                  </button>

                  {showInstructions && (
                    <div className="px-3 pb-3 animate-fade-in">
                      <ol className="space-y-1.5 text-[11px]" style={{ color: "#6a6a6a" }}>
                        <li className="flex gap-1.5">
                          <span className="shrink-0" style={{ color: "#4b4c5c" }}>1.</span>
                          <span>
                            Inicia sesion en Canvas y ve a{" "}
                            <strong style={{ color: "#e0e0e0" }}>Cuenta</strong> →{" "}
                            <strong style={{ color: "#e0e0e0" }}>Configuracion</strong>
                          </span>
                        </li>
                        <li className="flex gap-1.5">
                          <span className="shrink-0" style={{ color: "#4b4c5c" }}>2.</span>
                          <span>
                            Busca la seccion{" "}
                            <strong style={{ color: "#e0e0e0" }}>Tokens de Acceso Aprobados</strong>
                          </span>
                        </li>
                        <li className="flex gap-1.5">
                          <span className="shrink-0" style={{ color: "#4b4c5c" }}>3.</span>
                          <span>
                            Haz clic en{" "}
                            <strong style={{ color: "#e0e0e0" }}>+ Nuevo Token de Acceso</strong>
                          </span>
                        </li>
                        <li className="flex gap-1.5">
                          <span className="shrink-0" style={{ color: "#4b4c5c" }}>4.</span>
                          <span>
                            Asigna un proposito (ej: &quot;StudyAI&quot;) y genera el token
                          </span>
                        </li>
                        <li className="flex gap-1.5">
                          <span className="shrink-0" style={{ color: "#4b4c5c" }}>5.</span>
                          <span>Copia el token generado — solo se muestra una vez</span>
                        </li>
                      </ol>

                      {canvasUrl && (
                        <a
                          href={`https://${normalizeCanvasUrl(canvasUrl)}/profile/settings`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] mt-2 transition-colors duration-150"
                          style={{ color: "#5c9cf5" }}
                        >
                          Abrir configuracion de Canvas
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {/* Privacy note */}
                <p className="text-center text-[10px]" style={{ color: "#4b4c5c" }}>
                  Tu token se guarda localmente y nunca se envia a servidores externos
                </p>
              </div>
            )}

            {/* ── Acerca de section ──────────────────────────── */}
            {activeSection === "acerca" && (
              <div className="space-y-5 animate-fade-in">
                {/* App info */}
                <div className="flex items-center gap-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: "rgba(250,178,131,0.15)" }}
                  >
                    <BookOpen size={20} strokeWidth={1.5} style={{ color: "#fab283" }} />
                  </div>
                  <div>
                    <p className="text-sm font-bold" style={{ color: "#e0e0e0" }}>
                      StudyAI
                    </p>
                    <p className="text-xs" style={{ color: "#6a6a6a" }}>
                      Version 0.1.0
                    </p>
                  </div>
                </div>

                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{ background: "#252525", border: "1px solid #4b4c5c" }}
                >
                  <p className="text-xs" style={{ color: "#e0e0e0" }}>
                    Hecho para estudiantes de USIL
                  </p>
                  <p className="text-[11px] leading-relaxed" style={{ color: "#6a6a6a" }}>
                    StudyAI conecta tu cuenta de Canvas para ayudarte a estudiar de forma
                    mas eficiente con inteligencia artificial. Tus datos se almacenan
                    localmente en tu computadora.
                  </p>
                </div>

                {/* Links */}
                <div className="space-y-2">
                  <a
                    href="mailto:feedback@studyai.app"
                    className="flex items-center gap-2 text-xs transition-colors duration-150"
                    style={{ color: "#5c9cf5" }}
                  >
                    <ExternalLink size={13} strokeWidth={1.5} />
                    Enviar feedback
                  </a>
                </div>

                {/* Build info */}
                <p className="text-[10px]" style={{ color: "#4b4c5c" }}>
                  Tauri 2 · React 19 · Rust
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
