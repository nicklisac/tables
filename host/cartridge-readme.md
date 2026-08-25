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

### Setting up your API key and model

The host talks to any **OpenAI-compatible** chat-completions endpoint. Three
things are required — there are no defaults, so nothing is guessed:

| What     | Flag        | Env var(s)                                                |
|----------|-------------|-----------------------------------------------------------|
| Endpoint | `--llm-url` | `TABLES_LLM_URL`                                          |
| Model    | `--model`   | `TABLES_LLM_MODEL`                                        |
| API key  | `--api-key` | `TABLES_LLM_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY` |

If you omit the model, the host falls back to the one this cartridge was
exported with (the manifest's `recommended_model`) — if there is one;
otherwise it refuses to boot and tells you exactly what to set.

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
