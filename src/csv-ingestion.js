/**
 * CSV & TABULAR INGESTION ENGINE
 *
 * Provides robust CSV parsing (via Papa Parse), automatic column type inference
 * (INTEGER, REAL, TEXT), identifier sanitization, safe CREATE TABLE generation,
 * and high-performance chunked batch INSERT into the SQLite WASM database.
 */

import Papa from 'papaparse';
import { isProtectedTable, ensureCaptureTriggers } from './schema.js';
import { renderMessages } from './chat-render.js';
import { flushArtifacts } from './artifact-pane.js';

/**
 * Escape an identifier (table name or column name) for SQLite using double quotes.
 * Internal double quotes are escaped by doubling them ("").
 * @param {string} name - Identifier name
 * @returns {string} Safe escaped identifier
 */
export function escapeIdentifier(name) {
  if (name === null || name === undefined) return '""';
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Sanitize a filename into a valid, safe SQLite table name.
 * Strips file extensions, replaces non-alphanumeric characters with underscores,
 * and ensures it doesn't start with a number.
 * @param {string} filename - Input filename or table name
 * @returns {string} Sanitized table name
 */
export function sanitizeTableName(filename) {
  if (!filename) return 'imported_table';
  // Strip file extension (.csv, .tsv, etc.)
  let name = String(filename).replace(/\.[^/.]+$/, '');
  // Replace non-alphanumeric characters with underscores
  name = name.replace(/[^a-zA-Z0-9_]/g, '_');
  // Collapse multiple underscores
  name = name.replace(/_+/g, '_');
  // Trim leading and trailing underscores
  name = name.replace(/^_+|_+$/g, '');
  // If starts with a digit, prefix with t_
  if (/^[0-9]/.test(name)) {
    name = `t_${name}`;
  }
  return name || 'imported_table';
}

/**
 * Sanitize a column header name.
 * @param {string} name - Raw column name
 * @param {number} index - Column index for fallback
 * @returns {string} Sanitized column name
 */
export function sanitizeColumnName(name, index = 0) {
  if (name === null || name === undefined || String(name).trim() === '') {
    return `col_${index + 1}`;
  }
  let clean = String(name).trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (/^[0-9]/.test(clean)) {
    clean = `col_${clean}`;
  }
  return clean || `col_${index + 1}`;
}

/**
 * Deduplicate column names to guarantee unique column names for CREATE TABLE.
 * @param {Array<string>} names - List of column names
 * @returns {Array<string>} List of unique sanitized column names
 */
export function makeUniqueColumnNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Map();
  return names.map((name, i) => {
    const clean = sanitizeColumnName(name, i);
    const count = seen.get(clean) || 0;
    seen.set(clean, count + 1);
    if (count > 0) {
      return `${clean}_${count + 1}`;
    }
    return clean;
  });
}

/**
 * Infer SQLite type for a single cell value.
 * Rules:
 *   - /^-?\d+$/ -> 'INTEGER'
 *   - valid numeric (floats, scientific notation) -> 'REAL'
 *   - empty / null / undefined -> null (does not constrain type)
 *   - anything else -> 'TEXT'
 *
 * @param {*} val - Cell value
 * @returns {'INTEGER'|'REAL'|'TEXT'|null}
 */
export function inferCellType(val) {
  if (val === null || val === undefined) return null;

  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) return 'TEXT';
    return Number.isInteger(val) ? 'INTEGER' : 'REAL';
  }

  if (typeof val === 'boolean') {
    return 'INTEGER';
  }

  const str = String(val).trim();
  if (str === '') return null;

  // Exact integer pattern: optional '-' followed only by digits
  if (/^-?\d+$/.test(str)) {
    return 'INTEGER';
  }

  // Floating point / numeric pattern (including scientific notation e.g. 1.23e-4)
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(str) && !isNaN(Number(str))) {
    return 'REAL';
  }

  return 'TEXT';
}

/**
 * Promote types along the chain: INTEGER -> REAL -> TEXT.
 * If either type is TEXT, result is TEXT.
 * If either type is REAL, result is REAL.
 * If both are INTEGER, result is INTEGER.
 * Null/undefined inputs do not alter the other type.
 *
 * @param {'INTEGER'|'REAL'|'TEXT'|null} current - Current accumulated type
 * @param {'INTEGER'|'REAL'|'TEXT'|null} newType - Candidate type from new cell
 * @returns {'INTEGER'|'REAL'|'TEXT'} Promoted type
 */
export function promoteType(current, newType) {
  if (!current) return newType || 'TEXT';
  if (!newType) return current || 'TEXT';
  if (current === 'TEXT' || newType === 'TEXT') return 'TEXT';
  if (current === 'REAL' || newType === 'REAL') return 'REAL';
  if (current === 'INTEGER' && newType === 'INTEGER') return 'INTEGER';
  return 'TEXT';
}

/**
 * Parse CSV headers and sample rows to infer column definitions and table schema.
 *
 * @param {File|Blob|string} file - File or Blob object or CSV text
 * @param {number} [sampleSize=1000] - Number of rows to sample for type inference
 * @returns {Promise<{tableName: string, columns: Array<{name: string, originalName: string, type: string}>, sampleRows: Array, totalSampled: number}>}
 */
export async function parseCsvWithSchema(file, sampleSize = 1000) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      preview: sampleSize + 1, // +1 for the header row
      skipEmptyLines: 'greedy',
      complete: (results) => {
        try {
          if (!results.data || results.data.length === 0) {
            throw new Error('CSV file is empty or could not be parsed.');
          }

          const rawHeaders = results.data[0];
          if (!rawHeaders || rawHeaders.length === 0) {
            throw new Error('CSV header row is empty.');
          }

          const cleanHeaders = makeUniqueColumnNames(rawHeaders);
          const dataRows = results.data.slice(1);

          // Infer types across sample rows
          const columnTypes = cleanHeaders.map(() => null);

          for (const row of dataRows) {
            for (let colIdx = 0; colIdx < cleanHeaders.length; colIdx++) {
              const cell = row[colIdx];
              const cellType = inferCellType(cell);
              if (cellType) {
                columnTypes[colIdx] = promoteType(columnTypes[colIdx], cellType);
              }
            }
          }

          // Any column that had only nulls or empty values defaults to TEXT
          const columns = cleanHeaders.map((name, i) => ({
            name,
            originalName: rawHeaders[i] || name,
            type: columnTypes[i] || 'TEXT',
          }));

          const fileName = file?.name || (typeof file === 'string' ? 'imported_table' : 'imported_table');
          const tableName = sanitizeTableName(fileName);

          resolve({
            tableName,
            columns,
            sampleRows: dataRows.slice(0, 10),
            totalSampled: dataRows.length,
          });
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Ingest a CSV file into SQLite WASM database.
 * Auto-infers types, creates the table in the current database, and batch-inserts
 * rows using prepared statements in transactions (chunks of 5000 rows).
 *
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {number} db - Database handle pointer
 * @param {File|Blob} file - CSV File or Blob object
 * @param {string} [tableName] - Optional custom table name (defaults to sanitized filename)
 * @param {Function} [onProgress] - Optional progress callback ({ rowsIngested, phase, tableName }) => void
 * @returns {Promise<{tableName: string, rowCount: number, columnCount: number, columns: Array<{name: string, type: string}>}>}
 */
export async function ingestCsvToSqlite(sqlite3, db, file, tableName = null, onProgress = null) {
  // Step 1: Infer schema from sample rows
  const schema = await parseCsvWithSchema(file);
  let targetTableName = tableName ? sanitizeTableName(tableName) : schema.tableName;
  if (isProtectedTable(targetTableName)) {
    targetTableName = `imported_${targetTableName}`;
  }
  const { columns } = schema;

  if (!columns || columns.length === 0) {
    throw new Error('No columns found in CSV file.');
  }

  if (onProgress) {
    onProgress({
      rowsIngested: 0,
      phase: 'schema_inferred',
      tableName: targetTableName,
      columns,
    });
  }

  // Step 2: Generate and execute CREATE TABLE
  const escapedTable = escapeIdentifier(targetTableName);
  const colDefs = columns.map(c => `${escapeIdentifier(c.name)} ${c.type}`).join(', ');

  await sqlite3.exec(db, `DROP TABLE IF EXISTS ${escapedTable};`);
  await sqlite3.exec(db, `CREATE TABLE ${escapedTable} (${colDefs});`);

  // Step 3: Prepare batch INSERT statement
  const colNames = columns.map(c => escapeIdentifier(c.name)).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${escapedTable} (${colNames}) VALUES (${placeholders});`;

  let totalRows = 0;
  const BATCH_SIZE = 5000;

  for await (const stmt of sqlite3.statements(db, insertSql)) {
    let isFirstRow = true;
    let inTransaction = false;
    let batchCount = 0;

    await sqlite3.exec(db, 'BEGIN TRANSACTION;');
    inTransaction = true;

    try {
      await new Promise((resolve, reject) => {
        Papa.parse(file, {
          skipEmptyLines: 'greedy',
          chunkSize: 1024 * 1024, // 1MB chunks
          chunk: async (results, parser) => {
            parser.pause();
            try {
              const rows = results.data;
              let startIdx = 0;
              if (isFirstRow) {
                isFirstRow = false;
                startIdx = 1; // Skip header row in first chunk
              }

              for (let r = startIdx; r < rows.length; r++) {
                const row = rows[r];
                if (!row || row.length === 0 || (row.length === 1 && row[0] === '')) continue;

                const boundValues = [];
                for (let c = 0; c < columns.length; c++) {
                  const val = row[c];
                  const colType = columns[c].type;

                  if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
                    boundValues.push(null);
                  } else if (colType === 'INTEGER') {
                    const trimmed = typeof val === 'string' ? val.trim() : val;
                    const num = Number(trimmed);
                    boundValues.push(!isNaN(num) && Number.isFinite(num) ? Math.trunc(num) : trimmed);
                  } else if (colType === 'REAL') {
                    const trimmed = typeof val === 'string' ? val.trim() : val;
                    const num = Number(trimmed);
                    boundValues.push(!isNaN(num) && Number.isFinite(num) ? num : trimmed);
                  } else {
                    boundValues.push(typeof val === 'string' ? val : String(val));
                  }
                }

                sqlite3.bind_collection(stmt, boundValues);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);

                totalRows++;
                batchCount++;

                if (batchCount >= BATCH_SIZE) {
                  await sqlite3.exec(db, 'COMMIT;');
                  await sqlite3.exec(db, 'BEGIN TRANSACTION;');
                  batchCount = 0;
                  if (onProgress) {
                    onProgress({
                      rowsIngested: totalRows,
                      phase: 'inserting',
                      tableName: targetTableName,
                    });
                  }
                }
              }

              if (onProgress) {
                onProgress({
                  rowsIngested: totalRows,
                  phase: 'inserting',
                  tableName: targetTableName,
                });
              }

              parser.resume();
            } catch (err) {
              parser.abort();
              reject(err);
            }
          },
          complete: () => {
            resolve();
          },
          error: (err) => {
            reject(err);
          },
        });
      });

      if (inTransaction) {
        await sqlite3.exec(db, 'COMMIT;');
        inTransaction = false;
      }
    } catch (err) {
      if (inTransaction) {
        try { await sqlite3.exec(db, 'ROLLBACK;'); } catch {}
      }
      throw err;
    }
  }

  if (onProgress) {
    onProgress({
      rowsIngested: totalRows,
      phase: 'complete',
      tableName: targetTableName,
      columnCount: columns.length,
      columns,
    });
  }

  return {
    tableName: targetTableName,
    rowCount: totalRows,
    columnCount: columns.length,
    columns,
  };
}

// ── CSV Ingestion & Drag-and-Drop UI ────────────────────────────────
//
// [T26.3: moved verbatim from main.js. main.js passes its mutable state and
// cross-module callbacks via initCsvUi() — no behavior change.]

let csvCtx = null;
let dragCounter = 0;

const chatContainer     = document.getElementById('chat-container');
const dragOverlay       = document.getElementById('drag-overlay');
const ingestionProgress = document.getElementById('ingestion-progress');
const progressTitle     = document.getElementById('progress-title');
const progressCount     = document.getElementById('progress-count');
const progressBarFill   = document.getElementById('progress-bar-fill');
const btnUploadCsv      = document.getElementById('btn-upload-csv');
const csvFileInput      = document.getElementById('csv-file-input');
const inputEl           = document.getElementById('user-input');
const sendBtn           = document.getElementById('send-btn');
const statusBar         = document.getElementById('status-bar');

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {() => string} context.getSessionId - active session id
 * @param {() => boolean} context.isBusy - true while a turn is in flight (chat-render.js)
 * @param {(on: boolean) => void} context.setLoading - processing-state setter (chat-render.js)
 */
export function initCsvUi(context) {
  csvCtx = context;

  function showDragOverlay() {
    if (dragOverlay) dragOverlay.classList.remove('hidden');
  }

  function hideDragOverlay() {
    if (dragOverlay) dragOverlay.classList.add('hidden');
  }

  function showIngestionProgress(fileName) {
    if (!ingestionProgress) return;
    ingestionProgress.classList.remove('hidden');
    if (progressTitle) progressTitle.textContent = `Ingesting ${fileName}…`;
    if (progressCount) progressCount.textContent = 'Parsing schema…';
    if (progressBarFill) {
      progressBarFill.className = 'progress-bar-fill indeterminate';
      progressBarFill.style.width = '100%';
    }
  }

  function hideIngestionProgress() {
    if (!ingestionProgress) return;
    ingestionProgress.classList.add('hidden');
    if (progressBarFill) {
      progressBarFill.className = 'progress-bar-fill';
      progressBarFill.style.width = '0%';
    }
  }

  async function handleCsvUpload(file) {
    if (!file) return;
    if (csvCtx.isBusy()) {
      alert('Please wait for the current turn to finish before uploading a CSV.');
      return;
    }
    const agent = csvCtx.getAgent();
    if (!agent) {
      alert('Agent is still initializing. Please wait a moment.');
      return;
    }

    const isCsv = file.name.toLowerCase().endsWith('.csv') ||
                  file.name.toLowerCase().endsWith('.tsv') ||
                  file.name.toLowerCase().endsWith('.txt') ||
                  file.type === 'text/csv' ||
                  file.type === 'text/plain';

    if (!isCsv) {
      alert('Please select a valid CSV or tabular data file.');
      return;
    }

    showIngestionProgress(file.name);
    csvCtx.setLoading(true);
    statusBar.textContent = `Ingesting ${file.name}…`;
    statusBar.style.color = '#d29922';

    try {
      const result = await ingestCsvToSqlite(
        agent.sqlite3,
        agent.db,
        file,
        null,
        (progress) => {
          if (progress.phase === 'schema_inferred') {
            if (progressTitle) progressTitle.textContent = `Ingesting "${progress.tableName}"…`;
            if (progressCount) progressCount.textContent = `Inferred ${progress.columns?.length || 0} cols`;
          } else if (progress.phase === 'inserting') {
            if (progressTitle) progressTitle.textContent = `Ingesting "${progress.tableName}"…`;
            if (progressCount) progressCount.textContent = `${progress.rowsIngested.toLocaleString()} rows`;
          } else if (progress.phase === 'complete') {
            if (progressTitle) progressTitle.textContent = `✓ Ingested "${progress.tableName}"`;
            if (progressCount) progressCount.textContent = `${progress.rowsIngested.toLocaleString()} rows`;
            if (progressBarFill) {
              progressBarFill.className = 'progress-bar-fill';
              progressBarFill.style.width = '100%';
            }
          }
        }
      );

      // T3: attach row-image capture triggers to the new table so its changes
      // are rewound-able.
      try {
        await ensureCaptureTriggers(agent.sqlite3, agent.db, result.tableName);
      } catch (e) {
        console.warn('[csv-ingestion] Failed to attach capture triggers:', e);
      }

      setTimeout(() => {
        hideIngestionProgress();
      }, 1500);

      statusBar.textContent = `✓ Ingested table "${result.tableName}" (${result.rowCount.toLocaleString()} rows, ${result.columnCount} cols)`;
      statusBar.style.color = '#3fb950';

      // Insert confirmation assistant message into SQLite messages table for the active session
      const colList = result.columns.map(c => `• \`${c.name}\` (${c.type})`).join('\n');
      const notification = `📊 **Table Ingested: \`${result.tableName}\`**\n\n` +
        `- **Rows:** ${result.rowCount.toLocaleString()}\n` +
        `- **Columns (${result.columnCount}):**\n${colList}\n\n` +
        `The table is now queryable via SQL. Try asking:\n` +
        `• *"Show me the first 5 rows of ${result.tableName}"*\n` +
        `• *"What are the summary statistics for ${result.tableName}?"*`;

      for await (const stmt of agent.sqlite3.statements(
        agent.db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`
      )) {
        agent.sqlite3.bind_collection(stmt, [csvCtx.getSessionId(), notification]);
        await agent.sqlite3.step(stmt);
      }

      await renderMessages();
    } catch (err) {
      console.error('[csv-ingestion] Ingestion failed:', err);
      hideIngestionProgress();
      statusBar.textContent = `⚠ Ingestion failed: ${err.message}`;
      statusBar.style.color = '#f85149';

      const errorNotification = `⚠ **Failed to ingest CSV "${file.name}"**\n\nError: ${err.message}`;
      for await (const stmt of agent.sqlite3.statements(
        agent.db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`
      )) {
        agent.sqlite3.bind_collection(stmt, [csvCtx.getSessionId(), errorNotification]);
        await agent.sqlite3.step(stmt);
      }
      await renderMessages();
    } finally {
      csvCtx.setLoading(false);
      // Re-run artifacts whose data tables changed (new/updated table).
      try { await flushArtifacts(); } catch (e) { console.warn('[csv] artifact flush failed (non-fatal):', e); }
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // Drag and drop event listeners
  if (chatContainer) {
    chatContainer.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        showDragOverlay();
      }
    });

    chatContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    chatContainer.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        hideDragOverlay();
      }
    });

    chatContainer.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      hideDragOverlay();

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        await handleCsvUpload(files[0]);
      }
    });
  }

  // Window level drag prevention so browser doesn't open dropped file in tab
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  // CSV Upload button handler
  if (btnUploadCsv && csvFileInput) {
    btnUploadCsv.addEventListener('click', () => {
      csvFileInput.click();
    });

    csvFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await handleCsvUpload(file);
        csvFileInput.value = '';
      }
    });
  }
}
