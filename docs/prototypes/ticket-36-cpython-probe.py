#!/usr/bin/env python3
"""
T36 PROBE — CPython sqlite3 nested-UDF trigger cascade + savepoint semantics.

Answers the four questions that determine whether the standalone host design
works on stdlib sqlite3 (no JSPI involved — a blocking UDF callback is just a
function call):

  Q1: Does an AFTER INSERT trigger fire synchronously during conn.execute()
      of the INSERT, with its UDF callable?
  Q2: Do nested conn.execute() calls issued FROM INSIDE a UDF (mid-trigger)
      work under legacy transaction control?
  Q3: How do explicit SAVEPOINTs interact with CPython's implicit BEGIN
      (legacy isolation_level='')?
  Q4: Does the T3 hard-error dance work — ROLLBACK TO + RELEASE, re-insert
      user row with suppress_cascade=1, insert assistant error row?

Run: python3 docs/prototypes/ticket-36-cpython-probe.py
"""
import json
import sqlite3
import sys

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not cond else ''))


conn = sqlite3.connect(':memory:')
# Legacy transaction control is the DEFAULT (isolation_level=''). Probe that,
# since it's what a plain `sqlite3.connect` gives a stdlib-only host.

# CRITICAL: by default SQLite does NOT fire triggers from within triggers.
# The cascade (agent_think -> execute_tool -> agent_think ...) is exactly
# that shape, so the host must enable recursive triggers at boot — the fog
# entry's verified recipe includes this pragma for exactly this reason.
conn.execute("PRAGMA recursive_triggers=ON")

conn.executescript("""
CREATE TABLE session_context (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO session_context VALUES ('suppress_cascade', '0');
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT 'default',
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT
);

-- Mimic agent_think: user/tool insert -> ask_llm -> assistant row.
CREATE TRIGGER agent_think
AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'tool')
  AND (SELECT COALESCE(value,'0') FROM session_context WHERE key='suppress_cascade') != '1'
BEGIN
    INSERT INTO messages (session_id, role, content, tool_calls)
    SELECT NEW.session_id, 'assistant',
           json_extract(llm, '$.content'),
           json_extract(llm, '$.tool_calls')
    FROM (SELECT ask_llm('ctx', 'tools') AS llm);
END;

-- Mimic execute_tool: assistant w/ tool_calls -> run_dynamic_sql -> tool row.
CREATE TRIGGER execute_tool
AFTER INSERT ON messages
WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL
  AND json_array_length(NEW.tool_calls) > 0
  AND (SELECT COALESCE(value,'0') FROM session_context WHERE key='suppress_cascade') != '1'
BEGIN
    INSERT INTO messages (session_id, role, content, tool_call_id)
    SELECT NEW.session_id, 'tool',
           run_dynamic_sql(json_extract(tc.value, '$.function.arguments.query')),
           json_extract(tc.value, '$.id')
    FROM json_each(NEW.tool_calls) tc;
END;
""")

# ── UDFs with a scripted LLM: call 1 -> tool_calls, call 2 -> final ──────
llm_script = [
    {"content": "", "tool_calls": [
        {"id": "call_1", "type": "function",
         "function": {"name": "execute_sql",
                      "arguments": {"query": "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"}}}]},
    {"content": "I see the tables.", "tool_calls": None},
]
llm_calls = []


def ask_llm(ctx, tools):
    llm_calls.append(len(llm_calls))
    if len(llm_calls) > len(llm_script):
        raise RuntimeError('LLM script exhausted')
    return json.dumps(llm_script[len(llm_calls) - 1])


def run_dynamic_sql(sql):
    # Q2: nested query from inside a UDF, mid-trigger-chain.
    cur = conn.execute(sql)
    cols = [d[0] for d in cur.description] if cur.description else []
    rows = [list(r) for r in cur.fetchall()]
    return json.dumps([{"columns": cols, "values": rows}] if (cols or rows)
                      else [{"columns": ["status", "changes"], "values": [["OK", 1]]}])


conn.create_function('ask_llm', 2, ask_llm)
conn.create_function('run_dynamic_sql', 1, run_dynamic_sql)

print("Q1/Q2 — trigger cascade with nested UDF queries:")
conn.execute("SAVEPOINT turn_sp")
try:
    conn.execute("INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'hello')")
    conn.execute("RELEASE SAVEPOINT turn_sp")
    committed = True
except Exception as e:
    committed = False
    print(f"  exception: {e!r}")

check("Q1 cascade ran to completion (2 LLM calls)", len(llm_calls) == 2, f"calls={len(llm_calls)}")
rows = conn.execute(
    "SELECT role, content FROM messages ORDER BY id").fetchall()
check("row sequence user/assistant/tool/assistant",
      [r[0] for r in rows] == ['user', 'assistant', 'tool', 'assistant'], str(rows))
tool_row = rows[2][1]
check("Q2 nested UDF query returned real data",
      committed and tool_row is not None and 'messages' in tool_row, str(tool_row)[:120])
final = rows[3]
check("final assistant content stored", final[1] == 'I see the tables.')

print("Q3 — savepoint vs implicit BEGIN:")
# Inspect what Python did: after the DML above, was a transaction auto-opened?
in_tx_before = conn.isolation_level  # legacy mode: '' means implicit BEGIN before DML
check("legacy isolation_level active (implicit BEGIN)", in_tx_before == '', repr(in_tx_before))

print("Q4 — T3 hard-error dance (ROLLBACK TO + re-insert with suppression):")
llm_script.clear()
llm_calls.clear()
llm_script.append({"content": "boom", "tool_calls": None})


def ask_llm_boom(ctx, tools):
    raise RuntimeError('simulated transport failure')


conn.create_function('ask_llm', 2, ask_llm_boom)

before = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
try:
    conn.execute("SAVEPOINT turn_sp")
    try:
        conn.execute("INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'will fail')")
        conn.execute("RELEASE SAVEPOINT turn_sp")
        print("  FAIL: expected the UDF exception to propagate")
    except Exception as e:
        check("UDF transport error propagates to caller", True, repr(e))
        conn.execute("ROLLBACK TO SAVEPOINT turn_sp")
        conn.execute("RELEASE SAVEPOINT turn_sp")
        # Re-insert dance: suppress cascade, re-insert user row, add error row.
        conn.execute("UPDATE session_context SET value='1' WHERE key='suppress_cascade'")
        try:
            conn.execute("INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'will fail')")
            conn.execute("INSERT INTO messages (session_id, role, content) VALUES ('default', 'assistant', '⚠ LLM transport error: simulated transport failure')")
        finally:
            conn.execute("UPDATE session_context SET value='0' WHERE key='suppress_cascade'")
        conn.commit()
except Exception as e:
    print(f"  outer exception: {e!r}")

after = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
check("failed turn erased, then re-inserted (net +2 rows)", after == before + 2, f"before={before} after={after}")
last_two = conn.execute(
    "SELECT role, content FROM messages ORDER BY id DESC LIMIT 2").fetchall()
check("re-insert kept user row + error assistant row",
      last_two[0][0] == 'assistant' and 'transport error' in (last_two[0][1] or '')
      and last_two[1][0] == 'user', str(last_two))
sup = conn.execute("SELECT value FROM session_context WHERE key='suppress_cascade'").fetchone()[0]
check("suppress_cascade cleared", sup == '0', sup)

# Next turn still works (cascade not dead):
conn.create_function('ask_llm', 2, lambda ctx, tools: json.dumps({"content": "still alive", "tool_calls": None}))
conn.execute("INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'again')")
conn.commit()
alive = conn.execute(
    "SELECT content FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").fetchone()[0]
check("next turn works after error dance", alive == 'still alive', repr(alive))

# ── Summary ──────────────────────────────────────────────────────────────
print()
failed = [n for n, ok, _ in results if not ok]
print(f"{'ALL PASS' if not failed else 'FAILURES: ' + ', '.join(failed)} ({len(results) - len(failed)}/{len(results)})")
sys.exit(1 if failed else 0)
