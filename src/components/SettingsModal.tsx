// SettingsModal.tsx — Modal overlay de configuracion para StudyAI
// Shell delgado: mantiene estado compartido y renderiza secciones por separado

import { useState, useEffect, useRef } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cn } from "../lib/cn";
import {
  X,
  User,
  BookOpen,
  Info,
  CreditCard,
  Timer,
} from "lucide-react";
import type { SyncProgress, SyncEventPayload } from "./SyncProgress";
import { useAuthStore } from "../store/authStore";
import { CuentaSection } from "./settings/CuentaSection";
import { PlanesSection } from "./settings/PlanesSection";
import { CanvasSection } from "./settings/CanvasSection";
import { ProductividadSection } from "./settings/ProductividadSection";
import { AcercaSection } from "./settings/AcercaSection";

// ─── Tipos internos ──────────────────────────────────────────────────────────

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

type SettingsSection = "cuenta" | "planes" | "canvas" | "productividad" | "acerca";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Persistencia SQLite de eventos de sync ──────────────────────────────────

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

// ─── Props ───────────────────────────────────────────────────────────────────

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Sección inicial a mostrar cuando se abre el modal */
  initialSection?: SettingsSection;
  /** Abre el ChangelogModal desde Acerca de */
  onOpenChangelog?: () => void;
  /** Fuerza la navegación al onboarding desde App.tsx (bypasea checks de cursos) */
  onForceOnboarding?: () => void;
  /** Notifica a App.tsx cuando hay una nueva versión disponible para instalar */
  onUpdateFound?: (version: string, onInstall: (progress: import("../lib/updater").UpdaterProgressCallbacks) => Promise<void>) => void;
  /** Abre el StoragePreferenceModal desde MainLayout para cambiar la preferencia */
  onChangeStoragePreference?: () => void;
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function SettingsModal({ open, onClose, initialSection, onOpenChangelog, onForceOnboarding, onUpdateFound, onChangeStoragePreference }: SettingsModalProps) {
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
  const [userChanged, setUserChanged] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>(INITIAL_SYNC_PROGRESS);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [trustMode, setTrustMode] = useState(true);
  const [showThinkingReasoning, setShowThinkingReasoning] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Estado de configuración de Productividad
  const [pomodoroFocusMinutes, setPomodoroFocusMinutes] = useState(25);
  const [pomodoroBreakMinutes, setPomodoroBreakMinutes] = useState(5);
  const [deadlineNotificationsEnabled, setDeadlineNotificationsEnabled] = useState(true);
  const [deadlineLookaheadHours, setDeadlineLookaheadHours] = useState(24);
  const [isSavingProductivity, setIsSavingProductivity] = useState(false);
  const [productivitySaveOk, setProductivitySaveOk] = useState(false);

  // Versión dinámica de la app
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => setAppVersion("—"));
  }, []);

  // Auth store
  const { user, licenseStatus, daysRemaining } = useAuthStore();

  // Cargar la configuración existente al abrir el modal
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

  // Cerrar con Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  function handleClose() {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 150);
  }

  async function loadExistingSettings() {
    try {
      const db = await Database.load("sqlite:studyai.db");
      const rows = await db.select<{ key: string; value: string }[]>(
        "SELECT key, value FROM settings WHERE key IN ('canvas_url', 'canvas_token', 'last_sync_at', 'trust_mode', 'show_thinking_reasoning', 'pomodoro_focus_minutes', 'pomodoro_break_minutes', 'deadline_notifications_enabled', 'deadline_lookahead_hours')"
      );
      for (const row of rows) {
        if (row.key === "canvas_url") setCanvasUrl(row.value);
        if (row.key === "canvas_token") setCanvasToken(row.value);
        if (row.key === "last_sync_at") setLastSyncAt(row.value);
        if (row.key === "trust_mode") setTrustMode(row.value !== "false");
        if (row.key === "show_thinking_reasoning") setShowThinkingReasoning(row.value === "true");
        if (row.key === "pomodoro_focus_minutes") setPomodoroFocusMinutes(parseInt(row.value, 10) || 25);
        if (row.key === "pomodoro_break_minutes") setPomodoroBreakMinutes(parseInt(row.value, 10) || 5);
        if (row.key === "deadline_notifications_enabled") setDeadlineNotificationsEnabled(row.value !== "false");
        if (row.key === "deadline_lookahead_hours") setDeadlineLookaheadHours(parseInt(row.value, 10) || 24);
      }
    } catch (err: unknown) {
      console.log("No hay configuracion previa:", err);
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
        case "cleanup_done": {
          const cleanupSteps: string[] = [];
          if (payload.duplicates_removed > 0) {
            cleanupSteps.push(
              `${payload.duplicates_removed} duplicado${payload.duplicates_removed !== 1 ? "s" : ""} eliminado${payload.duplicates_removed !== 1 ? "s" : ""}`
            );
          }
          if (payload.orphans_removed > 0) {
            cleanupSteps.push(
              `${payload.orphans_removed} archivo${payload.orphans_removed !== 1 ? "s" : ""} obsoleto${payload.orphans_removed !== 1 ? "s" : ""} eliminado${payload.orphans_removed !== 1 ? "s" : ""}`
            );
          }
          if (cleanupSteps.length === 0) return prev;
          return {
            ...prev,
            completedSteps: [...prev.completedSteps, ...cleanupSteps],
          };
        }
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
    } catch (err: unknown) {
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
    } catch (err: unknown) {
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
    setIsSaving(true);
    setErrorMessage("");
    setUserInfo(null);
    setUserChanged(false);

    try {
      const result = await invoke<{
        ok: boolean;
        user_changed: boolean;
        canvas_user_id: string;
        user: CanvasUserInfo;
      }>("validate_and_save_canvas_token", {
        canvasUrl: canvasUrl.trim(),
        canvasToken: canvasToken.trim(),
      });

      setUserInfo(result.user);
      setVerificationStatus("success");
      if (result.user_changed) {
        setUserChanged(true);
      }
      await startSync(canvasUrl, canvasToken);
    } catch (err: unknown) {
      setVerificationStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleResync() {
    if (!canvasUrl || !canvasToken) return;
    await startSync(canvasUrl, canvasToken, true);
  }

  // Estado derivado
  const isSyncing =
    syncProgress.phase === "syncing" || syncProgress.phase === "done" || syncProgress.phase === "error";
  const hasExistingSync =
    lastSyncAt !== null && verificationStatus === "idle" && syncProgress.phase === "idle";
  const showSyncPanel = isSyncing;

  if (!open) return null;

  // Elementos de navegación por sección
  const sections: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { key: "cuenta", label: "Cuenta", icon: <User size={16} strokeWidth={1.5} /> },
    { key: "planes", label: "Planes", icon: <CreditCard size={16} strokeWidth={1.5} /> },
    { key: "canvas", label: "Canvas", icon: <BookOpen size={16} strokeWidth={1.5} /> },
    { key: "productividad", label: "Productividad", icon: <Timer size={16} strokeWidth={1.5} /> },
    { key: "acerca", label: "Acerca de", icon: <Info size={16} strokeWidth={1.5} /> },
  ];

  // Información del usuario desde Supabase
  const userName = user?.user_metadata?.full_name ?? user?.email ?? "Usuario";
  const userEmail = user?.email ?? "";
  const userAvatar = user?.user_metadata?.avatar_url as string | undefined;

  // Trial progress (14 days total)
  const trialTotalDays = 14;
  const trialUsedDays = trialTotalDays - daysRemaining;
  const trialPercent = Math.min(100, Math.round((trialUsedDays / trialTotalDays) * 100));

  return (
    <div
      className={cn("fixed inset-0 z-50 flex items-center justify-center settings-modal-backdrop", closing && "settings-modal-backdrop-out")}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className={cn("settings-modal-content flex overflow-hidden", closing && "settings-modal-content-out")}
        style={{
          background: "var(--bg-modal)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border-ui)",
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
            background: "var(--bg-modal-nav)",
            borderRight: "1px solid var(--border-ui)",
          }}
        >
          <p
            className="text-[11px] font-semibold uppercase tracking-wider px-2 mb-2"
            style={{ color: "var(--text-weak)" }}
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
                  ? { background: "var(--accent-warm)", color: "var(--bg-modal)" }
                  : { color: "var(--text-strong)" }
              }
              onMouseEnter={(e) => {
                if (activeSection !== s.key) {
                  (e.currentTarget as HTMLElement).style.background = "var(--border-base)";
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
            style={{ borderBottom: "1px solid var(--border-ui)" }}
          >
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
              {sections.find((s) => s.key === activeSection)?.label}
            </h2>
            <button
              onClick={handleClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-100"
              style={{ color: "var(--text-weak)" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--border-base)";
                (e.currentTarget as HTMLElement).style.color = "var(--text-strong)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
              }}
              aria-label="Cerrar configuracion"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeSection === "cuenta" && (
              <CuentaSection
                userName={userName}
                userEmail={userEmail}
                userAvatar={userAvatar}
                licenseStatus={licenseStatus}
                daysRemaining={daysRemaining}
                trialTotalDays={trialTotalDays}
                trialUsedDays={trialUsedDays}
                trialPercent={trialPercent}
                trustMode={trustMode}
                showThinkingReasoning={showThinkingReasoning}
                onTrustModeChange={setTrustMode}
                onShowThinkingReasoningChange={setShowThinkingReasoning}
                onNavigateToPlanes={() => setActiveSection("planes")}
              />
            )}

            {activeSection === "planes" && (
              <PlanesSection
                licenseStatus={licenseStatus}
                daysRemaining={daysRemaining}
                trialTotalDays={trialTotalDays}
                trialUsedDays={trialUsedDays}
                trialPercent={trialPercent}
                user={user}
              />
            )}

            {activeSection === "canvas" && (
              <CanvasSection
                canvasUrl={canvasUrl}
                canvasToken={canvasToken}
                showToken={showToken}
                verificationStatus={verificationStatus}
                userInfo={userInfo}
                errorMessage={errorMessage}
                isSaving={isSaving}
                syncProgress={syncProgress}
                lastSyncAt={lastSyncAt}
                showSyncPanel={showSyncPanel}
                hasExistingSync={hasExistingSync}
                isSyncing={isSyncing}
                userChanged={userChanged}
                onChangeStoragePreference={onChangeStoragePreference}
                onCanvasUrlChange={setCanvasUrl}
                onCanvasTokenChange={setCanvasToken}
                onShowTokenChange={setShowToken}
                onVerifyAndSave={verifyAndSave}
                onResync={handleResync}
                onClose={handleClose}
                normalizeCanvasUrl={normalizeCanvasUrl}
                formatLastSync={formatLastSync}
              />
            )}

            {activeSection === "productividad" && (
              <ProductividadSection
                pomodoroFocusMinutes={pomodoroFocusMinutes}
                pomodoroBreakMinutes={pomodoroBreakMinutes}
                deadlineNotificationsEnabled={deadlineNotificationsEnabled}
                deadlineLookaheadHours={deadlineLookaheadHours}
                isSavingProductivity={isSavingProductivity}
                productivitySaveOk={productivitySaveOk}
                onPomodoroFocusChange={setPomodoroFocusMinutes}
                onPomodoroBreakChange={setPomodoroBreakMinutes}
                onDeadlineNotificationsChange={setDeadlineNotificationsEnabled}
                onDeadlineLookaheadChange={setDeadlineLookaheadHours}
                onSavingChange={setIsSavingProductivity}
                onSaveOkChange={setProductivitySaveOk}
              />
            )}

            {activeSection === "acerca" && (
              <AcercaSection
                appVersion={appVersion}
                onOpenChangelog={onOpenChangelog}
                onClose={handleClose}
                onForceOnboarding={onForceOnboarding}
                onUpdateFound={onUpdateFound}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
