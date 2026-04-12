// Rail.tsx — Columna ultra-fina izquierda (64px)
// Muestra avatares de cursos con color único por nombre, y botones de configuración abajo

import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Calendar, BookOpen } from "lucide-react";
import { useAuthStore } from "../store/authStore";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface Curso {
  id: string;
  nombre: string;
  /** Color de fondo del avatar — se genera automáticamente si no se provee */
  color?: string;
}

interface RailProps {
  cursos: Curso[];
  cursoSeleccionadoId: string | null;
  onSelectCurso: (id: string) => void;
  onOpenSettings: () => void;
  onOpenTareas: () => void;
}

type IndexPhase = "idle" | "processing" | "done";

interface IndexUiState {
  phase: IndexPhase;
  total: number;
  done: number;
  failed: number;
  currentTitle?: string;
  startedAt?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Genera un color de fondo único para un curso basado en su nombre.
 * Usa un hash simple para distribuir colores de forma consistente.
 */
function generarColorCurso(nombre: string): string {
  const colores = [
    "#7c3aed", // violeta
    "#db2777", // rosa
    "#ea580c", // naranja
    "#16a34a", // verde
    "#0891b2", // cyan
    "#d97706", // ámbar
    "#dc2626", // rojo
    "#2563eb", // azul
    "#9333ea", // púrpura
    "#059669", // esmeralda
  ];

  let hash = 0;
  for (let i = 0; i < nombre.length; i++) {
    hash = nombre.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colores[Math.abs(hash) % colores.length];
}

/**
 * Obtiene la(s) inicial(es) del nombre del curso para mostrar en el avatar.
 * Solo usa palabras que comienzan con letra (ignora números y símbolos).
 * Ej: "LENGUAJE Y COMUNICACIÓN I" → "LC"
 * Ej: "MATEMÁTICA" → "MA"
 */
function obtenerIniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/);
  // Filtrar solo palabras que empiezan con letra (incluyendo tildes/ñ)
  const palabrasLetras = palabras.filter((p) => /^[A-ZÁÉÍÓÚÜÑa-záéíóúüñ]/.test(p));

  if (palabrasLetras.length === 0) {
    // Último recurso: extraer el primer carácter letra de todo el string
    const primerLetra = nombre.replace(/[^A-ZÁÉÍÓÚÜÑa-záéíóúüñ]/g, "").charAt(0);
    return primerLetra.toUpperCase() || "?";
  }

  if (palabrasLetras.length === 1) {
    return palabrasLetras[0].slice(0, 2).toUpperCase();
  }

  return palabrasLetras
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

// ─── Hook: useIndexState ──────────────────────────────────────────────────────

function useIndexState(): IndexUiState {
  const [state, setState] = useState<IndexUiState>({
    phase: "idle", total: 0, done: 0, failed: 0,
  });

  useEffect(() => {
    // Estado inicial desde la DB
    invoke<{ total: number; done: number; failed: number; pending: number }>(
      "get_index_status"
    ).then((s) => {
      if (s.pending > 0) {
        setState({ phase: "processing", total: s.total, done: s.done,
                   failed: s.failed, startedAt: Date.now() });
      } else if (s.total > 0 && s.done === s.total) {
        setState({ phase: "idle", total: s.total, done: s.done, failed: s.failed });
      }
    }).catch(console.error);

    // Iniciando un archivo
    const unStarted = listen<{ title: string; total: number; done: number }>(
      "index-bg-started", (e) => {
        setState(prev => ({
          phase: "processing",
          total: e.payload.total,
          done: e.payload.done,
          failed: prev.failed,
          currentTitle: e.payload.title,
          startedAt: prev.startedAt ?? Date.now(),
        }));
      }
    );

    // Progreso
    const unProgress = listen<{ total: number; done: number; failed: number; currentTitle?: string }>(
      "index-bg-progress", (e) => {
        setState(prev => ({
          phase: "processing",
          ...e.payload,
          currentTitle: e.payload.currentTitle,
          startedAt: prev.startedAt ?? Date.now(),
        }));
      }
    );

    // Completado
    const unComplete = listen<{ total: number; done: number; failed: number }>(
      "index-bg-complete", (e) => {
        setState({ phase: "done", ...e.payload });
        setTimeout(() => setState(s => s.phase === "done"
          ? { ...s, phase: "idle" } : s), 4000);
      }
    );

    return () => {
      unStarted.then(f => f());
      unProgress.then(f => f());
      unComplete.then(f => f());
    };
  }, []);

  return state;
}

// ─── Subcomponente: IndexDot ──────────────────────────────────────────────────

function IndexDot({ phase }: { phase: IndexPhase }) {
  if (phase === "idle") return null;

  const color = phase === "done" ? "#16a34a" : "var(--accent)";

  return (
    <span
      className="absolute -top-0.5 -right-0.5 flex items-center justify-center"
      style={{ width: 8, height: 8 }}
    >
      {phase === "processing" && (
        <span
          className="absolute inline-flex rounded-full animate-ping"
          style={{ width: 8, height: 8, background: color, opacity: 0.5 }}
        />
      )}
      <span
        className="relative inline-flex rounded-full transition-colors duration-300"
        style={{ width: 6, height: 6, background: color }}
      />
    </span>
  );
}

// ─── Subcomponente: IndexTooltip ──────────────────────────────────────────────

function IndexTooltip({ state }: { state: IndexUiState }) {
  const elapsed = state.startedAt
    ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;

  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;

  const statusLine = state.phase === "processing"
    ? `Indexando ${state.done}/${state.total} archivos`
    : `${state.total} archivos listos`;

  const subLine = state.phase === "processing"
    ? elapsed > 15
      ? `Procesando archivo... ${elapsed}s`
      : state.currentTitle
        ? `${state.currentTitle.slice(0, 30)}...`
        : "Procesando..."
    : "Busqueda en materiales disponible";

  return (
    <div
      className="absolute left-full ml-3 z-50 px-3 py-2.5 rounded-xl pointer-events-none"
      style={{
        background: "var(--bg-surface-active)",
        border: "1px solid var(--border-base)",
        color: "var(--text-base)",
        minWidth: 200,
        top: "50%",
        transform: "translateY(-50%)",
      }}
    >
      {state.phase === "processing" && state.total > 0 && (
        <div
          className="w-full rounded-full mb-2 overflow-hidden"
          style={{ height: 3, background: "var(--border-base)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.max(5, pct)}%`, background: "var(--accent)" }}
          />
        </div>
      )}
      <p className="text-xs font-medium">{statusLine}</p>
      <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{subLine}</p>
    </div>
  );
}

// ─── Subcomponente: RailProgressBar ──────────────────────────────────────────

function RailProgressBar({ state }: { state: IndexUiState }) {
  if (state.phase === "idle") return null;
  const pct = state.total > 0 ? (state.done / state.total) * 100 : 0;
  const color = state.phase === "done" ? "#16a34a" : "var(--accent)";

  return (
    <div
      className="absolute right-0 top-0 bottom-0 overflow-hidden"
      style={{ width: 2, background: "var(--border-base)", zIndex: 10 }}
    >
      <div
        className="absolute bottom-0 left-0 right-0 transition-all duration-700"
        style={{
          height: state.phase === "processing"
            ? `${Math.max(10, pct)}%` : "100%",
          background: color,
          animation: pct === 0 && state.phase === "processing"
            ? "rail-shimmer 2s ease-in-out infinite" : "none",
        }}
      />
    </div>
  );
}

// ─── Subcomponente: Avatar de curso ──────────────────────────────────────────

interface AvatarCursoProps {
  curso: Curso;
  seleccionado: boolean;
  onClick: () => void;
}

function AvatarCurso({ curso, seleccionado, onClick }: AvatarCursoProps) {
  const [mostrarTooltip, setMostrarTooltip] = useState(false);
  const color = curso.color ?? generarColorCurso(curso.nombre);
  const iniciales = obtenerIniciales(curso.nombre);

  return (
    <div className="relative flex items-center justify-center">
      {/* Indicador de selección (barra izquierda) */}
      <div
        className="absolute left-0 w-0.5 rounded-r-full transition-all duration-200"
        style={{
          height: seleccionado ? "24px" : "0px",
          background: "var(--accent)",
          opacity: seleccionado ? 1 : 0,
        }}
      />

      {/* Avatar circular */}
      <button
        onClick={onClick}
        onMouseEnter={() => setMostrarTooltip(true)}
        onMouseLeave={() => setMostrarTooltip(false)}
        className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white transition-all duration-150 outline-none"
        style={{
          background: color,
          opacity: seleccionado ? 1 : 0.7,
          transform: seleccionado ? "scale(1.05)" : "scale(1)",
          boxShadow: seleccionado
            ? `0 0 0 2px var(--bg-base), 0 0 0 3px ${color}`
            : "none",
        }}
        aria-label={`Seleccionar curso: ${curso.nombre}`}
      >
        {iniciales}
      </button>

      {/* Tooltip con nombre del curso */}
      {mostrarTooltip && (
        <div
          className="absolute left-full ml-3 z-50 px-2.5 py-1.5 rounded-md text-xs whitespace-nowrap pointer-events-none animate-fade-in"
          style={{
            background: "var(--bg-surface-active)",
            border: "1px solid var(--border-base)",
            color: "var(--text-strong)",
          }}
        >
          {curso.nombre}
          {/* Flecha izquierda del tooltip */}
          <div
            className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent"
            style={{ borderRightColor: "var(--bg-surface-active)" }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Subcomponente: Botón de icono ───────────────────────────────────────────

interface IconButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function IconButton({ icon, label, onClick }: IconButtonProps) {
  const [hover, setHover] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-150 outline-none"
      style={{
        background: hover ? "var(--bg-surface-hover)" : "transparent",
        color: hover ? "var(--text-base)" : "var(--text-weak)",
      }}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}

// ─── Componente principal: Rail ───────────────────────────────────────────────

export function Rail({
  cursos,
  cursoSeleccionadoId,
  onSelectCurso,
  onOpenSettings,
  onOpenTareas,
}: RailProps) {
  const [logoHover, setLogoHover] = useState(false);
  const indexState = useIndexState();
  const isIndexActive = indexState.phase !== "idle";
  const { licenseStatus } = useAuthStore();

  return (
    <aside
      className="relative flex flex-col items-center py-3 gap-1 shrink-0"
      style={{
        width: "var(--rail-width, 64px)",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-base)",
      }}
    >
      {/* ── Barra de progreso ambient (borde derecho del Rail) ── */}
      <RailProgressBar state={indexState} />

      {/* ── Logo / ícono de la app con dot indicator ─────────── */}
      <div className="relative mb-2">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: "var(--accent-subtle, rgba(37,99,235,0.15))", color: "var(--accent)" }}
          onMouseEnter={() => isIndexActive && setLogoHover(true)}
          onMouseLeave={() => setLogoHover(false)}
        >
          <BookOpen size={18} strokeWidth={1.5} />
          <IndexDot phase={indexState.phase} />
        </div>
        {logoHover && isIndexActive && <IndexTooltip state={indexState} />}
      </div>

      {/* ── Lista de avatares de cursos ───────────────────── */}
      <div className="flex flex-col gap-2 flex-1 w-full items-center">
        {cursos.map((curso) => (
          <AvatarCurso
            key={curso.id}
            curso={curso}
            seleccionado={cursoSeleccionadoId === curso.id}
            onClick={() => onSelectCurso(curso.id)}
          />
        ))}

        {/* Estado vacío si no hay cursos */}
        {cursos.length === 0 && (
          <div
            className="w-9 h-9 rounded-full border-dashed border-2 flex items-center justify-center text-xs"
            style={{
              borderColor: "var(--border-base)",
              color: "var(--text-ghost)",
            }}
          >
            +
          </div>
        )}
      </div>

      {/* ── Separador ─────────────────────────────────────── */}
      <div
        className="w-8 my-2"
        style={{ height: "1px", background: "var(--border-base)" }}
      />

      {/* ── Botones inferiores ────────────────────────────── */}
      <div className="flex flex-col gap-1 items-center">
        <IconButton
          icon={<Calendar size={18} strokeWidth={1.5} />}
          label="Tareas proximas"
          onClick={onOpenTareas}
        />
        <div className="relative">
          <IconButton
            icon={<Settings size={18} strokeWidth={1.5} />}
            label="Configuracion"
            onClick={onOpenSettings}
          />
          {/* Trial status indicator dot */}
          {licenseStatus !== "loading" && (
            <span
              className="absolute top-0.5 right-0.5 rounded-full pointer-events-none"
              style={{
                width: 7,
                height: 7,
                background:
                  licenseStatus === "pro"
                    ? "#7fd88f"
                    : licenseStatus === "expired"
                      ? "#e06c75"
                      : "#fab283",
                boxShadow:
                  licenseStatus === "pro"
                    ? "0 0 4px rgba(127,216,143,0.5)"
                    : licenseStatus === "expired"
                      ? "0 0 4px rgba(224,108,117,0.5)"
                      : "0 0 4px rgba(250,178,131,0.5)",
              }}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

export default Rail;
