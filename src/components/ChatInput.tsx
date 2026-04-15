// ChatInput.tsx — Input del chat con patrón DockShell
// Textarea auto-expandible + botón enviar + imagen paste/drop

import { useState, useRef, useCallback, useEffect } from "react";
import { Paperclip, Send, X, Image as ImageIcon } from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PendingImage {
  base64: string;
  mediaType: string;
  name: string;
}

interface ChatInputProps {
  /** Callback cuando el usuario envía un mensaje */
  onEnviar: (mensaje: string, images?: PendingImage[]) => void;
  /** Si true, deshabilita el input (ej: mientras la IA está respondiendo) */
  deshabilitado?: boolean;
  /** Placeholder del textarea */
  placeholder?: string;
  /** Imagen externa (ej: dropeada en el panel) */
  externalImage?: PendingImage | null;
  /** Callback para limpiar imagen externa después de procesarla */
  onExternalImageClear?: () => void;
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function ChatInput({
  onEnviar,
  deshabilitado = false,
  placeholder = "Escribe un mensaje...",
  externalImage,
  onExternalImageClear,
}: ChatInputProps) {
  const [mensaje, setMensaje] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // Guard contra setState-after-unmount en callbacks async de FileReader.
  // Se marca en false al desmontar y se chequea en reader.onload.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Si llega una imagen externa (del drag en el panel), incorporarla
  const prevExternalRef = useRef<PendingImage | null>(null);
  useEffect(() => {
    if (externalImage && externalImage !== prevExternalRef.current) {
      prevExternalRef.current = externalImage;
      setPendingImages((prev) => {
        if (prev.length >= 5) return prev;
        return [...prev, externalImage];
      });
      onExternalImageClear?.();
    } else if (!externalImage && prevExternalRef.current) {
      prevExternalRef.current = null;
    }
  }, [externalImage, onExternalImageClear]);

  const effectiveImages = pendingImages;
  const clearImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };
  const clearAllImages = () => {
    setPendingImages([]);
    onExternalImageClear?.();
  };
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Ajusta la altura del textarea automáticamente */
  const ajustarAltura = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxAltura = 200; // 200px máximo
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxAltura)}px`;
  }, []);

  /** Lee un archivo de imagen y lo convierte a base64 */
  // NOTA: La validación de máximo 5 imágenes y tamaño 4MB es sólo frontend.
  // TODO: El backend Rust debe validar lo mismo (pendiente en un bloque futuro).
  const processImageFile = useCallback((file: File) => {
    // Validar tamaño: 4MB max
    if (file.size > 4 * 1024 * 1024) {
      console.warn("[ChatInput] Image too large:", file.size);
      return;
    }
    setPendingImages((prev) => {
      if (prev.length >= 5) {
        console.warn("[ChatInput] Max 5 images per message");
        return prev;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // Guard: el componente puede haberse desmontado mientras el
        // FileReader estaba leyendo. Evita setState-after-unmount.
        if (!isMountedRef.current) return;
        const base64 = (reader.result as string).split(",")[1];
        setPendingImages((p) => {
          if (p.length >= 5) return p;
          return [...p, {
            base64,
            mediaType: file.type,
            name: file.name || "screenshot.png",
          }];
        });
      };
      reader.readAsDataURL(file);
      return prev;
    });
  }, []);

  /** Maneja cambios en el textarea */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setMensaje(e.target.value);
    ajustarAltura();
  }

  /** Envía el mensaje si tiene contenido o imagen */
  function handleEnviar() {
    const texto = mensaje.trim();
    if ((!texto && effectiveImages.length === 0) || deshabilitado) return;
    onEnviar(
      texto || (effectiveImages.length > 0 ? "Que ves en esta imagen?" : ""),
      effectiveImages.length > 0 ? effectiveImages : undefined
    );
    setMensaje("");
    clearAllImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  /** Envía con Enter, nueva línea con Shift+Enter */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEnviar();
    }
  }

  /** Maneja paste — detecta imágenes del portapapeles */
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          processImageFile(file);
          e.preventDefault();
        }
        break;
      }
    }
  }

  /** Maneja drag over — muestra indicador visual */
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  /** Maneja drop — acepta archivos de imagen */
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      processImageFile(file);
    }
  }

  /** Maneja click en el botón de adjuntar — abre selector de archivos */
  function handleAttachClick() {
    fileInputRef.current?.click();
  }

  /** Maneja selección de archivo desde el input oculto */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files) {
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          processImageFile(file);
        }
      }
    }
    // Reset para permitir seleccionar el mismo archivo de nuevo
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  const puedeEnviar = (mensaje.trim().length > 0 || effectiveImages.length > 0) && !deshabilitado;

  return (
    <div
      className="px-4 py-3 shrink-0"
      style={{ borderTop: "1px solid var(--border-base)" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Preview de imagenes pendientes */}
      {effectiveImages.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg mb-2 flex-wrap"
          style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
        >
          {effectiveImages.map((img, idx) => (
            <div key={idx} className="relative shrink-0">
              <img
                src={`data:${img.mediaType};base64,${img.base64}`}
                className="h-16 w-16 object-cover rounded"
                alt={img.name}
              />
              <button
                onClick={() => clearImage(idx)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center outline-none"
                style={{ background: "var(--error)", color: "var(--text-strong)" }}
                title="Quitar imagen"
                aria-label={`Quitar imagen ${idx + 1}`}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          ))}
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span
              className="text-xs flex items-center gap-1"
              style={{ color: "var(--text-weak)" }}
            >
              <ImageIcon size={10} strokeWidth={1.5} />
              {effectiveImages.length} imagen{effectiveImages.length > 1 ? "es" : ""} adjunta{effectiveImages.length > 1 ? "s" : ""}
            </span>
            {effectiveImages.length >= 5 && (
              <span className="text-xs" style={{ color: "var(--error)" }}>
                Maximo 5 imagenes
              </span>
            )}
          </div>
        </div>
      )}

      {/* Contenedor del input — DockShell pattern */}
      <div
        className="flex items-end gap-2 rounded-xl px-3 py-2"
        style={{
          background: "var(--bg-surface-hover)",
            border: isDragging
            ? "2px dashed var(--accent-warm-dim)"
            : "1px solid var(--border-base)",
          transition: "border-color 0.15s",
        }}
        onFocus={() => {
          // Hacemos que el focus del textarea suba al contenedor visualmente
        }}
      >
        {/* Botón adjuntar */}
        <button
          type="button"
          onClick={handleAttachClick}
          className="w-7 h-7 shrink-0 rounded flex items-center justify-center transition-colors duration-100 outline-none mb-0.5"
          style={{ color: "var(--text-weak)" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--text-base)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
          }}
          title="Adjuntar imagen"
          aria-label="Adjuntar imagen"
          disabled={deshabilitado}
        >
          <Paperclip size={16} strokeWidth={1.5} />
        </button>

        {/* Input oculto para selección de archivos */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Textarea auto-expandible */}
        <textarea
          ref={textareaRef}
          value={mensaje}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={deshabilitado}
          rows={1}
          className="flex-1 resize-none bg-transparent outline-none text-sm leading-relaxed"
          style={{
            color: "var(--text-strong)",
            maxHeight: "200px",
            fontFamily: "var(--font-sans)",
          }}
        />

        {/* Botón enviar */}
        <button
          type="button"
          onClick={handleEnviar}
          disabled={!puedeEnviar}
          className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center transition-all duration-150 outline-none mb-0.5"
          style={{
            background: puedeEnviar ? "var(--accent)" : "var(--bg-surface-active)",
            color: puedeEnviar ? "white" : "var(--text-ghost)",
            cursor: puedeEnviar ? "pointer" : "not-allowed",
          }}
          title="Enviar (Enter)"
          aria-label="Enviar mensaje"
        >
          <Send size={14} strokeWidth={1.5} />
        </button>
      </div>

      {/* Hint: Shift+Enter para nueva línea */}
      <p
        className="text-center mt-1.5"
        style={{ color: "var(--text-ghost)", fontSize: "11px" }}
      >
        Enter para enviar · Shift+Enter para nueva linea · Pega o arrastra imagenes
      </p>
    </div>
  );
}

export default ChatInput;
