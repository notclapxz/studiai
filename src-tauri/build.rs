fn main() {
    // La GEMINI_API_KEY ya NO se embebe en el binario: las llamadas a Gemini van
    // por el Cloudflare Worker (cloudflare/gemini-proxy/), que tiene la key
    // server-side. Por eso este build script ya no lee el .env.
    tauri_build::build()
}
