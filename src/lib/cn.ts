// cn.ts — Utility para combinar clases de Tailwind condicionalmente
// Simple string join; replace with clsx+tailwind-merge if deduplication is needed.

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
