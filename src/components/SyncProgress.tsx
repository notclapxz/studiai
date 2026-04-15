// SyncProgress.tsx — Componente de progreso para la sincronización de Canvas
// Se muestra en Settings.tsx después de verificar exitosamente las credenciales

import { useRef } from "react";
import { CheckCircle, Loader2, AlertCircle, BookOpen, Library, ClipboardList, FolderOpen } from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SyncStats {
  courses: number;
  assignments: number;
  announcements: number;
  files_auto: number;
  files_skipped: number;
  mb_downloaded: number;
}

export type SyncPhase = "idle" | "verifying" | "syncing" | "done" | "error";

export interface SyncProgress {
  phase: SyncPhase;
  label: string;          // texto actual ("Cargando tareas...")
  percent: number;        // 0-100
  completedSteps: string[]; // ["✓ 5 cursos", "✓ 23 tareas"]
  stats?: SyncStats;
  error?: string;
}

// Eventos que emite el sidecar Python via "canvas-sync-event"
export type SyncEventPayload =
  | { type: "start"; mode: string; incremental: boolean; since?: string }
  | { type: "courses"; data: { id: number; name: string }[] }
  | { type: "progress"; current: number; total: number; label: string }
  | { type: "assignments"; course_id: number; data: unknown[] }
  | { type: "announcements"; course_id: number; data: unknown[] }
  | { type: "files_meta"; course_id: number; data: unknown[] }
  | { type: "file_skipped"; data: { name: string; reason: string } }
  | { type: "done"; stats: SyncStats }
  | { type: "error"; fatal: boolean; message: string }
  | {
      type: "warning";
      code: string;
      message: string;
      course_id?: number;
      file_id?: number;
    }
  | { type: "rate_limited"; retry_after: number }
  | { type: "process_done"; exit_code: number }
  | { type: "cleanup_done"; duplicates_removed: number; orphans_removed: number };

// ─── Props ────────────────────────────────────────────────────────────────────

interface SyncProgressProps {
  progress: SyncProgress;
  userName: string;
  onGoToCourses: () => void;
  onRetry?: () => void;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function SyncProgressPanel({
  progress,
  userName,
  onGoToCourses,
  onRetry,
}: SyncProgressProps) {
  const { phase, label, percent, completedSteps, stats, error } = progress;

  // Sin auto-scroll — el usuario controla el scroll manualmente
  const stepsContainerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-5 animate-fade-in">

      {/* Header — usuario conectado */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-green-950 border border-green-800 flex items-center justify-center shrink-0">
          <CheckCircle className="w-4.5 h-4.5 text-green-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-white">
            Conectado como {userName}
          </p>
          <p className="text-xs text-gray-500">
            {phase === "done"
              ? "Canvas sincronizado"
              : phase === "error"
              ? "Error en sincronización"
              : "Canvas sincronizándose…"}
          </p>
        </div>
      </div>

      {/* Fase de error fatal */}
      {phase === "error" && (
        <div className="flex items-start gap-3 bg-red-950 border border-red-800 rounded-xl p-4">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-red-400 font-medium text-sm">
              Error durante la sincronización
            </p>
            <p className="text-red-300 text-xs mt-1 break-words">{error}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-3 text-xs text-red-400 hover:text-red-300 underline transition-colors"
              >
                Reintentar
              </button>
            )}
          </div>
        </div>
      )}

      {/* Fase de sync en curso */}
      {phase === "syncing" && (
        <div className="space-y-4">
          {/* Barra de progreso */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                {label}
              </span>
              <span className="text-xs text-gray-500 tabular-nums">
                {Math.round(percent)}%
              </span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {/* Pasos completados — con scroll interno, sin mover la página */}
          {completedSteps.length > 0 && (
            <div ref={stepsContainerRef} className="max-h-48 overflow-y-auto pr-1">
              <ul className="space-y-1.5">
                {completedSteps.map((step, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-gray-400">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Fase completada */}
      {phase === "done" && stats && (
        <div className="space-y-4 animate-fade-in">
          {/* Headline */}
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400" />
            <span className="text-sm font-medium text-green-400">
              ¡Todo listo!
            </span>
          </div>

          {/* Stats en una línea */}
          <div className="bg-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <StatChip
                icon={<Library size={14} strokeWidth={1.5} />}
                value={stats.courses}
                label={stats.courses === 1 ? "curso" : "cursos"}
              />
              <Separator />
              <StatChip
                icon={<ClipboardList size={14} strokeWidth={1.5} />}
                value={stats.assignments}
                label="tareas"
              />
              <Separator />
              <StatChip
                icon={<FolderOpen size={14} strokeWidth={1.5} />}
                value={stats.files_auto}
                label="archivos"
              />
            </div>

            {/* Archivos pesados */}
            {stats.files_skipped > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                {stats.files_skipped} archivo
                {stats.files_skipped !== 1 ? "s" : ""} pesado
                {stats.files_skipped !== 1 ? "s" : ""} disponible
                {stats.files_skipped !== 1 ? "s" : ""} para descarga manual
              </p>
            )}
          </div>

          {/* CTA principal */}
          <button
            onClick={onGoToCourses}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <BookOpen className="w-4 h-4" />
            Ver mis cursos
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sub-componentes auxiliares ───────────────────────────────────────────────

function StatChip({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-white">
      <span className="text-gray-400">{icon}</span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-gray-400">{label}</span>
    </span>
  );
}

function Separator() {
  return <span className="text-gray-700 select-none">•</span>;
}

export default SyncProgressPanel;
