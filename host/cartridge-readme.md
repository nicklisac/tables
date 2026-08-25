# Tables Cartridge

This `.sqlite3` file is a **Tables cartridge** — a complete, self-contained
agent brain exported from the [Tables](https://github.com/nicklisac/tables)
web app: its data, conversation history, tools, system prompt, and the Python
host that runs it.

Project home (source, docs, issues): https://github.com/nicklisac/tables

## What is Tables?

Tables is a SQL workstation where an LLM agent lives *inside* your SQLite
database. The database **is** the app: its schema drives the agent's tools,
the conversation is stored as rows, and the whole thing exports to one file
you can carry anywhere — back into the web app, or onto any laptop with
Python 3 (no packages to install).

## Running this cartridge on your machine (Python 3, zero dependencies)

The file contains its own host. This one-liner extracts it from the file and
runs it:

```sh
python3 -c "import sqlite3;exec(sqlite3.connect('my-agent.sqlite3').execute(\"select body from system_files where name='tables.py'\").fetchone()[0])" my-agent.sqlite3 "What tables do I have?"
```

If you'd rather keep the host on disk, clone the repo and run it directly:

```sh
git clone https://github.com/nicklisac/tables.git
python3 tables/host/tables.py my-agent.sqlite3 "What tables do I have?"
```

Omit the message for an interactive REPL; piped input works too
(`echo "Summarize my data" | python3 … my-agent.sqlite3`).

### First run: guided setup (recommended)

This file carries the provider profiles saved in the web app that exported it
(the `llm_profiles` table — names, providers, endpoints, models). **API keys
never travel in the file** — you pair one on this machine once, and daily use
after that is a flagless one-liner:

```sh
python3 tables/host/tables.py --setup        # find the cartridge, pick a provider,
                                             # pair a key, verify the connection
python3 tables/host/tables.py "What tables do I have?"   # just works — no path needed
```

Setup stores the API key in your OS keychain (`keyring` package —
`pip install keyring`) or, when that isn't available, in an owner-only file at
`~/.config/tables/credentials.json`. It ends with a real connection test —
you only get "✓ works" when the endpoint actually answered. It also records
**this cartridge as your machine's default** (`~/.config/tables/config.json`,
next to the key), so daily runs need no path at all — pass a different file's
path explicitly to override it, or re-run `--setup` against another file to
move the default. The pointer is stored relative to `tables.py` *and*
absolute, so moving the folder that holds both keeps working (a stale
default fails loudly and names what it looked for). Re-run `--setup`
anymtime to change providers or keys.

### Setting up your API key and model (manual)

The host talks to any **OpenAI-compatible** chat-completions endpoint. Three
things are required — there are no defaults, so nothing is guessed:

| What     | Flag        | Env var(s)                                                |
|----------|-------------|-----------------------------------------------------------|
| Endpoint | `--llm-url` | `TABLES_LLM_URL`                                          |
| Model    | `--model`   | `TABLES_LLM_MODEL`                                        |
| API key  | `--api-key` | `TABLES_LLM_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY` |

If you omit the model, the host falls back to the one this cartridge was
exported with (the manifest's `recommended_model`) — if there is one;
otherwise it refuses to boot and tells you exactly what to set. The same
flags/env vars override the in-file config that `--setup` writes.

**Google Gemini (OpenAI-compatible endpoint):**

```sh
export TABLES_LLM_URL="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
export GEMINI_API_KEY="AIza…"            # or pass --api-key
python3 tables/host/tables.py my-agent.sqlite3 --model "your-gemini-model" "Hello?"
```

**Ollama (local, no key needed):**

```sh
python3 tables/host/tables.py my-agent.sqlite3 \
  --llm-url http://localhost:11434 --model llama3.2 "Hello?"
```

The endpoint URL is auto-healed: `http://localhost:11434`,
`http://localhost:11434/v1`, and the full
`http://localhost:11434/v1/chat/completions` all work identically.

**Web fetches:** the agent's `fetch_url` tool asks for your approval on every
call (`[y]es/[N]o/[a]ll-for-run`). For unattended runs, set
`TABLES_ALLOW_FETCH=1` to allow free fetches (loopback/private addresses are
still blocked).

## Using the web app instead

Open https://tables.nicholaslisac.com , click **[import]** and pick this file —
the agent, its history, and your data come back exactly as exported. Configure
your LLM provider under **[config]** in the header.

## Peeking inside (no Python needed)

```sh
sqlite3 my-agent.sqlite3 ".tables"
sqlite3 my-agent.sqlite3 "select body from system_files where name='README.md'"   # this document
```
