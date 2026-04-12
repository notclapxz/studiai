# StudiAI

Asistente de IA para estudiantes universitarios peruanos. Se conecta a tu Canvas institucional, indexa tus materiales y te permite hacer preguntas, generar flashcards, revisar tareas y más — todo desde una app de escritorio.

> Actualmente en beta para estudiantes de **USIL**.

---

## ¿Qué hace?

- 💬 **Chat con IA** sobre tus cursos, archivos y tareas
- 📚 **Sincronización automática con Canvas** — tareas, archivos, anuncios
- 🔍 **Búsqueda inteligente** en tus materiales de estudio
- 🃏 **Flashcards generadas por IA**
- 📅 **Calendario y deadlines** integrados
- 📄 **Soporte de PDFs** (incluyendo escaneados con OCR)
- 🌐 **Búsqueda web** desde el chat

---

## Requisitos

- macOS (Apple Silicon o Intel)
- Cuenta institucional con acceso a Canvas (USIL)
- Conexión a internet

---

## Instalación

### 1. Descargar

Ve a [Releases](../../releases) y descarga el archivo `.dmg` más reciente.

### 2. Instalar

Abre el `.dmg` y arrastra `studyai.app` a tu carpeta **Aplicaciones**.

### 3. Bypass de seguridad de macOS

Como la app no está firmada con Apple Developer ($99/año), macOS la bloqueará la primera vez. Dos opciones:

**Opción A — Clic derecho:**
1. Clic derecho sobre `studyai.app` en Aplicaciones
2. Selecciona **Abrir**
3. En el diálogo, haz clic en **Abrir** nuevamente

**Opción B — Terminal:**
```bash
xattr -cr /Applications/studyai.app
```
Luego abre la app normalmente.

---

## Configuración inicial

1. Inicia sesión con tu **cuenta Google** institucional
2. Ve a **Ajustes → Canvas**
3. Ingresa la URL de tu Canvas: `https://canvas.usil.edu.pe`
4. Genera un token de acceso en Canvas:
   - Canvas → Cuenta → Configuración → **Tokens de acceso** → Nuevo token
5. Pega el token en la app y haz clic en **Verificar y guardar**
6. La sincronización inicial toma 1-3 minutos

---

## Planes

| Plan | Precio | Duración |
|------|--------|----------|
| Trial | Gratis | 14 días |
| Mensual | S/.29 | 30 días |
| Trimestral | S/.75 | 90 días |

---

## Stack técnico

- [Tauri 2](https://tauri.app) + Rust
- React 19 + TypeScript + Vite
- Tailwind CSS 4
- Supabase (auth + BD)
- Gemini API (IA)
- SQLite local (offline)

---

## Créditos

Desarrollado por **Clapxz** — [clapxz.com](https://clapxz.com)

Para soporte o consultas visita [clapxz.com](https://clapxz.com).
