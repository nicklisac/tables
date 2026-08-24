# Tables

A local-first web SQL agent: the agent lives inside a SQLite database in the user's browser, and its entire state — conversations, data, identity — is that one database file.

## Language

**Tables**:
The product and the agent, as a proper noun.
_Avoid_: brain, assistant, app

**Tables database**:
The SQLite database holding all of Tables' state: conversations, user data tables, documents, dashboards, and the agent's identity. Also "Tables' database" when possession reads better.
_Avoid_: brain, brain DB, the DB (too generic in boundary discussions)

**Cartridge**:
An exported `.sqlite3` file of a Tables database — the portable guest artifact carrying the agent's identity + data. A `.sql` dump is not a cartridge.
_Avoid_: save file, export (as a noun for the file), dump

**Engine**:
The deployed build (JavaScript + SQL triggers) that boots and operates a Tables database.
_Avoid_: backend, runtime (collides with host-side "runtime config")

**Host / Guest**:
The ownership boundary for imports and standalone boots. The host is the machine/session supplying credentials, model/runtime config, and capabilities; the guest is the cartridge's identity + data.
_Avoid_: server/client (wrong connotation), source/target

**Boot**:
The engine taking over a Tables database at load: schema migrations, seed fills, and refresh of engine-owned surfaces.
_Avoid_: init, startup (in boundary discussions — "at boot" is the term of art)
