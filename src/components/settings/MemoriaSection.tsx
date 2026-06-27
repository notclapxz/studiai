// MemoriaSection.tsx — Transparencia de la memoria del estudiante en SettingsModal
//
// Muestra lo que la IA recuerda del estudiante (perfil + preferencias) y permite
// borrar items o vaciar todo. La memoria es 100% local (nunca sale del equipo).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Brain, Trash2 } from "lucide-react";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface StudentMemory {
  id: number;
  kind: "profile" | "preference";
  content: string;
  mem_key: string | null;
  pinned: boolean;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kindLabel(kind: StudentMemory["kind"]): string {
  return kind === "preference" ? "Preferencia" : "Perfil";
}

function formatWhen(iso: string): string {
  try {
    // El backend guarda en UTC ("YYYY-MM-DD HH:MM:SS"); normalizamos a ISO.
    const date = new Date(iso.replace(" ", "T") + "Z");
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays <= 0) return "hoy";
    if (diffDays === 1) return "ayer";
    if (diffDays < 30) return `hace ${diffDays} días`;
    if (diffDays < 60) return "hace ~1 mes";
    return `hace ~${Math.floor(diffDays / 30)} meses`;
  } catch {
    return "";
  }
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function MemoriaSection() {
  const [memories, setMemories] = useState<StudentMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const rows = await invoke<StudentMemory[]>("get_student_memories");
      setMemories(rows);
    } catch (err: unknown) {
      console.error("Error cargando la memoria del estudiante:", err);
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(id: number) {
    setError(null);
    try {
      await invoke("delete_student_memory", { id });
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err: unknown) {
      console.error("Error borrando memoria:", err);
      setError("No se pudo borrar. Inténtalo de nuevo.");
      load(); // resincroniza el estado optimista con el backend
    }
  }

  async function handleClearAll() {
    setError(null);
    try {
      await invoke("clear_student_memory");
      setMemories([]);
      setConfirmClear(false);
    } catch (err: unknown) {
      console.error("Error vaciando la memoria:", err);
      setError("No se pudo vaciar la memoria. Inténtalo de nuevo.");
      setConfirmClear(false);
    }
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Encabezado + explicación */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Brain size={15} strokeWidth={1.5} style={{ color: "var(--accent-warm)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
            Lo que el asistente recuerda de ti
          </p>
        </div>
        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Para personalizar sus respuestas, el asistente guarda algunos datos durables
          sobre ti (tu contexto académico y cómo prefieres que te responda). Todo se
          queda en este equipo, nunca se envía a ningún servidor. Puedes borrar lo que
          quieras cuando quieras.
        </p>
      </div>

      {/* Banner de error */}
      {error && (
        <div
          className="text-xs rounded-lg px-3 py-2"
          style={{ background: "var(--bg-modal-nav)", color: "var(--danger, #e5484d)" }}
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <p className="text-xs" style={{ color: "var(--text-weak)" }}>
          Cargando...
        </p>
      ) : memories.length === 0 ? (
        <div
          className="text-xs rounded-lg px-3 py-4 text-center"
          style={{ background: "var(--bg-modal-nav)", color: "var(--text-muted)" }}
        >
          El asistente todavía no ha guardado nada sobre ti. A medida que converses, irá
          recordando tus preferencias y tu contexto.
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5"
              style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{
                      background: "var(--bg-modal-nav)",
                      color: m.kind === "preference" ? "var(--accent-warm)" : "var(--text-muted)",
                    }}
                  >
                    {kindLabel(m.kind)}
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--text-weak)" }}>
                    {formatWhen(m.updated_at)}
                  </span>
                </div>
                <p className="text-[13px] leading-snug break-words" style={{ color: "var(--text-strong)" }}>
                  {m.content}
                </p>
              </div>
              <button
                onClick={() => handleDelete(m.id)}
                className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-100"
                style={{ color: "var(--text-weak)" }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "var(--border-base)";
                  (e.currentTarget as HTMLElement).style.color = "var(--danger, #e5484d)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                  (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
                }}
                aria-label="Borrar este recuerdo"
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Vaciar todo */}
      {memories.length > 0 && (
        <div className="pt-1">
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleClearAll}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-150"
                style={{ background: "var(--danger, #e5484d)", color: "#fff" }}
              >
                Sí, olvidar todo
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-150"
                style={{ background: "var(--border-ui)", color: "var(--text-strong)" }}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full py-2 rounded-lg text-sm font-medium transition-all duration-150"
              style={{ background: "transparent", border: "1px solid var(--border-ui)", color: "var(--text-muted)" }}
            >
              Olvidar todo lo que sabe de mí
            </button>
          )}
        </div>
      )}
    </div>
  );
}
