import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("settings copy de razonamiento no expone proveedor/modelo", () => {
  const settingsPath = path.join(root, "src", "components", "settings", "CuentaSection.tsx");
  const content = fs.readFileSync(settingsPath, "utf8");

  assert.ok(
    content.includes("Mostrar razonamiento del asistente"),
    "El ajuste debe usar copy genérico de asistente"
  );

  assert.ok(
    !content.includes("Gemini 2.5 Flash"),
    "No debe haber mención visible al proveedor/modelo"
  );
});

test("vite config define límite de warning acorde al bundle desktop", () => {
  const vitePath = path.join(root, "vite.config.ts");
  const content = fs.readFileSync(vitePath, "utf8");

  assert.ok(
    content.includes("chunkSizeWarningLimit: 1100"),
    "Debe estar documentado un umbral explícito de chunk warning"
  );
});
