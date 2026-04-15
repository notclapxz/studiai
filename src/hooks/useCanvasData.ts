// useCanvasData.ts — Hooks para acceder a datos reales desde SQLite via tauri-plugin-sql
// Reemplaza los datos mock en MainLayout.tsx con queries a la base de datos local.

import { useState, useEffect, useCallback } from "react";
import Database from "@tauri-apps/plugin-sql";

// ─── Helpers de limpieza ──────────────────────────────────────────────────────

/**
 * Extrae el nombre legible de un curso desde el campo `code` o `name` de la DB.
 * - code: "LENGUAJE Y COMUNICACIÓN I - (325178)" → "LENGUAJE Y COMUNICACIÓN I"
 * - name: "325178 - LENGUAJE Y COMUNICACIÓN I - 2025-02 - FC-PREPSC01E01NE1" → "LENGUAJE Y COMUNICACIÓN I"
 */
export function cleanCourseName(code: string | null, name: string): string {
  // Intentar extraer desde code: "MATEMÁTICA - (332498)" → "MATEMÁTICA"
  if (code) {
    const match = code.match(/^(.+?)\s*-\s*\(\d+\)/)
    if (match) return match[1].trim()
    // fallback: usar todo lo que hay antes de " - ("
    const clean = code.split(' - (')[0].trim()
    if (clean.length > 2) return clean
  }
  // Fallback desde name: "332498 - MATEMÁTICA - 2026-01 - FC-..." → "MATEMÁTICA"
  const nameMatch = name.match(/^\d+\s*-\s*(.+?)\s*-\s*\d{4}-\d{2}/)
  if (nameMatch) return nameMatch[1].trim()
  return name
}

/**
 * Extrae el código de semestre legible desde el campo `semester` de la DB.
 * - "1 - USIL - CARRERAS UNIVERSITARIAS - 2026-01" → "2026-01"
 */
export function extractSemester(semester: string | null): string | null {
  if (!semester) return null
  const match = semester.match(/(\d{4}-\d{2})/)
  return match ? match[1] : semester
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CursoDb {
  /** ID numérico en la base de datos local */
  id: number;
  /** ID de Canvas (puede diferir del id local) */
  canvas_id: number;
  name: string;
  code: string | null;
  /** Nombre del semestre/ciclo (ej: "2024-I") */
  semester: string | null;
  synced_at: string | null;
}

export interface Assignment {
  id: number;
  course_id: number;
  canvas_id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  points_possible: number | null;
  submitted: number; // 0 = no, 1 = sí
  score: number | null;
  grade: string | null;
  workflow_state: string | null;
  created_at: string;
}

export interface Document {
  id: number;
  course_id: number;
  canvas_file_id: number | null;
  title: string;
  file_path: string | null;
  file_type: string | null;
  /** URL de descarga directa desde Canvas (guardada en el sync) */
  download_url: string | null;
  content_text: string | null;
  has_embeddings: number;
  synced_at: string | null;
  created_at: string;
}

export interface Announcement {
  id: number;
  course_id: number;
  canvas_id: number;
  title: string;
  content: string | null;
  posted_at: string | null;
  seen: number;
  created_at: string;
}

export interface UpcomingAssignment extends Assignment {
  /** Nombre del curso al que pertenece esta tarea */
  course_name: string;
}

// ─── Hook: useCourses ─────────────────────────────────────────────────────────

interface UseCoursesResult {
  courses: CursoDb[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Carga todos los cursos sincronizados desde Canvas.
 * Retorna loading=true mientras se consulta SQLite.
 * Si la tabla está vacía, courses=[] (sin error).
 */
export function useCourses(): UseCoursesResult {
  const [courses, setCourses] = useState<CursoDb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchCourses() {
      setLoading(true);
      setError(null);

      try {
        const db = await Database.load("sqlite:studyai.db");
        // Solo traer cursos del semestre más reciente (evita mezclar 2025-02 con 2026-01)
        // Detectar cursos activos de forma flexible:
        // USIL usa "2026-01" / "2025-02" — UTEC usa "SEDE BARRANCO - 2026 - 1"
        // Estrategia: filtrar cursos cuyo semester contenga un año 20XX,
        // agrupar por año más alto detectado, mostrar todos los de ese año.
        // Fallback: si no hay ninguno con año, mostrar todos los cursos.
        const rows = await db.select<CursoDb[]>(
          `WITH all_courses AS (
            SELECT id, canvas_id, name, code, semester, synced_at
            FROM courses
            WHERE semester IS NOT NULL AND semester != '' AND semester != 'Período predeterminado'
          ),
          with_year AS (
            SELECT *,
              CAST(
                CASE
                  -- Formato USIL: "2026-01" → extrae "2026"
                  WHEN semester GLOB '20[0-9][0-9]-*' THEN substr(semester, 1, 4)
                  -- Formato UTEC: "SEDE BARRANCO - 2026 - 1" → busca primer 20XX
                  WHEN semester LIKE '%20__-%' THEN
                    substr(semester, instr(semester, '20'), 4)
                  WHEN semester LIKE '%20__ %' THEN
                    substr(semester, instr(semester, '20'), 4)
                  ELSE '0'
                END
              AS INTEGER) as year
            FROM all_courses
          ),
          max_year AS (
            SELECT MAX(year) as top_year FROM with_year WHERE year > 2000
          )
          SELECT w.id, w.canvas_id, w.name, w.code, w.semester, w.synced_at
          FROM with_year w, max_year
          WHERE w.year = max_year.top_year OR (max_year.top_year IS NULL AND w.year = 0)
          ORDER BY w.name`
        );

        if (!cancelled) {
          setCourses(rows);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useCourses] Error al consultar cursos:", message);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchCourses();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { courses, loading, error, refetch };
}

// ─── Hook: useCourseDetail ────────────────────────────────────────────────────

interface UseCourseDetailResult {
  assignments: Assignment[];
  documents: Document[];
  announcements: Announcement[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Carga el detalle de un curso: tareas, documentos y anuncios.
 * Ejecuta las 3 queries en paralelo para mayor velocidad.
 * Si courseId es null, retorna arrays vacíos sin hacer queries.
 */
export function useCourseDetail(courseId: number | null): UseCourseDetailResult {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (courseId === null) {
      setAssignments([]);
      setDocuments([]);
      setAnnouncements([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      setError(null);

      try {
        const db = await Database.load("sqlite:studyai.db");

        // Las 3 queries corren en paralelo
        const [assignmentRows, documentRows, announcementRows] = await Promise.all([
          db.select<Assignment[]>(
            "SELECT * FROM assignments WHERE course_id = ? ORDER BY due_at ASC",
            [courseId]
          ),
          db.select<Document[]>(
            // Deduplicar por canvas_file_id (Canvas retorna el mismo archivo desde múltiples módulos).
            // canvas_file_id NULL = documento manual — se agrupa por id propio para no colapsar.
            `SELECT MIN(id) as id, course_id, canvas_file_id, title, file_path, file_type,
                    download_url, content_text, has_embeddings, synced_at, created_at
             FROM documents
             WHERE course_id = ?
             GROUP BY COALESCE(canvas_file_id, id)
             ORDER BY title`,
            [courseId]
          ),
          db.select<Announcement[]>(
            "SELECT * FROM announcements WHERE course_id = ? ORDER BY posted_at DESC LIMIT 10",
            [courseId]
          ),
        ]);

        if (!cancelled) {
          setAssignments(assignmentRows);
          setDocuments(documentRows);
          setAnnouncements(announcementRows);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useCourseDetail] Error al consultar detalle del curso:", message);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchDetail();

    return () => {
      cancelled = true;
    };
  }, [courseId, tick]);

  return { assignments, documents, announcements, loading, error, refetch };
}

// ─── Hook: useRecentActivity ──────────────────────────────────────────────────

interface UseRecentActivityResult {
  upcoming: UpcomingAssignment[];
  loading: boolean;
  error: string | null;
}

/**
 * Carga las próximas 10 entregas con fecha futura, incluyendo nombre del curso.
 * Útil para el panel de "Tareas próximas" del Rail.
 */
export function useRecentActivity(): UseRecentActivityResult {
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchActivity() {
      setLoading(true);
      setError(null);

      try {
        const db = await Database.load("sqlite:studyai.db");
        const rows = await db.select<UpcomingAssignment[]>(
          `SELECT a.*, c.name as course_name
           FROM assignments a
           JOIN courses c ON a.course_id = c.id
           WHERE a.due_at > datetime('now')
           ORDER BY a.due_at ASC
           LIMIT 10`
        );

        if (!cancelled) {
          setUpcoming(rows);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useRecentActivity] Error al consultar actividad reciente:", message);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchActivity();

    return () => {
      cancelled = true;
    };
  }, []);

  return { upcoming, loading, error };
}

// ─── Hook: useChatSessions ────────────────────────────────────────────────────

export interface ChatSession {
  id: number;
  course_id: number | null;
  title: string | null;
  message_count: number;
  token_count: number;
  created_at: string;
  updated_at: string;
}

interface UseChatSessionsResult {
  sessions: ChatSession[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Carga las sesiones de chat recientes.
 * Opcionalmente filtradas por courseId.
 */
export function useChatSessions(courseId?: number | null): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchSessions() {
      setLoading(true);
      setError(null);

      try {
        const db = await Database.load("sqlite:studyai.db");

        let rows: ChatSession[];

        // Query con columnas de migración 6 (message_count, token_count, updated_at).
        // Si la migración no ha corrido aún, estas columnas no existen y SQLite lanza error.
        // En ese caso, fallback a query básica con valores por defecto.
        const enhancedQuery = courseId !== undefined && courseId !== null
          ? { sql: "SELECT id, course_id, title, COALESCE(message_count, 0) as message_count, COALESCE(token_count, 0) as token_count, created_at, COALESCE(updated_at, created_at) as updated_at FROM chat_sessions WHERE course_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 20", params: [courseId] }
          : { sql: "SELECT id, course_id, title, COALESCE(message_count, 0) as message_count, COALESCE(token_count, 0) as token_count, created_at, COALESCE(updated_at, created_at) as updated_at FROM chat_sessions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 20", params: [] as unknown[] };

        const fallbackQuery = courseId !== undefined && courseId !== null
          ? { sql: "SELECT id, course_id, title, 0 as message_count, 0 as token_count, created_at, created_at as updated_at FROM chat_sessions WHERE course_id = ? ORDER BY created_at DESC LIMIT 20", params: [courseId] }
          : { sql: "SELECT id, course_id, title, 0 as message_count, 0 as token_count, created_at, created_at as updated_at FROM chat_sessions ORDER BY created_at DESC LIMIT 20", params: [] as unknown[] };

        try {
          rows = await db.select<ChatSession[]>(enhancedQuery.sql, enhancedQuery.params);
        } catch {
          // Migration 6 columns don't exist yet — use fallback query without them
          console.warn("[useChatSessions] Columnas de migración 6 no disponibles, usando query básica");
          rows = await db.select<ChatSession[]>(fallbackQuery.sql, fallbackQuery.params);
        }

        if (!cancelled) {
          setSessions(rows);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useChatSessions] Error al consultar sesiones de chat:", message);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchSessions();

    return () => {
      cancelled = true;
    };
  }, [courseId, tick]);

  return { sessions, loading, error, refetch };
}
