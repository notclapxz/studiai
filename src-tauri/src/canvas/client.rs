// canvas/client.rs — Cliente HTTP para la API de Canvas LMS con paginación

use reqwest::header::HeaderMap;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tokio::time::sleep;

/// Errores posibles al comunicarse con Canvas
#[derive(Debug)]
pub enum CanvasError {
    /// 401 — Token inválido o expirado
    Unauthorized,
    /// 403 — Acceso prohibido (token sin permisos o expirado)
    Forbidden,
    /// 429 — Rate limited, segundos a esperar
    RateLimited(u64),
    /// 404 — Recurso no encontrado
    NotFound,
    /// Otros errores HTTP con código y cuerpo
    Http(u16, String),
    /// Errores de red/conexión
    Network(String),
}

impl std::fmt::Display for CanvasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CanvasError::Unauthorized => write!(f, "Token inválido o expirado"),
            CanvasError::Forbidden => write!(f, "Acceso prohibido — token sin permisos o expirado"),
            CanvasError::RateLimited(secs) => write!(f, "Rate limited — esperar {}s", secs),
            CanvasError::NotFound => write!(f, "Recurso no encontrado (404)"),
            CanvasError::Http(code, msg) => write!(f, "Error HTTP {}: {}", code, msg),
            CanvasError::Network(msg) => write!(f, "Error de red: {}", msg),
        }
    }
}

/// Cliente HTTP para la API de Canvas LMS
pub struct CanvasClient {
    client: reqwest::Client,
    /// Base URL normalizada, ej. "https://usil.instructure.com"
    pub base_url: String,
    token: String,
}

impl CanvasClient {
    /// Crea un nuevo CanvasClient.
    /// Acepta URL con o sin protocolo "https://".
    pub fn new(canvas_url: &str, token: &str) -> Result<Self, String> {
        let base = canvas_url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');

        let base_url = format!("https://{}", base);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("StudyAI/2.0")
            .build()
            .map_err(|e| format!("Error al crear cliente HTTP: {e}"))?;

        Ok(Self {
            client,
            base_url,
            token: token.to_string(),
        })
    }

    /// GET simple — retorna un único objeto deserializado
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
    ) -> Result<T, CanvasError> {
        // Throttling: 200ms entre requests
        sleep(Duration::from_millis(200)).await;

        let url = if path.starts_with("https://") || path.starts_with("http://") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/json")
            .query(params)
            .send()
            .await
            .map_err(|e| CanvasError::Network(e.to_string()))?;

        self.handle_response::<T>(resp).await
    }

    /// GET paginado — sigue header Link rel="next" hasta agotar todas las páginas
    pub async fn get_paginated<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
    ) -> Result<Vec<T>, CanvasError> {
        let mut results: Vec<T> = Vec::new();

        // Primera URL — construir desde path
        let first_url = if path.starts_with("https://") || path.starts_with("http://") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        let mut current_url: Option<String> = Some(first_url);
        let mut first_request = true;

        while let Some(url) = current_url.take() {
            // Throttling: 200ms entre requests
            sleep(Duration::from_millis(200)).await;

            let req = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", self.token))
                .header("Accept", "application/json");

            // Solo la primera request lleva los params de query
            let req = if first_request {
                req.query(params)
            } else {
                req
            };
            first_request = false;

            let resp = req
                .send()
                .await
                .map_err(|e| CanvasError::Network(e.to_string()))?;

            // Manejar 429 con retry automático
            if resp.status() == 429 {
                let retry_after = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(30);
                return Err(CanvasError::RateLimited(retry_after));
            }

            let next_url = extract_next_url_from_headers(resp.headers());

            let items: Vec<T> = self.parse_response_body(resp).await?;
            results.extend(items);

            current_url = next_url;
        }

        Ok(results)
    }

        /// GET raw stream — para descargas de archivos (streaming)
    pub async fn get_raw_stream(
        &self,
        url: &str,
    ) -> Result<impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>, CanvasError>
    {
        sleep(Duration::from_millis(200)).await;

        let resp = self
            .client
            .get(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| CanvasError::Network(e.to_string()))?;

        match resp.status().as_u16() {
            200..=299 => Ok(resp.bytes_stream()),
            401 => Err(CanvasError::Unauthorized),
            403 => Err(CanvasError::Forbidden),
            code => {
                let msg = resp.text().await.unwrap_or_default();
                Err(CanvasError::Http(code, msg))
            }
        }
    }

    /// Maneja una respuesta HTTP: verifica el status y deserializa
    async fn handle_response<T: DeserializeOwned>(
        &self,
        resp: reqwest::Response,
    ) -> Result<T, CanvasError> {
        match resp.status().as_u16() {
            200..=299 => {
                let body = resp
                    .json::<T>()
                    .await
                    .map_err(|e| CanvasError::Network(format!("Error al parsear JSON: {e}")))?;
                Ok(body)
            }
            401 => Err(CanvasError::Unauthorized),
            403 => Err(CanvasError::Forbidden),
            404 => Err(CanvasError::NotFound),
            429 => {
                let retry_after = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(30);
                Err(CanvasError::RateLimited(retry_after))
            }
            code => {
                let msg = resp.text().await.unwrap_or_default();
                Err(CanvasError::Http(code, msg))
            }
        }
    }

    /// Parsea el cuerpo de una respuesta como Vec<T>
    async fn parse_response_body<T: DeserializeOwned>(
        &self,
        resp: reqwest::Response,
    ) -> Result<Vec<T>, CanvasError> {
        match resp.status().as_u16() {
            200..=299 => {
                let body = resp
                    .json::<Vec<T>>()
                    .await
                    .map_err(|e| CanvasError::Network(format!("Error al parsear JSON: {e}")))?;
                Ok(body)
            }
            401 => Err(CanvasError::Unauthorized),
            403 => Err(CanvasError::Forbidden),
            404 => Err(CanvasError::NotFound),
            429 => {
                let retry_after = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(30);
                Err(CanvasError::RateLimited(retry_after))
            }
            code => {
                let msg = resp.text().await.unwrap_or_default();
                Err(CanvasError::Http(code, msg))
            }
        }
    }
}

/// Extrae la URL del header Link rel="next"
/// Formato ejemplo: `<https://canvas.example.com/api/v1/courses?page=2>; rel="next"`
fn extract_next_url_from_headers(headers: &HeaderMap) -> Option<String> {
    let link_header = headers.get("Link")?.to_str().ok()?;
    extract_next_url(link_header)
}

/// Parsea el header Link y retorna la URL con rel="next"
pub fn extract_next_url(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let part = part.trim();
        if part.contains(r#"rel="next""#) {
            // El formato es: <URL>; rel="next"
            if let Some(start) = part.find('<') {
                if let Some(end) = part.find('>') {
                    return Some(part[start + 1..end].to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_next_url() {
        let header = r#"<https://canvas.example.com/api/v1/courses?page=2&per_page=50>; rel="next", <https://canvas.example.com/api/v1/courses?page=1&per_page=50>; rel="first""#;
        let next = extract_next_url(header);
        assert_eq!(
            next,
            Some("https://canvas.example.com/api/v1/courses?page=2&per_page=50".to_string())
        );
    }

    #[test]
    fn test_extract_next_url_no_next() {
        let header = r#"<https://canvas.example.com/api/v1/courses?page=1>; rel="first", <https://canvas.example.com/api/v1/courses?page=1>; rel="last""#;
        assert!(extract_next_url(header).is_none());
    }

    #[test]
    fn test_canvas_client_url_normalization() {
        let c1 = CanvasClient::new("usil.instructure.com", "token").unwrap();
        assert_eq!(c1.base_url, "https://usil.instructure.com");

        let c2 = CanvasClient::new("https://usil.instructure.com", "token").unwrap();
        assert_eq!(c2.base_url, "https://usil.instructure.com");

        let c3 = CanvasClient::new("https://usil.instructure.com/", "token").unwrap();
        assert_eq!(c3.base_url, "https://usil.instructure.com");
    }
}
