# T37 Design: Self-Booting Cartridges — In-File Host + Trust Model

**Status:** DRAFT for user decision (2026-08-24) — branch `t37-self-booting-cartridges`
**Depends on:** T36 ✅ (`485ceec`) — its committed `host/host.py` is the reference semantics
**Source:** fog entry "Agent on a Keychain" (2026-08-20/21); four-class split research doc §6

---

## 1. Goal

The cartridge ships its own host: the loader source lives **in the file** (`system_files`
table), so a `.sqlite3` literally contains its own engine — "agent on a keychain." One
command extracts and runs it:

```
python3 -c "import sqlite3;exec(sqlite3.connect('C').execute(\"select body from system_files where name='host.py'\").fetchone()[0])" C [message]
```

This ticket makes that a **product**: the web engine stamps the host into every export,
the host verifies itself at boot, network capability is gated, and guest cartridges run
on working copies so the original artifact is never mutated.

**Non-goals (v1):** cryptographic author signing (→ fog/v2, §7); Node `host.cjs` dual-host
and Datasette tier (validated alternatives, stay documented — §6); writes/rewind/compaction
in the standalone host (T36 non-goals unchanged).

## 2. Verified facts (empirical, this session)

1. **Keychain one-liner works against T36's committed host** (map, 2026-08-24): full boot
   report + complete ReAct turn (ask_llm → execute_sql → final answer), conversation written
   back into the same file, exit 0, stdlib only. Exec-path quirks all clean (`__future__`
   import in exec'd string, `__main__` guard fires under `python3 -c`, argv passthrough).
2. **Guest-isolation mechanism verified** (probe 2026-08-24): `VACUUM INTO 'copy'` succeeds
   from a `file:C?mode=ro` connection — the original opens read-only, the copy is complete,
   writes on the RO handle raise `OperationalError`, and no `-wal`/`-journal` sidecars touch
   the original. `immutable=1` also works but **silently drops uncheckpointed WAL frames**
   (researcher) — use only for files known to be in use elsewhere; our exports are always
   clean single-file DBs (serialize of a memdb), so `mode=ro` is the default.
3. **The frozen `_manifest` shape test asserts per-field, not key-set-exact**
   (`tests/specs/t33b-staged-import.spec.mjs:129`) — adding a new manifest key is safe for
   T36 (it reads named keys) and does not break the freeze. The freeze meant "T36 consumes
   it unchanged," not "no future ticket may add a key."
4. **`system_files` is already protected by T21's boundary**: `isProtectedTable` refuses any
   name starting with `_` (`src/schema.js:1238`) — same convention that already protects
   `_manifest`. No capture triggers, DDL refused, excluded from user-data reporting.
5. **Researcher findings on trust patterns** (subagent report 2026-08-24): SHA-256 pinning
   is cheap and detects corruption/drift but an attacker with write access updates both hash
   and code (it is *integrity*, not *authenticity*); keyed Ed25519 is the practical crypto
   option for a stdlib-only host but is v2-scale; keyless cosign/Sigstore verification is too
   heavy for a 700-line loader; the historical lesson from Office-macro/PDF-JS formats is that
   **default-allow + after-the-fact warning failed** — modern runtimes gate by default and
   require explicit consent (Android permission screen, macro prompts).

## 3. Architecture — what changes where

### 3.1 `system_files` table (new)

```sql
CREATE TABLE IF NOT EXISTS system_files (
  name    TEXT PRIMARY KEY,   -- 'host.py'
  mime    TEXT NOT NULL,      -- 'text/x-python'
  body    TEXT NOT NULL,      -- full source, verbatim from host/host.py
  sha256  TEXT NOT NULL       -- SHA-256 hex of body (UTF-8)
);
```

- Created **only in the export staging copy** — never in the live web DB at boot. The live
  DB stays lean; self-containment is a property of the *artifact*, not the working database.
- If a T37-stamped cartridge is imported into the web engine, `backupFull` carries the table
  into the live DB (it's just data there — inert in the web tier). The next export
  **upserts** it with the current build's host, so the embedded host always converges to the
  newest engine that exported the file.
- Protected by T21 for free (underscore prefix) — scratchpad `!!DROP TABLE system_files`
  is refused; no capture triggers; invisible to user-data counts.

### 3.2 Export-time stamping (`src/cartridge.js`)

Single source of truth = `host/host.py` in the repo, pulled into the build as raw text:

```js
import hostPySource from '../host/host.py?raw';   // Vite raw import — any file type
```

In `exportCartridge()`, after `writeManifest()` and before serialize:

1. `CREATE TABLE IF NOT EXISTS system_files …` on the staging DB;
2. compute `sha256 = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostPySource)))`;
3. upsert row `('host.py', 'text/x-python', hostPySource, sha256)`;
4. add manifest key **`host_sha256`** (additive — §2.3) so the hash is visible via plain SQL
   peek (`sqlite3 c.sqlite3 "select * from _manifest"`) without knowing `system_files` exists.

Implementation-time check: confirm Vite's `?raw` serves `.py` from the project root in dev
and inlines it in the build (expected — `?raw` is a query transform independent of file
type; `host/` is inside the workspace root).

### 3.3 Host changes (`host/host.py`)

All additive to T36's boot sequence:

1. **Self-check (§5, L1):** after opening, if `system_files` exists, verify
   `sha256(body of 'host.py') == stored sha256`. Mismatch → refuse to exec (corruption or
   tamper); print both hashes. Absent table → pre-T37 export, boot as today with a note.
2. **Capability gate (§5, L3):** `fetch_url` registers as a **stub by default**; the real
   implementation activates only with `--allow-fetch` (flag) or `TABLES_ALLOW_FETCH=1`
   (env). The boot report says which mode is active. This is the "keychain permission
   prompt" — the one capability that reaches beyond the LLM endpoint itself.
3. **Guest mode (§4):** new `--copy [PATH]` flag → open original `?mode=ro`,
   `VACUUM INTO` a working copy (default path: `<name>.work.sqlite3` beside the original),
   run all turns against the copy, and say so in the boot report + exit summary. Default
   (no flag) stays in-place — your own cartridge on your machine.
4. **Provenance report (§5, L0):** the existing `report()` gains the host sha256 line and
   the fetch-mode line; it is printed before any turn runs (already true — formalized as the
   consent surface).

### 3.4 Web import trust surface (`src/cartridge.js` + report)

The web engine **never executes** the embedded host (it uses its own JS UDFs), so a mismatch
is not an execution risk *in the web tier* — but it is the signal that "this file was
modified after export," which matters if the user later runs it via CLI. The post-import
report gains one line:

- `Embedded host: matches this build (sha256 ab12…)` /
  `Embedded host: DIFFERS from this build (file: …, build: …) — review before running it in a CLI` /
  `Embedded host: none (pre-T37 export)`

Warning banner on mismatch; **not** a refusal (D7).

## 4. Guest isolation — working-copy semantics

The T36 demo wrote the turn into the ORIGINAL file: fine for your own cartridge, wrong for a
guest's artifact. Decision shape:

- **CLI:** `--copy [PATH]` (opt-in; default in-place). Mechanism verified (§2.2):
  `sqlite3.connect('file:C?mode=ro', uri=True)` → `VACUUM INTO 'C.work.sqlite3'` → close RO
  handle → open the copy read-write and proceed with T36's boot unchanged. The original is
  opened read-only for its entire life in guest mode; no sidecar files touch it.
- **Web:** already guest-safe by construction — import deserializes into a staging `:memory:`
  DB and swaps into IDB; the file on disk is never written. Nothing to do.
- **Export convergence:** re-exporting a working copy through the web engine produces a clean
  artifact again (staging stamp refreshes host + manifest) — the loop closes.

## 5. Trust model (v1) — layered, no crypto

"A file that ships its own console is a malware distribution format until it signs." v1 does
**not** sign; it layers the four cheap controls that research and the T36 facts support, each
with an explicit job:

| Layer | Mechanism | Catches | Cost |
|---|---|---|---|
| **L0 Consent at boot** | Provenance report printed before any turn: host version + sha256, cartridge id, tools real/stubbed, fetch mode, LLM endpoint | Human sees exactly what will execute and with what capability | ~free (report exists) |
| **L1 Integrity self-check** | `sha256` column on `system_files`; host verifies its own body before exec; refuse-loud on mismatch | Accidental corruption; casual tamper (hash not recomputed) | stdlib `hashlib`, trivial |
| **L2 Drift vs known-good anchor** | Web import compares embedded hash to the build-bundled host's hash → report line + banner; CLI prints its hash for manual comparison, optional `--verify-host <sha256>` pin | "This file changed after export" — the anchor lives in *your engine*, not the file (non-circular) | one compare per import |
| **L3 Capability gating** | `fetch_url` stub-by-default; `--allow-fetch` / env to enable; report states the mode | Prompt-injected local-network probing; unexpected egress from a guest cartridge | one flag |

**What v1 does NOT catch (stated, not hidden):** an attacker with write access to the file
can replace `body` *and* recompute `sha256` — L1/L2 then pass. That is the malware case, and
it is what **signing solves**: an out-of-band key (keyed Ed25519 with a published public key,
or cosign keyless/OIDC) authenticates *authorship*, which no in-file hash can. Researcher's
cost/benefit: keyed Ed25519 is the practical v2 (pure-Python verify is embeddable; keyless
Sigstore verification is too heavy for a stdlib loader). **Decision D4 defers this to fog/v2**
with the findings recorded here so the contract (`host_sha256` + `system_files` shape) is
already signing-ready: a v2 signature would be a new manifest key over exactly these values.

## 6. Host tiers (v1 scope statement)

- **Tier ① Web/WASM** — unchanged; the embedded host is inert data in this tier.
- **Tier ③ Python CLI** — **the v1 product**: T36's loader, now self-stamped and self-checked.
- Tier ② Node `host.cjs` (dual-host) and Tier ④ Datasette `prepare_connection` plugin remain
  **validated alternatives in the fog** — not embedded, not built. If a second host is ever
  embedded, `system_files` already supports it (`name`-keyed rows); the manifest would gain
  per-name hashes.

## 7. Decisions (D1–D8) — D4/D5/D6 need explicit user confirmation

- **D1 Stamp at export only; single source of truth = `host/host.py` via Vite `?raw`.**
  Live web DB never carries the table until a stamped file is imported back. *(lean: yes)*
- **D2 `system_files(name, mime, body, sha256)` shape; protected by T21's underscore rule for free.**
  *(lean: yes)*
- **D3 Additive manifest key `host_sha256`** (freeze-safe per §2.3; T36 ignores unknown keys).
  *(lean: yes)*
- **D4 Trust model v1 = L0+L1+L2+L3, no cryptographic signing in v1** — signing is fog/v2,
  contract made signing-ready by `host_sha256` + `system_files`. **← confirm**
- **D5 `fetch_url` off-by-default in the standalone host** (`--allow-fetch` / env to enable).
  This changes T36's shipped behavior (it was on) — framed as the trust fix this ticket is
  scoped to make. **← confirm**
- **D6 Guest isolation = opt-in `--copy [PATH]` working copy; default in-place.** Alternative:
  always-copy (safer, slower for big files, and it breaks the "run my own cartridge" keychain
  UX). **← confirm**
- **D7 Web import surfaces drift as a report line + warning banner, never a refusal** (the web
  tier doesn't execute the embedded host). **← confirm**
- **D8 v1 embeds Python only; Node/Datasette stay fog.** *(lean: yes)*

## 8. Implementation plan (after decisions lock)

**Phase A — stamping (web engine):** `?raw` import + export hook (§3.2) + `host_sha256`
manifest key + report line (§3.4). Tests: stamped export carries a valid `system_files` row
whose sha256 matches the build source; manifest key present; pre-T37 imports still work.

**Phase B — host (CLI):** self-check, fetch gate, `--copy`, report lines (§3.3). Tests via
the T36 spec pattern (Node spawns `python3`): corrupted body → refuse; clean body → boots;
fetch stubbed without flag / real with flag; `--copy` leaves original byte-identical
(hash-compare) and the copy carries the new turn.

**Phase C — verification + sign-off:** keychain one-liner on a freshly stamped export (the
headline demo); guest-mode probe (original untouched, turn lands in copy); full suite green;
AGY review pass (sign-off standard — trust-model code gets the second pair of eyes).

**Map update:** T37 entry with decisions + resolution; fog entry annotated.
