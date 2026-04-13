#!/usr/bin/env bash
set -euo pipefail

# Directorio del proyecto (donde está este script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAURI_CONF="src-tauri/tauri.conf.json"
DMG_DIR="src-tauri/target/release/bundle/dmg"

echo ""
echo "🔍 Leyendo versión del app..."

# Leer versión del tauri.conf.json (intenta con jq, si no usa python3)
if command -v jq &>/dev/null; then
  VERSION=$(jq -r '.version' "$TAURI_CONF")
  APP_NAME=$(jq -r '.productName' "$TAURI_CONF")
else
  VERSION=$(python3 -c "import json; d=json.load(open('$TAURI_CONF')); print(d['version'])")
  APP_NAME=$(python3 -c "import json; d=json.load(open('$TAURI_CONF')); print(d['productName'])")
fi

echo "📦 App: $APP_NAME  |  Versión: $VERSION"
echo ""
echo "🔨 Construyendo DMG con \`npm run tauri build\`..."
echo "   (Esto puede tardar varios minutos)"
echo ""

# Ejecutar el build
if npm run tauri build; then
  echo ""
  echo "✅ Build exitoso"
else
  echo ""
  echo "❌ Build fallido — revisá los errores de arriba"
  exit 1
fi

# Buscar el DMG generado
DMG_FILE=$(find "$DMG_DIR" -name "*.dmg" 2>/dev/null | head -n 1)

if [[ -z "$DMG_FILE" ]]; then
  echo "⚠️  Build completó pero no se encontró ningún .dmg en: $DMG_DIR"
  exit 1
fi

echo ""
echo "📁 DMG generado en:"
echo "   $(realpath "$DMG_FILE")"
echo ""

# Preguntar si abrir en Finder
read -rp "🗂️  ¿Abrir la carpeta del DMG en Finder? [s/N]: " RESP
if [[ "$RESP" =~ ^[sS]$ ]]; then
  open "$SCRIPT_DIR/$DMG_DIR"
  echo "✅ Finder abierto"
fi

echo ""
echo "🎉 Listo. DMG disponible en: $DMG_DIR"
