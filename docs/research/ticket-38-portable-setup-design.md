# T38 Design: Portable Onboarding — `tables.py --setup`

**Status:** ✅ **DECISIONS LOCKED (2026-08-24, user OK)** — D1–D7 confirmed; ready to start. D2 per AGY `agy-1787668835-614956` + tech lead (no in-file sealing, no hand-rolled crypto). Parked micro-decisions (§9/§10) are non-blocking.
**Depends on:** T36 ✅ · T37 ✅ · model tracking (`85a9580` — `llm_model` → `recommended_model` already travels in exports)

---

## 1. Goal

First-run experience for the portable host: one guided command takes a user from
"I have this `.sqlite3` file" to "first successful turn," pulling in everything
the web app already knows. After setup, **daily use stays a flagless one-liner**:

```
python3 tables.py my-agent.sqlite3 "Summarize my data"
```

Today's pain (why this ticket exists):
- `--llm-url` / `--model` / `--api-key` must be hand-typed or env-exported **every run**.
- The web app's provider config (endpoint, provider id, saved profiles) does **not**
  travel in exports — only the model *name* does (`recommended_model`).
- There is no key-storage story on the CLI side at all.

**Non-goals:** browser-side keyring access (impossible); key rotation UI; multi-user
files; cryptographic author signing (T37 v2 fog, unchanged).

## 2. What travels in the file today vs. what setup needs

| Data | Travels today? | Setup needs it? |
|---|---|---|
| Model name (`recommended_model`) | ✅ (since `85a9580`) | ✅ |
| Provider id + base URL | ❌ | ✅ — the user's point: "export the API endpoints saved to the web interface" |
| Saved provider profiles (all of them) | ❌ | ✅ — "which should it use if more than one" |
| API keys | ❌ **by design** (key-leak safety, asserted by test) | ✅ — but via a key backend (§4), never plaintext in the file |

Export change: stamp the provider profiles from the web's profile store
(`src/provider-store.js`, localStorage) into the cartridge at export time —
`name, provider, url, model` per profile. **Keys are structurally excluded**
(the store is the only place they live; the export path never sees them).

## 3. The setup flow

`python3 tables.py --setup` (no cartridge arg → discovery mode; with an arg →
skip straight to step 2 for that file).

1. **Find the cartridge.** Scan cwd for `*.sqlite3`; shape-check each with the
   existing `_is_tables_database()` (sessions/messages/system_config/tools).
   - >1 valid → numbered list, user sends back `1` / `2` / …
   - exactly 1 → "Is this the right one? [Y/n]"
   - 0 → ask for a path.
2. **Pick the provider.** Read profiles from the file (§2 export change).
   - 1 → "Use `{name}` — {provider} at {url}, model {model}? [Y/n/edit]"
   - N → numbered list, same selection UX as step 1.
   - none (pre-T38 export) → manual entry: provider select + URL + model,
     with the existing URL auto-heal applied.
3. **Pair the key** (§4 backend choice).
4. **Connection test (NEW — my addition).** One tiny real completion
   (`max_tokens` ≈ 1, prompt "ping") before declaring success. Onboarding that
   says "saved" but never verified is how you debug at 2am. Failure shows the
   provider's actual error and offers to re-enter.
5. **Persist + summary.** Non-secret config (provider/url/model per profile)
   written back into the cartridge's `system_config` (D4); key to the chosen
   backend; print the flagless daily one-liner + "re-run with --setup anytime."

## 4. Key storage — two backends (the crypto question)

**Facts established:**
- SQLite is **not** text-only: BLOBs exist; ciphertext in a column is trivial.
  The real constraint is *where the decryption key lives*.
- Storing the key alongside the ciphertext = security theater (attacker has both).
- Stdlib Python has **no symmetric cipher** (no AES/ChaCha), but a sound
  construction exists from stdlib primitives: PBKDF2-HMAC-SHA256 (KDF) +
  HMAC-SHA256 counter-mode keystream (XOR) + encrypt-then-MAC, domain-separated
  subkeys. ~40 lines, known-answer-testable. It is still hand-rolled crypto —
  small surface, but it needs an explicit user OK (D2).
- In-file encryption protects against **inspection** (peek, backup leak), not
  **execution**: anyone who can run the file can run its embedded engine and
  read the key at runtime. T37's trust model already accepts that boundary.

**Backend A — OS keyring (recommended default).** The `keyring` package as an
*optional* import (`try/except`; core stays zero-dependency; setup prints a
one-line `pip install keyring` hint when the user picks this and it's absent).
Entries under our own namespace: service `tables`, account = profile id (D6).
Strongest option: the key never exists in any file; protected by OS login.
Backend behavior (verified against keyring v25.x): Windows → Credential
Manager (`pywin32-ctypes`), macOS → Keychain, Linux → Secret Service via
`SecretStorage`/`jeepney`. **No recommended backend available (e.g. headless
Linux) → `RuntimeError: No recommended backend was available`** — the
non-recommended plaintext-file backend requires explicitly installing the
separate `keyrings.alt` package, so there is no silent weak fallback to guard
against; setup catches the error and offers paste / sealed-in-file instead.

**Backend B — machine-local config file (zero-dep fallback).** When `keyring`
isn't installed, setup saves to `~/.config/tables/credentials.json` (Windows:
`%APPDATA%\tables\`) written via `os.open(..., 0o600)` — the exact pattern
`gh` uses (`hosts.yml` at 0600 behind the keyring). Stdlib only; no crypto.

**Daily key resolution order:** `--api-key` → env (`TABLES_LLM_API_KEY` →
`OPENAI_API_KEY` → `GEMINI_API_KEY`) → keyring(profile) → local config file →
paste prompt (which offers to save, choosing backend A or B by availability).

### 4.1 Why NOT sealed-in-file (AGY input, job `agy-1787668835-614956`, 2026-08-24)

The original draft offered a third backend: the key encrypted INSIDE the
`.sqlite3` (PBKDF2 + HMAC-CTR keystream + encrypt-then-MAC, stdlib-only).
AGY review (`gemini-3.7-flash-high`) recommended killing it; tech lead concurs.
Decisive arguments:

1. **UX contradiction:** a passphrase-sealed key requires the passphrase on
   EVERY run — breaking the flagless daily use that is `--setup`'s whole point.
   Caching the derived key locally makes the in-file ciphertext redundant (you'd
   just have a machine-local key — store it as one).
2. **Contradicts our own invariant:** the model-tracking test asserts API keys
   never travel in exported files. Cartridges are shareable artifacts (email,
   git, S3); a secret inside one is a leak vector even when encrypted.
3. **No precedent:** gh / AWS / gcloud / az / docker / git / npm all keep
   credentials machine-local; portable-artifact encryption exists only in tools
   whose purpose IS portable config (SOPS/age, 1Password) — and they use
   standard AEAD, not hand-rolled primitives.
4. **Crypto surface:** PBKDF2 is not memory-hard (GPU brute-force of a weak
   passphrase against an exfiltrated file), Python can't zero keystream
   residue, and auditors reject custom stream ciphers on sight.

Portability story under the locked model: the file carries everything EXCEPT
identity (provider/URL/model travel; the key is paired once per machine via
`--setup`) — the same model as `gh auth login` / `aws configure` /
`docker login`.

**Deliberately NOT doing:** scanning the keyring for entries *outside* our
namespace and guessing by prefix (`AIza…`/`sk-…`) — that's creepy even when
well-intentioned. Our own namespace + paste covers it (D3).

## 5. Config resolution chain after setup (flagless runs)

```
url:    --llm-url → TABLES_LLM_URL → system_config.llm_url (in-file) → refuse loudly
model:  --model   → TABLES_LLM_MODEL → system_config.llm_model → manifest recommended_model → refuse loudly
key:    --api-key → env → keyring(profile) → ~/.config/tables/credentials.json → paste
```

In-file `system_config` sits *above* the manifest because setup writes it and
it's the same data, fresher. Refuse-loudly stays the terminal behavior — there
is still no default model (T-batch decision, unchanged).

## 6. Changes by surface

- **Web (`src/cartridge.js`, export path):** stamp profiles at export (§2).
  Web boot already records `llm_model`; extend the same pattern with
  `llm_provider` / `llm_url` (active profile) + the full profile set.
- **Host (`host/tables.py`):** `--setup` flow, key backends (keyring optional
  import + 0600 local file), new resolution chain, connection test. Est.
  +250–350 lines (the file is 840 today; the user has accepted its length —
  this grows it deliberately).
- **Schema (`src/schema.js`):** new `system_config` keys seeded empty
  (`llm_provider`, `llm_url` + profile set per D1). No secrets table — keys
  never touch the file (§4.1).

## 7. Decisions — LOCKED (user OK, 2026-08-24)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Profiles in the file: real table `llm_profiles(id, name, provider, url, model)` vs JSON blob in `system_config` | **Table** ✅ locked — "everything is a table" is the product's identity; setup lists them with plain SQL. |
| D2 | Key backends: keyring + 0600 local-file fallback, **no in-file sealing, no hand-rolled crypto** (per §4.1 — AGY `agy-1787668835-614956` + tech lead) vs the original draft's sealed-in-file option | **Keyring + local file** ✅ locked. The original draft's sealed backend is killed: UX contradiction (passphrase per run breaks flagless use), contradicts our own key-leak invariant, no industry precedent, and a crypto surface that buys nothing the threat model needs. User-confirmed 2026-08-24. |
| D3 | Keyring discovery: our namespace only + paste, no prefix-sniffing foreign entries | **Yes** (privacy) |
| D4 | Setup writes non-secret config **back into the cartridge** vs sidecar `.tables-config` file | **Into the cartridge** — T37 D6 already locked "the file is the user's agent, in-place always"; a sidecar breaks the one-file story. |
| D5 | Connection test at end of setup (one tiny real completion) | **Yes** — "✓ works" beats "saved." |
| D6 | Keyring convention: service `tables`, account = profile id | as stated |
| D7 | Export scope: **all** saved profiles vs active-only | **All** ✅ locked (keys never) — matches "bring in any data from the web if it has already been established." |

## 8. Testing strategy (repo conventions)

- **PTY driver** (t37 pattern) for scripted stdin through the whole setup flow:
  multi-file selection, provider selection, backend choice, passphrase entry.
- **Fake LLM server** for the connection test (success + failure paths).
- **Keyring:** injectable fake — `TABLES_KEYRING=mock` env hook (or a small
  seam module) so specs run on any CI box; real-keyring smoke stays
  live-gated like the other probes.
- **Local-file backend:** round-trip + 0600 permission assertion +
  keyring-absent fallback path (mock import failure).
- **Export side:** t37-style spec — export carries profiles, never keys
  (sentinel-key full-file scan, same as the model-tracking test).

## 9. Setup UX scripts (2026-08-24, walked through with user)

One interaction idiom throughout: numbered list → type a number; single item →
`[Y/n]`. The key step is a 2×2: (backend available?) × (entry exists for THIS
profile — lookup is by profile id, so one pairing covers every cartridge
exported from the same web app). Setup ends in exactly one of two honest
states: "✓ works" (connection-tested) or "config saved, key not paired — you'll
be asked on first run" (skip chosen).

**S1 — keyring has the credential (fast path, ~4 keypresses):**
```
◆ Cartridges in ~/Downloads:
  1. my-agent.sqlite3    Tables v3 · exported 2026-08-24
Is this the right one? [Y/n] Y
◆ Provider (saved in the file):
  Groq — https://api.groq.com/openai/v1 · llama-3.3-70b-versatile
Use this? [Y/n/edit] Y
◆ API key: found in your keychain — "tables / groq" (saved Aug 20)
Use it? [Y/n] Y                      ← shows service/account + date, NEVER the key
◆ Testing connection… ✓ works (groq · llama-3.3-70b-versatile)
✓ Done. Daily use: python3 tables.py my-agent.sqlite3 "your question"
```

**S2 — keyring present, nothing for this profile:**
```
◆ API key: none found for this profile (keychain + local config).
  [1] Paste your API key
  [2] Skip — pair it later
> 1
API key: ********                    ← getpass, no echo
Save it so future runs don't ask?
  [1] OS keychain (recommended)
  [2] Local file (~/.config/tables/credentials.json, owner-only)
  [3] Don't save
> 1
✓ Saved to your keychain ("tables / groq")
◆ Testing connection… ✓ works        ← failure shows the provider's real error
                                       and loops back to re-enter; setup never
                                       ends on an unverified "saved"
```
No scanning of foreign keyring namespaces by prefix (D3).

**S2b — keyring has OTHER Tables keys, but not this profile's.** Profile ids
are per-browser UUIDs, so a usable key can sit in our namespace under a
different account name (different browser/export). On an exact-match miss,
offer candidates from OUR namespace only — explicit choice, no guessing:
```
◆ API key: none found for profile "groq-abc123".
  You have other saved Tables keys:
    1. tables/groq-xyz789    Groq · llama-3.3-70b-versatile · saved Aug 20
    2. tables/or-def456      OpenRouter · claude-sonnet-4.5 · saved Jul 30
  Use one of these? [1/2/n — n = paste a new key] > 1
◆ Testing connection… ✓ works        ← a wrong pick is caught here, not by us
                                       trying to be clever
```
Friendly name shows when the candidate's id resolves against the current file's
profiles (or local config); otherwise raw account + date. Values never shown.
Still D3-compliant: our namespace only, explicit choice. Foreign keychain
entries stay invisible regardless of how full the keyring is.

**S3 — missing everything** (no keyring package/backend, nothing saved; shown
with a pre-T38 export that has no provider config):
```
◆ Provider: this file has no saved provider config (older export).
  [1] OpenAI-compatible (custom)   [2] Ollama (local)   [3] LM Studio …
> 2
  Base URL: http://localhost:11434
    → healed to http://localhost:11434/v1/chat/completions
  Model: llama3.2
◆ API key: Ollama needs none — skipped.      ← keyRequired=false from registry
◆ Testing connection… ✓ works (ollama · llama3.2)
✓ Done. Config saved in the file.
Tip: pip install keyring, then re-run --setup to use your OS keychain.
```
Keyed variant: paste → save offer lists only available backends (local file when
keyring absent) → test. The `pip install keyring` hint lands at the END, never
mid-flow. Local providers skip the key step entirely.

**Open micro-decisions:** keep "Skip — pair it later" (S2) with its honest
end-state marker, or make setup refuse to finish without a working key? ·
Stale-entry cleanup (`--setup --prune`: offer to remove `tables/*` entries whose
id matches no known profile) — parked as v1.1.

## 10. Open questions (parked, not blocking)

- `--setup --rekey` (move a key between backends) — likely a v1.1 nicety.
- Windows: `getpass` works but console echo quirks may need a `ctypes` nudge.
- Whether the local-file backend should store per-profile entries keyed by the
  SAME profile ids as the in-file profiles (so a re-exported cartridge's
  profiles line up with the machine's stored keys) — leaning yes.
