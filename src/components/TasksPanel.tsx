// TasksPanel.tsx — Panel lateral de tareas próximas
// Se abre al hacer click en el ícono de calendario del Rail

import { useMemo } from "react";
import { X, Calendar, Clock } from "lucide-react";
import { useRecentActivity, cleanCourseName } from "../hooks/useCanvasData";
import type { UpcomingAssignment } from "../hooks/useCanvasData";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface TasksPanelProps {
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Agrupa tareas en categorías: HOY, MAÑANA, ESTA SEMANA, MÁS ADELANTE.
 */
function agruparTareas(tareas: UpcomingAssignment[]): {
  label: string;
  items: UpcomingAssignment[];
}[] {
  const ahora = new Date();
  const hoyInicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const mananaInicio = new Date(hoyInicio);
  mananaInicio.setDate(mananaInicio.getDate() + 1);
  const mananaFin = new Date(mananaInicio);
  mananaFin.setDate(mananaFin.getDate() + 1);
  const semanaFin = new Date(hoyInicio);
  semanaFin.setDate(semanaFin.getDate() + 7);

  const hoy: UpcomingAssignment[] = [];
  const manana: UpcomingAssignment[] = [];
  const semana: UpcomingAssignment[] = [];
  const masAdelante: UpcomingAssignment[] = [];

  for (const t of tareas) {
    if (!t.due_at) {
      masAdelante.push(t);
      continue;
    }
    const fecha = new Date(t.due_at);
    if (fecha >= hoyInicio && fecha < mananaInicio) {
      hoy.push(t);
    } else if (fecha >= mananaInicio && fecha < mananaFin) {
      manana.push(t);
    } else if (fecha >= mananaFin && fecha < semanaFin) {
      semana.push(t);
    } else {
      masAdelante.push(t);
    }
  }

  const grupos = [];
  if (hoy.length > 0) grupos.push({ label: "HOY", items: hoy });
  if (manana.length > 0) grupos.push({ label: "MAÑANA", items: manana });
  if (semana.length > 0) grupos.push({ label: "ESTA SEMANA", items: semana });
  if (masAdelante.length > 0) grupos.push({ label: "MÁS ADELANTE", items: masAdelante });
  return grupos;
}

/**
 * Formatea la fecha de una tarea en texto legible en español.
 * Si es hoy/mañana: muestra hora (HH:MM)
 * Si es esta semana: día de la semana abreviado (lun, mar...)
 * Otro: dd/mm
 */
function formatearFechaTarea(isoDate: string | null): string {
  if (!isoDate) return "Sin fecha";
  try {
    const fecha = new Date(isoDate);
    const ahora = new Date();
    const hoyInicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    const diffMs = fecha.getTime() - hoyInicio.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0 || diffDays === 1) {
      // Hora en formato HH:MM
      return fecha.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
    }
    if (diffDays < 7) {
      // Día de la semana abreviado
      return fecha.toLocaleDateString("es-PE", { weekday: "short" }).replace(".", "");
    }
    // Fecha dd/mm
    return fecha.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" });
  } catch {
    return "Sin fecha";
  }
}

/**
 * Determina si una tarea vence pronto (hoy o mañana) para resaltar visualmente.
 */
function esUrgente(isoDate: string | null): boolean {
  if (!isoDate) return false;
  try {
    const fecha = new Date(isoDate);
    const hoyFin = new Date();
    hoyFin.setDate(hoyFin.getDate() + 2);
    hoyFin.setHours(0, 0, 0, 0);
    return fecha < hoyFin;
  } catch {
    return false;
  }
}

// ─── Subcomponente: Ítem de tarea ─────────────────────────────────────────────

interface ItemTareaProps {
  tarea: UpcomingAssignment;
}

function ItemTarea({ tarea }: ItemTareaProps) {
  const urgente = esUrgente(tarea.due_at);
  const fechaTexto = formatearFechaTarea(tarea.due_at);
  // Limpiar nombre del curso — puede venir en formato largo
  const cursoCorto = cleanCourseName(null, tarea.course_name);

  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-md group transition-colors duration-100"
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "var(--bg-surface-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {/* Indicador de urgencia */}
      <div
        className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: urgente ? "var(--accent)" : "var(--text-ghost)",
        }}
      />

      {/* Contenido */}
      <div className="flex-1 min-w-0">
        <p
          className="text-xs leading-snug truncate"
          style={{ color: "var(--text-base)" }}
          title={tarea.title}
        >
          {tarea.title}
        </p>
        <p
          className="text-xs mt-0.5 truncate"
          style={{ color: "var(--text-weak)", fontSize: "11px" }}
          title={cursoCorto}
        >
          {cursoCorto}
          {tarea.points_possible != null && tarea.points_possible > 0
            ? ` · ${tarea.points_possible} pts`
            : ""}
        </p>
      </div>

      {/* Fecha */}
      <span
        className="text-xs shrink-0 font-medium"
        style={{
          color: urgente ? "var(--accent)" : "var(--text-weak)",
          fontSize: "11px",
        }}
      >
        {fechaTexto}
      </span>
    </div>
  );
}

// ─── Subcomponente: Encabezado de grupo ───────────────────────────────────────

function GrupoHeader({ label }: { label: string }) {
  return (
    <div
      className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wider uppercase"
      style={{ color: "var(--text-ghost)", fontSize: "10px" }}
    >
      {label}
    </div>
  );
}

// ─── Componente principal: TasksPanel ─────────────────────────────────────────

export function TasksPanel({ onClose }: TasksPanelProps) {
  const { upcoming, loading } = useRecentActivity();

  const grupos = useMemo(() => agruparTareas(upcoming), [upcoming]);

  return (
    <section
      className="flex flex-col flex-1 min-w-0 overflow-hidden"
      style={{ background: "var(--bg-base)" }}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-5 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--border-base)" }}
      >
        <div className="flex items-center gap-2">
          <Calendar size={16} strokeWidth={1.5} style={{ color: "var(--accent)" }} />
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-strong)" }}
          >
            Proximas tareas
          </h2>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors duration-100 outline-none"
          style={{ color: "var(--text-weak)" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-surface-hover)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-base)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
          }}
          aria-label="Cerrar panel de tareas"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* ── Contenido ──────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div
            className="flex items-center justify-center p-8"
            style={{ color: "var(--text-weak)" }}
          >
            <span className="text-sm">Cargando tareas...</span>
          </div>
        ) : grupos.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 gap-3 text-center">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border-base)" }}
            >
              <Clock size={20} strokeWidth={1} style={{ color: "var(--text-ghost)" }} />
            </div>
            <div>
              <p
                className="text-sm font-medium mb-0.5"
                style={{ color: "var(--text-base)" }}
              >
                Sin tareas proximas
              </p>
              <p className="text-xs" style={{ color: "var(--text-weak)" }}>
                Aqui apareceran las entregas con fecha limite
              </p>
            </div>
          </div>
        ) : (
          <div className="pb-4">
            {grupos.map((grupo) => (
              <div key={grupo.label}>
                <GrupoHeader label={grupo.label} />
                {grupo.items.map((tarea) => (
                  <ItemTarea key={tarea.id} tarea={tarea} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default TasksPanel;
