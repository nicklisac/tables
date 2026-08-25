# T38 Design: Portable Onboarding — `tables.py --setup`

**Status:** DRAFT for user review (2026-08-24) — D1–D7 need confirmation, esp. D2 (crypto surface)
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
Caveat to handle: on headless Linux the keyring fallback can be a plaintext
file — detect weak backends and warn loudly before saving.

**Backend B — sealed in-file (portable).** New table
`secrets(name TEXT PRIMARY KEY, salt BLOB, iterations INTEGER, nonce BLOB,
ciphertext BLOB, mac BLOB)` (added to `INTERNAL_TABLES` — T37 F-01 lesson: the
underscore rule does NOT protect it). Passphrase prompted once per run
(`getpass`, never echoed); PBKDF2 → keystream; verify MAC before use.
Keeps the "one file, any laptop" story: copy the `.sqlite3`, type the
passphrase, done.

**Daily key resolution order:** `--api-key` → env (`TABLES_LLM_API_KEY` →
`OPENAI_API_KEY` → `GEMINI_API_KEY`) → keyring(profile) → sealed (prompt) →
paste prompt. Setup offers: `[1] OS keyring (recommended)  [2] seal in the file`.

**Deliberately NOT doing:** scanning the keyring for entries *outside* our
namespace and guessing by prefix (`AIza…`/`sk-…`) — that's creepy even when
well-intentioned. Our own namespace + paste covers it (D3).

## 5. Config resolution chain after setup (flagless runs)

```
url:    --llm-url → TABLES_LLM_URL → system_config.llm_url (in-file) → refuse loudly
model:  --model   → TABLES_LLM_MODEL → system_config.llm_model → manifest recommended_model → refuse loudly
key:    §4 order above
```

In-file `system_config` sits *above* the manifest because setup writes it and
it's the same data, fresher. Refuse-loudly stays the terminal behavior — there
is still no default model (T-batch decision, unchanged).

## 6. Changes by surface

- **Web (`src/cartridge.js`, export path):** stamp profiles at export (§2).
  Web boot already records `llm_model`; extend the same pattern with
  `llm_provider` / `llm_url` (active profile) + the full profile set.
- **Host (`host/tables.py`):** `--setup` flow, key backends, secrets table,
  new resolution chain, connection test. Est. +250–350 lines (the file is
  840 today; the user has accepted its length — this grows it deliberately).
- **Schema (`src/schema.js`):** `secrets` table DDL + `INTERNAL_TABLES` entry
  (web brains get it too, so imported-back files are consistent); new
  `system_config` keys seeded empty.

## 7. Decisions — need user confirmation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Profiles in the file: real table `llm_profiles(id, name, provider, url, model)` vs JSON blob in `system_config` | **Table** — "everything is a table" is the product's identity; setup lists them with plain SQL. (Blob is the cheap alternative if you want less schema surface.) |
| D2 | Key backends: keyring-default **+ sealed-in-file optional** (accepts ~40 lines of hand-rolled stdlib crypto) vs keyring-only v1 | **Both** — the sealed option is what makes the file truly portable; but it's your explicit call to accept the crypto surface. |
| D3 | Keyring discovery: our namespace only + paste, no prefix-sniffing foreign entries | **Yes** (privacy) |
| D4 | Setup writes non-secret config **back into the cartridge** vs sidecar `.tables-config` file | **Into the cartridge** — T37 D6 already locked "the file is the user's agent, in-place always"; a sidecar breaks the one-file story. |
| D5 | Connection test at end of setup (one tiny real completion) | **Yes** — "✓ works" beats "saved." |
| D6 | Keyring convention: service `tables`, account = profile id | as stated |
| D7 | Export scope: **all** saved profiles vs active-only | **All** (keys never) — matches "bring in any data from the web if it has already been established." |

## 8. Testing strategy (repo conventions)

- **PTY driver** (t37 pattern) for scripted stdin through the whole setup flow:
  multi-file selection, provider selection, backend choice, passphrase entry.
- **Fake LLM server** for the connection test (success + failure paths).
- **Keyring:** injectable fake — `TABLES_KEYRING=mock` env hook (or a small
  seam module) so specs run on any CI box; real-keyring smoke stays
  live-gated like the other probes.
- **Sealed crypto:** known-answer vectors (fixed passphrase/salt → fixed
  ciphertext) + round-trip + wrong-passphrase MAC failure + tamper detection.
- **Export side:** t37-style spec — export carries profiles, never keys
  (sentinel-key full-file scan, same as the model-tracking test).

## 9. Open questions (parked, not blocking)

- Passphrase caching for a single run's multiple prompts (fetch approvals etc.)
  — probably just keep it in memory per process; no disk cache, ever.
- `--setup --rekey` (move a key between backends) — likely a v1.1 nicety.
- Windows: `getpass` works but console echo quirks may need a `ctypes` nudge.
