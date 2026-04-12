fn main() {
    // ── Leer GEMINI_API_KEY del .env en build time ────────────────────────────
    // El .env está en la raíz del proyecto Tauri (un nivel arriba de src-tauri)
    // Esto permite usar env!("GEMINI_API_KEY") en el código Rust sin exponer
    // la key en ningún archivo de código fuente.
    let env_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join(".env"))
        .unwrap_or_else(|| std::path::PathBuf::from(".env"));

    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let line = line.trim();
            // Ignorar comentarios y líneas vacías
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                // Solo pasamos las variables que nos interesan
                if key == "GEMINI_API_KEY" {
                    println!("cargo:rustc-env=GEMINI_API_KEY={}", value);
                }
            }
        }
    }

    tauri_build::build()
}
