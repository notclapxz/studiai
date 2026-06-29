# v0.14.0 Deployment Checklist

**Estado**: Feature `document-styles-configurables` + `student-memory` + `gemini-proxy` COMPLETAS y pusheadas.  
**Falta**: Deploy del proxy en Cloudflare Workers (requiere tus credenciales) + validación en dev.

**Fecha**: 28 de junio 2026  
**Tiempo estimado**: 20-30 minutos

---

## ✅ Pre-Deploy Verification

```bash
cd /Users/sebastian/Desktop/studyai-project/studyai

# 1. Verify Rust compiles
cd src-tauri && cargo check
# Expected: Finished `dev` profile... 0 warnings

# 2. Verify TypeScript compiles
cd .. && bunx tsc --noEmit
# Expected: (no output = no errors)

# 3. Verify git state
git status
# Expected: On branch main, working tree clean, ahead of origin/main by N commits
```

**Status**: ✅ Pass si todo compila sin errores.

---

## 🔧 DEPLOY Steps (15-20 min)

### Step 1: Install Wrangler + Validate

```bash
cd cloudflare/gemini-proxy
bun install
bunx wrangler types
bunx tsc --noEmit
```

**Expected output**: No TypeScript errors. If you see `jose` or `@cloudflare/workers-types` errors, run `bun install` again.

---

### Step 2: Create KV Namespace

```bash
bunx wrangler kv namespace create ENTITLEMENT
```

**Output will be like**:
```
✓ Created namespace with id: abc123def456xyz
```

**Action**: Copy the `id` and edit `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "ENTITLEMENT", "id": "abc123def456xyz" }  // ← paste here
]
```

---

### Step 3: Set Secrets

```bash
# Get your GEMINI_API_KEY (from your .env or wherever you keep it)
bunx wrangler secret put GEMINI_API_KEY
# Paste your key, press Enter, Ctrl+D (or End-of-file)

# Get SUPABASE_ANON_KEY (from Supabase project settings)
bunx wrangler secret put SUPABASE_ANON_KEY
# Paste the anon key, press Enter, Ctrl+D
```

**Verify in `wrangler.jsonc`**:
```jsonc
"vars": {
  "SUPABASE_URL": "https://szysukwkumphvltaiwpn.supabase.co"
  // ↑ Verify this matches your project
}
```

---

### Step 4: Deploy to Cloudflare Workers

```bash
bunx wrangler deploy
```

**Output will be**:
```
✓ Uploading...
✓ Uploaded successfully to gemini-proxy.<account-subdomain>.workers.dev
```

**Action**: Copy the URL (e.g., `https://gemini-proxy.abc123.workers.dev`)

---

### Step 5: Update App with Proxy URL

Edit `src-tauri/src/lib.rs`:

```rust
// Find this line (around line 180):
const DEFAULT_PROXY_BASE: &str = "REEMPLAZAR";

// Replace with your Worker URL:
const DEFAULT_PROXY_BASE: &str = "https://gemini-proxy.abc123.workers.dev";
```

**Verify**:
```bash
cd /Users/sebastian/Desktop/studyai-project/studyai/src-tauri
grep -n "DEFAULT_PROXY_BASE" src/lib.rs
# Should show your actual URL, not "REEMPLAZAR"
```

---

## 🧪 Validation in Dev

### Step 6: Start Dev Server

```bash
cd /Users/sebastian/Desktop/studyai-project/studyai
bun run tauri dev
```

Wait for app to load (30-60s).

---

### Step 7: Smoke Test Checklist

- [ ] **Login** with Google
- [ ] **Chat** (type "Hola"): Should respond via proxy in ~3-5s
- [ ] **Memory** (type "Recuerda que me llamo Sebastian"):
  - Model calls `remember` tool ✓
  - Message appears in chat ✓
  - Settings → Memoria shows the saved fact ✓
- [ ] **Create Document** (button in ChatInput):
  - Opens modal with defaults pre-filled ✓
  - Can change style (format, font, orientation) ✓
  - Click "Generar" → closes, no error ✓
- [ ] **Settings** → "Documentos":
  - All dropdowns render ✓
  - Change a setting (e.g., format to Harvard) ✓
  - Close app, reopen → setting persists ✓
- [ ] **OCR** (upload a scanned PDF):
  - Background indexing starts ✓
  - Model can read the scanned text ✓

**Status**: ✅ Pass if all checkboxes complete without errors.

---

## 📦 Release

```bash
# Verify you're on main and up-to-date
cd /Users/sebastian/Desktop/studyai-project/studyai
git status
git pull origin main

# Update CHANGELOG.md if needed (add v0.14.0 section)
# OR: it's already updated

# Tag and push
git tag v0.14.0
git push origin v0.14.0

# GitHub Actions will build and sign the DMG automatically
# Check: https://github.com/notclapxz/studiai/releases
```

Wait ~5-10 min for GitHub Actions to complete the build.

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| `wrangler deploy` fails with "binding ratelimits not found" | Delete `ratelimits` from `wrangler.jsonc` or leave it commented (it's optional) |
| Chat doesn't respond (black loader forever) | Check that `DEFAULT_PROXY_BASE` in `lib.rs` matches your Worker URL (no trailing slash) |
| `401 Unauthorized` error in chat | Check that you logged in with Google and the token is fresh. If stuck, force app quit and restart. |
| `403 not_entitled` | Your license is inactive. Check Settings → Planes. (Expected in trial/expired state.) |
| "SUPABASE_URL mismatch" | Verify `wrangler.jsonc` has the correct Supabase project URL |

---

## ✅ Done

When all steps complete:
- v0.14.0 released on GitHub ✓
- DMG signed and available for download ✓
- Proxy protecting the API key ✓
- Document styles configurable ✓
- Student memory persistent ✓

**Ready for beta with 10-20 USIL students.**

---

## 📋 Next: Beta Rollout

1. Share release link: https://github.com/notclapxz/studiai/releases/tag/v0.14.0
2. Send install guide (docs/guia-instalacion.md exists)
3. Monitor analytics (studiai.usage_events in Supabase)
4. Watch for bugs (especially proxy timeout, memory edge cases)
5. Gather feedback on document styles (format preferences)

---

**Questions?** Re-read the runbook in `docs/PROXY-GEMINI.md` or ask.
