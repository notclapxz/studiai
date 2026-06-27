# Changelog

Notas de cada versión publicada de StudiAI. El workflow de release
(`.github/workflows/release.yml`) usa la sección `## vX.Y.Z` correspondiente al
tag como cuerpo del GitHub Release y como notas del auto-updater (`latest.json`).
Para publicar: agrega aquí la sección de la nueva versión, haz commit, y pushea el
tag `vX.Y.Z`.

## v0.14.0

### 🧠 Memoria del estudiante (nuevo)
- El asistente ahora recuerda datos durables tuyos —cómo prefieres las respuestas
  (más cortas, sin analogías…) y tu contexto académico (universidad, escala de
  notas, curso del ciclo)— y los usa para personalizar futuras conversaciones, sin
  que tengas que repetirlos.
- Todo se queda en tu equipo: privado, nunca se envía a ningún servidor.
- Nueva sección **Configuración → Memoria**: mira lo que el asistente recuerda de
  ti y borra lo que quieras (o todo).

### 🛡️ Chat más estable
- Corregido el caso en que el chat se quedaba colgado sin mostrar error: una
  herramienta lenta ya no congela la conversación y hay un límite de seguridad.
- Búsqueda web más confiable: reintenta cuando el buscador responde con límite de
  tasa en vez de quedarse sin resultados.

### 💬 Respuestas más naturales
- Motor de respuestas afinado: más al grano por defecto, lenguaje más natural, y
  mejor criterio sobre cuándo explicar y cuándo responder directo.

## v0.13.0

### 🔄 Progreso de actualización visible
- Al instalar una actualización ya no desaparece la pantalla sin aviso.
- Overlay con barra de progreso de descarga (porcentaje real), fase de instalación
  y fase de reinicio.

### 🎨 Diseño renovado
- Sistema de tokens de color unificado en toda la app.
- Nueva fuente **Geist** para mejor legibilidad.
- Notificaciones rediseñadas con animaciones nativas.

### 📁 Control sobre tus archivos
- Al sincronizar por primera vez puedes elegir dónde guardar tus materiales:
  **Solo base de datos** (recomendado) o **Carpeta local** con el path que elijas.
- Puedes cambiar esta preferencia en Configuración → Canvas.

### 🧹 Limpieza automática de duplicados
- Los archivos duplicados de Canvas (ej: "matemáticas (1).pdf") se eliminan al
  sincronizar, junto con archivos obsoletos que ya no existen en Canvas.

### 👤 Cambio de cuenta Canvas
- Si conectas una cuenta diferente, los archivos del usuario anterior se limpian
  automáticamente. Si solo renuevas el token (misma cuenta), no se borra nada.

### 🐛 Fixes
- Corregido error "FOREIGN KEY constraint failed" al cambiar de cuenta Canvas.
- Corregido orden de borrado de tablas en limpieza de usuario anterior.
