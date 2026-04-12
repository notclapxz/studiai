# Code Review Rules — StudiAI

## TypeScript
- Use `const`/`let`, never `var`
- Prefer interfaces over types for object shapes
- No `any` — use `unknown` and narrow
- Strict null checks always

## React
- Functional components only
- Named exports preferred
- No `useMemo`/`useCallback` — React Compiler handles it
- Keep components small and focused

## Tailwind
- Use `cn()` for conditional classes
- No `var()` inside `className`

## Rust
- Handle all `Result`/`Option` explicitly
- No `unwrap()` in production paths — use `?` or proper error handling

## General
- No hardcoded secrets or API keys
- Comments in Spanish for business logic, English for technical details
- Prefer explicit over clever
