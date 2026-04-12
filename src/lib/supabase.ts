// supabase.ts — Cliente de Supabase configurado para StudiAI
// Schema: studiai | Auth: Google OAuth con deep link de Tauri

import { createClient } from "@supabase/supabase-js";

// ─── Constantes de conexión ───────────────────────────────────────────────────

// TODO: Mover a variables de entorno (Vite import.meta.env) en una pasada de hardening.
// Estas son las claves PUBLISHABLE de Supabase — son safe-to-ship por diseño,
// pero centralizarlas en .env facilita rotación y entornos staging/prod.
const SUPABASE_URL = "https://szysukwkumphvltaiwpn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6eXN1a3drdW1waHZsdGFpd3BuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMjM4MTgsImV4cCI6MjA4ODg5OTgxOH0.TmAhkBHh8JBQ9u2kW7Zb4IEgVK_EMuo9ls5P3QN7EEo";

// ─── Cliente de Supabase ──────────────────────────────────────────────────────

/**
 * Cliente principal de Supabase.
 * Se usa db.schema('studiai') para las queries al schema correcto.
 * La auth funciona sobre el schema público por defecto (comportamiento estándar).
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Persistir sesión en localStorage (funciona en Tauri WebView)
    persistSession: true,
    // Detectar el callback automáticamente desde la URL
    detectSessionInUrl: true,
    // Auto refresh del token
    autoRefreshToken: true,
  },
});

// ─── Helper: schema studiai ───────────────────────────────────────────────────

/**
 * Devuelve el cliente apuntando al schema studiai.
 * Usar para todas las queries de datos (no auth).
 * Ejemplo: studiai().from('users').select('*')
 */
export const studiai = () => supabase.schema("studiai");
