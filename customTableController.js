const asyncHandler = require("../middleware/async");
const db = require("../db/index");
const { Client } = require("pg");
const axios = require("axios");
const crypto = require("crypto");
const { ENV_CONFIG } = require("../env-config");

const TENANT_ID = 1;

const getSecretKey = () =>
  crypto
    .createHash("sha256")
    .update(String(ENV_CONFIG.JWT_SECRET || "custom-table-secret"))
    .digest();

// Encrypt a plain password/secret for storage in connection.secret_ref.
const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const enc = Buffer.concat([
    cipher.update(String(plain || ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
};

// Decrypt a secret_ref value back to the original password/secret string.
const decryptSecret = (stored) => {
  const raw = String(stored || "");
  if (!raw.startsWith("enc:")) return null;
  const parts = raw.split(":");
  if (parts.length !== 4) return null;
  try {
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const data = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch (_) {
    return null;
  }
};

// Build a short UI label for a connection from its config (host/db or base URL).
const connectionTarget = (config) => {
  if (!config) return "";
  if (config.base_url || config.sql_url)
    return String(config.base_url || config.sql_url);
  const host = config.host || "";
  const database = config.database || "";
  const dbType = config.db_type || "PostgreSQL";
  return `${dbType} · ${host}${database ? ` / ${database}` : ""}`;
};

// Join a base URL and path without duplicating or dropping slashes.
const joinUrl = (baseUrl, path) => {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path || "").trim();
  if (!p) return base;
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
};

// Build default + custom + auth headers for a non-OAuth API call.
const buildApiHeaders = (config, secretObj) => {
  const headers = { Accept: "application/json" };
  (config.headers || []).forEach((h) => {
    const key = String(h?.key || h?.name || "").trim();
    if (key) headers[key] = h?.value == null ? "" : String(h.value);
  });
  const authType = config.auth_type || "none";
  const secret = secretObj || {};
  if (authType === "api_key" && secret.apiKey) {
    headers[String(config.header_name || "X-API-Key")] = secret.apiKey;
  } else if (authType === "bearer" && secret.token) {
    headers.Authorization = `Bearer ${secret.token}`;
  } else if (authType === "basic" && secret.basicUser) {
    headers.Authorization = `Basic ${Buffer.from(`${secret.basicUser}:${secret.basicPassword || ""}`).toString("base64")}`;
  }
  return headers;
};

// Request an OAuth2 access token (client_credentials or password grant).
const fetchOAuth2AccessToken = async (config, secretObj) => {
  const secret = secretObj || {};
  const tokenUrl = String(config.token_url || "").trim();
  const clientId = String(secret.clientId || "").trim();
  const clientSecret = String(secret.clientSecret || "");
  const grantType =
    String(config.oauth_grant_type || "").trim() === "password"
      ? "password"
      : "client_credentials";
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error(
      "OAuth2 token URL, client ID, and client secret are required",
    );
  }
  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("grant_type", grantType);
  if (grantType === "password") {
    const username = String(secret.oauthUsername || "").trim();
    const password = String(secret.oauthPassword || "");
    if (!username || !password) {
      throw new Error(
        "OAuth2 username and password are required for the password grant",
      );
    }
    params.append("username", username);
    params.append("password", password);
  }
  const scope = String(config.oauth_scope || "").trim();
  if (scope) params.append("scope", scope);

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const detail =
      response.data?.error_description || response.data?.error || "";
    throw new Error(
      detail
        ? `OAuth2 token request failed (HTTP ${response.status}): ${detail}`
        : `OAuth2 token request failed (HTTP ${response.status})`,
    );
  }
  const accessToken = response.data?.access_token;
  if (!accessToken)
    throw new Error("OAuth2 response did not include access_token");
  return accessToken;
};

// Build API headers and, for OAuth2, attach a fresh Bearer access token.
const resolveApiHeaders = async (config, secretObj) => {
  const headers = buildApiHeaders(config, secretObj);
  if ((config.auth_type || "none") === "oauth2") {
    const accessToken = await fetchOAuth2AccessToken(config, secretObj);
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
};

// Legacy marker from older Invex-only tables (path was not a real URL segment).
const LEGACY_INVEX_SQL_PATH_MARKER = "__invex_sql__";

// Body may be JSON (REST) or a raw SQL string (Invex /api/sql style → { sql: "…" }).
const parseApiRequestBody = (bodyRaw) => {
  const raw = String(bodyRaw || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { sql: raw };
  }
};

// Prefer common list keys (Data/data/rows/…) when walking a response object.
const extractCommonRowArrays = (payload) => {
  if (Array.isArray(payload)) {
    if (!payload.length) return [];
    if (
      payload.every(
        (row) => row && typeof row === "object" && !Array.isArray(row),
      )
    )
      return payload;
    return [];
  }
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.Data,
    payload.data,
    payload.Rows,
    payload.rows,
    payload.Records,
    payload.records,
    payload.result,
    payload.Result,
    payload.results,
    payload.Results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (!candidate.length) return [];
      if (
        candidate.every(
          (row) => row && typeof row === "object" && !Array.isArray(row),
        )
      ) {
        return candidate;
      }
      const cols =
        payload.columns || payload.Columns || payload.fields || payload.Fields;
      if (Array.isArray(cols) && candidate.every((row) => Array.isArray(row))) {
        const names = cols
          .map((c) => (typeof c === "string" ? c : c?.name || c?.Name || ""))
          .filter(Boolean);
        if (names.length) {
          return candidate.map((cells) => {
            const obj = {};
            names.forEach((name, i) => {
              obj[name] = cells[i] == null ? "" : cells[i];
            });
            return obj;
          });
        }
      }
    }
  }
  return [];
};

// Walk records_path when set; otherwise fall back to Data/data/rows or the payload itself.
const extractApiRecords = (payload, recordsPath) => {
  const path = String(recordsPath || "").trim();
  if (path) {
    let cur = payload;
    path.split(".").forEach((part) => {
      if (cur != null && typeof cur === "object") cur = cur[part];
      else cur = undefined;
    });
    if (Array.isArray(cur)) return cur;
    if (cur && typeof cur === "object") return [cur];
    // Path set but missing (e.g. "Data" on a top-level array) → fall through.
  }
  const smart = extractCommonRowArrays(payload);
  if (smart.length) return smart;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  return [];
};

// Normalize [{ key, value }] from UI/DB into a plain params object for axios.
const normalizeQueryParams = (list) => {
  const out = {};
  (Array.isArray(list) ? list : []).forEach((row) => {
    const key = String(row?.key || row?.name || "").trim();
    if (!key) return;
    out[key] = row?.value == null ? "" : String(row.value);
  });
  return out;
};

// Flatten one API/JSON row for the grid. Unwrap Acumatica-style { value: … } fields.
const flattenApiRow = (row) => {
  const out = {};
  Object.keys(row || {}).forEach((key) => {
    const value = row[key];
    if (value == null) {
      out[key] = "";
      return;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "value")
    ) {
      const inner = value.value;
      if (inner == null) out[key] = "";
      else if (typeof inner === "object") out[key] = JSON.stringify(inner);
      else out[key] = inner;
      return;
    }
    if (typeof value === "object") out[key] = JSON.stringify(value);
    else out[key] = value;
  });
  return out;
};

// Load a saved SQL connection and decrypt its password for a live pg Client.
const loadSqlConnection = async (connectionId) => {
  const result = await db.query(
    `SELECT id, name, kind, config, secret_ref, fingerprint, last_status, last_tested_at, last_message
         FROM public.connection
         WHERE id = $1 AND tenant_id = $2 AND kind = 'sql'
         LIMIT 1`,
    [connectionId, TENANT_ID],
  );
  const row = result.rows[0];
  if (!row) return null;
  const config =
    typeof row.config === "string" ? JSON.parse(row.config) : row.config || {};
  const password = decryptSecret(row.secret_ref);
  return { row, config, password };
};

// Create a Postgres client for a live ERP (SQL) connection test/query.
const makeErpClient = ({ host, port, database, user, password }) =>
  new Client({
    host: String(host || "").trim(),
    port: Number(port),
    database: String(database || "").trim(),
    user: String(user || "").trim(),
    password: String(password || ""),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

// Screen labels  ->  values stored in public.ref_column.data_type
const UI_TO_DB_TYPE = {
  Text: "text",
  Number: "number",
  Decimal: "decimal",
  Currency: "currency",
  Date: "date",
  "Yes / No": "boolean",
};

const DB_TO_UI_TYPE = {
  text: "Text",
  number: "Number",
  decimal: "Decimal",
  currency: "Currency",
  date: "Date",
  boolean: "Yes / No",
};

// public.ref_table.source_type  ->  what the list page already expects
const DB_SOURCE_TO_UI = {
  file: "upload",
  sql: "erp",
  api: "api",
  manual: "manual",
};

const DB_MODE_TO_UI = {
  stored: "stored",
  sync: "daily_sync",
  live: "live",
};

const SRC_TYPE_LABEL = {
  manual: "Manual",
  erp: "ERP database",
  api: "API",
  upload: "CSV upload",
};

const DATA_MODE_LABEL = {
  stored: "Stored",
  daily_sync: "Daily sync",
  hourly_sync: "Hourly sync",
  live: "Live",
};

// Map create-sidebar refresh choice (live / nightly / hourly) to DB refresh_mode + schedule.
const resolveRefreshMode = (dbSource, requestedMode) => {
  if (dbSource === "file" || dbSource === "manual") {
    return { refreshMode: "stored", syncSchedule: null };
  }
  const mode = String(requestedMode || "live")
    .trim()
    .toLowerCase();
  if (
    mode === "nightly" ||
    mode === "daily" ||
    mode === "daily_sync" ||
    mode === "sync"
  ) {
    return { refreshMode: "sync", syncSchedule: "nightly" };
  }
  if (mode === "hourly" || mode === "hourly_sync") {
    return { refreshMode: "sync", syncSchedule: "hourly" };
  }
  return { refreshMode: "live", syncSchedule: null };
};

// Map UI source id (upload/erp/api/manual) to public.ref_table.source_type.
const uiSourceToDb = (value) => {
  const raw = String(value || "upload")
    .trim()
    .toLowerCase();
  if (raw === "manual" || raw === "type it in") return "manual";
  if (raw === "erp" || raw === "erp database" || raw === "sql") return "sql";
  if (raw === "api") return "api";
  return "file";
};

// Turn a display name into a safe lowercase SQL field_key.
const sanitizeIdentifier = (value, fallback = "col") => {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const safe = cleaned || fallback;
  return /^[a-z_]/.test(safe) ? safe.slice(0, 60) : `c_${safe}`.slice(0, 60);
};

// Ensure each column gets a unique field_key (append _2, _3, … on clashes).
const uniqueSqlNames = (names) => {
  const used = new Set();
  return names.map((name, index) => {
    let base = sanitizeIdentifier(name, `col_${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`.slice(0, 60);
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
};

// Coerce a cell value to the column UI type (Yes/No, Number, Date, or text).
const castCellValue = (value, type) => {
  if (value === null || value === undefined || value === "") return null;
  if (type === "Yes / No") {
    const normalized = String(value).trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
    return null;
  }
  if (type === "Number" || type === "Decimal" || type === "Currency") {
    const cleaned = String(value).replace(/,/g, "").trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  if (type === "Date") {
    const raw = String(value).trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime()))
      return parsed.toISOString().slice(0, 10);
    return raw;
  }
  return String(value);
};

// Map a ref_table DB row into the list/detail shape CustomTable.js expects.
const toClientTable = (row) => {
  const srcType = DB_SOURCE_TO_UI[row.source_type] || row.source_type;
  let dataMode = DB_MODE_TO_UI[row.refresh_mode] || "stored";
  if (
    row.refresh_mode === "sync" &&
    String(row.sync_schedule || "").toLowerCase() === "hourly"
  ) {
    dataMode = "hourly_sync";
  }
  return {
    tbl_id: row.id,
    tbl_nm: row.name,
    tbl_desc: row.description,
    src_type: srcType,
    src_type_label: SRC_TYPE_LABEL[srcType] || srcType,
    src_dtl: row.src_dtl || null,
    data_mode: dataMode,
    data_mode_label: DATA_MODE_LABEL[dataMode] || dataMode,
    col_cnt: Number(row.col_cnt || 0),
    row_cnt: row.row_count,
    updt_on: row.updated_at,
  };
};

// Build ref_row.row_key from Unique ID columns (or fallback) for uniqueness.
const buildRowKey = (columns, data, fallback) => {
  const keys = columns.filter((col) => col.uniqueId);
  const parts = (keys.length ? keys : []).map((col) => {
    const value = data[col.sqlName];
    return value == null || value === "" ? "" : String(value);
  });
  const joined = parts.filter((part) => part !== "").join("|");
  return joined || fallback;
};

// Load one table’s list/meta fields by id (or null if missing).
const getMetaById = async (tblId) => {
  const result = await db.query(
    `SELECT t.id, t.name, t.description, t.source_type, t.refresh_mode, t.sync_schedule, t.row_count, t.updated_at,
                (SELECT COUNT(*) FROM public.ref_column c WHERE c.table_id = t.id) AS col_cnt,
                COALESCE(
                  (SELECT f.file_name FROM public.ref_file_import f
                    WHERE f.table_id = t.id ORDER BY f.id DESC LIMIT 1),
                  (SELECT c.name FROM public.connection c WHERE c.id = t.connection_id)
                ) AS src_dtl
         FROM public.ref_table t
         WHERE t.id = $1`,
    [tblId],
  );
  return result.rows?.[0] ? toClientTable(result.rows[0]) : null;
};

// Load column definitions for the data/lookup grids from public.ref_column.
const getStudioColumns = async (tableId) => {
  const result = await db.query(
    `SELECT field_key, display_name, data_type, is_key, source_field
         FROM public.ref_column
         WHERE table_id = $1
         ORDER BY sort_order ASC, field_key ASC`,
    [tableId],
  );
  return (result.rows || []).map((col) => ({
    name: col.display_name || col.field_key,
    sqlName: col.field_key,
    type: DB_TO_UI_TYPE[col.data_type] || "Text",
    uniqueId: col.is_key === true,
    sourceField: col.source_field || null,
  }));
};

// Spread stored ref_row JSON data into a flat object for the grid (_row_id + fields).
const flattenRow = (row) => ({
  _row_id: row.id,
  ...(row.data || {}),
});

// Run the table’s saved ERP SELECT live and map rows to studio columns (nothing stored).
const fetchLiveErpRows = async (tableId) => {
  const tableRes = await db.query(
    `SELECT id, connection_id, source_type, refresh_mode
         FROM public.ref_table WHERE id = $1`,
    [tableId],
  );
  const table = tableRes.rows[0];
  if (!table || table.source_type !== "sql" || !table.connection_id) {
    throw new Error("ERP table or connection not found");
  }

  const sqlRes = await db.query(
    `SELECT query_text, max_rows FROM public.ref_sql_source WHERE table_id = $1`,
    [tableId],
  );
  const sqlRow = sqlRes.rows[0];
  if (!sqlRow?.query_text) {
    throw new Error("No SQL query saved for this table");
  }

  const loaded = await loadSqlConnection(table.connection_id);
  if (!loaded) {
    throw new Error("Saved ERP connection not found");
  }
  if (!loaded.password) {
    throw new Error(
      "This connection has no saved password. Add it again with a password.",
    );
  }

  const columns = await getStudioColumns(tableId);
  let client = null;
  try {
    client = makeErpClient({
      host: loaded.config.host,
      port: loaded.config.port,
      database: loaded.config.database,
      user: loaded.config.username,
      password: loaded.password,
    });
    await client.connect();
    const result = await client.query(sqlRow.query_text);
    await client.end();
    client = null;

    const maxRows = Number(sqlRow.max_rows) || 5000;
    const sourceRows = (result.rows || []).slice(0, maxRows);
    const rows = sourceRows.map((sourceRow, index) => {
      const flat = { _row_id: `live-${index + 1}` };
      columns.forEach((col) => {
        const header = col.sourceField || col.sqlName;
        const raw =
          sourceRow[header] !== undefined
            ? sourceRow[header]
            : sourceRow[col.sqlName] !== undefined
              ? sourceRow[col.sqlName]
              : null;
        flat[col.sqlName] = castCellValue(raw, col.type);
      });
      return flat;
    });

    return { columns, rows };
  } catch (err) {
    try {
      if (client) await client.end();
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
};

// Load a saved API connection and decrypt its secret payload (tokens/OAuth/etc.).
const loadApiConnection = async (connectionId) => {
  const result = await db.query(
    `SELECT id, name, kind, config, secret_ref, fingerprint, last_status
         FROM public.connection
         WHERE id = $1 AND tenant_id = $2 AND kind = 'api'
         LIMIT 1`,
    [connectionId, TENANT_ID],
  );
  const row = result.rows[0];
  if (!row) return null;
  const config =
    typeof row.config === "string" ? JSON.parse(row.config) : row.config || {};
  let secret = {};
  try {
    secret = JSON.parse(decryptSecret(row.secret_ref) || "{}");
  } catch (_) {
    secret = {};
  }
  return { row, config, secret };
};

// Run the table’s saved API request live and map rows to studio columns (nothing stored).
const fetchLiveApiRows = async (tableId) => {
  const tableRes = await db.query(
    `SELECT id, connection_id, source_type FROM public.ref_table WHERE id = $1`,
    [tableId],
  );
  const table = tableRes.rows[0];
  if (!table || table.source_type !== "api" || !table.connection_id) {
    throw new Error("API table or connection not found");
  }
  const src = await db.query(
    `SELECT http_method, path_template, query_params, body_template, records_path, timeout_ms
         FROM public.ref_api_source WHERE table_id = $1`,
    [tableId],
  );
  const apiSrc = src.rows[0];
  if (!apiSrc) throw new Error("No API request saved for this table");

  const loaded = await loadApiConnection(table.connection_id);
  if (!loaded) throw new Error("Saved API connection not found");

  const columns = await getStudioColumns(tableId);
  const maxRows = 5000;
  const pathTemplate = String(apiSrc.path_template || "").trim();
  const isLegacyInvex = pathTemplate === LEGACY_INVEX_SQL_PATH_MARKER;
  const method = String(
    apiSrc.http_method || (isLegacyInvex ? "POST" : "GET"),
  ).toUpperCase();
  const baseUrl = String(
    loaded.config.sql_url || loaded.config.base_url || "",
  ).trim();
  const url = isLegacyInvex
    ? baseUrl.replace(/\/+$/, "")
    : joinUrl(loaded.config.base_url, pathTemplate || "");
  if (!url) throw new Error("API URL is missing on this connection");

  const headers = await resolveApiHeaders(loaded.config, loaded.secret);
  const queryParams = normalizeQueryParams(apiSrc.query_params);
  const axiosCfg = {
    method,
    url,
    headers,
    timeout: Number(apiSrc.timeout_ms) || 60000,
    validateStatus: () => true,
  };
  if (Object.keys(queryParams).length) axiosCfg.params = queryParams;
  if (method === "POST") {
    headers["Content-Type"] =
      headers["Content-Type"] || headers["content-type"] || "application/json";
    axiosCfg.data = parseApiRequestBody(apiSrc.body_template);
  }
  const response = await axios(axiosCfg);
  if (response.status < 200 || response.status >= 300) {
    const detail = formatApiErrorDetail(response.data);
    throw new Error(
      detail
        ? `API returned HTTP ${response.status}: ${detail}`
        : `API returned HTTP ${response.status}`,
    );
  }
  const records = extractApiRecords(response.data, apiSrc.records_path).slice(
    0,
    maxRows,
  );
  const rows = records.map((rec, index) => {
    const flatSource = flattenApiRow(rec);
    const flat = { _row_id: `live-${index + 1}` };
    columns.forEach((col) => {
      const header = col.sourceField || col.sqlName;
      const raw =
        flatSource[header] !== undefined
          ? flatSource[header]
          : flatSource[col.sqlName];
      flat[col.sqlName] = castCellValue(raw, col.type);
    });
    return flat;
  });
  return { columns, rows };
};

// Keep only lookup conditions that have a field and a non-blank value (blank = ignore).
const activeLookupConditions = (conditions, allowed) =>
  (Array.isArray(conditions) ? conditions : []).filter((cond) => {
    const field = String(cond?.field || "").trim();
    const value = cond?.value == null ? "" : String(cond.value).trim();
    return field && value !== "" && (!allowed || allowed.has(field));
  });

// Return true if a live/in-memory row matches all active lookup conditions.
const rowMatchesConditions = (row, conditions, allowed) => {
  const active = activeLookupConditions(conditions, allowed);
  if (!active.length) return true;
  return active.every((cond) => {
    const field = String(cond?.field || "").trim();
    const op = String(cond?.op || "=").trim();
    const cell = row[field] == null ? "" : String(row[field]);
    const value = String(cond.value).trim();
    if (op === "contains") {
      return cell.toLowerCase().includes(value.toLowerCase());
    }
    if (op === "!=") {
      return cell !== value;
    }
    return cell === value;
  });
};

const getErpConnections = asyncHandler(async (req, res) => {
  try {
    const kind =
      String(req.query?.kind || "sql")
        .trim()
        .toLowerCase() === "api"
        ? "api"
        : "sql";
    const result = await db.query(
      `SELECT id, name, kind, config, last_tested_at, last_status, last_message, fingerprint
             FROM public.connection
             WHERE tenant_id = $1 AND kind = $2
             ORDER BY
               CASE WHEN last_status = 'ok' THEN 0 ELSE 1 END,
               last_tested_at DESC NULLS LAST,
               id DESC`,
      [TENANT_ID, kind],
    );
    const data = (result.rows || []).map((row) => {
      const config =
        typeof row.config === "string"
          ? JSON.parse(row.config)
          : row.config || {};
      if (kind === "api") {
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          baseUrl: config.base_url || config.sql_url || "",
          testPath: config.test_path || "",
          authType: config.auth_type || "none",
          headerName: config.header_name || "X-API-Key",
          headers: Array.isArray(config.headers) ? config.headers : [],
          target: connectionTarget(config),
          last_status: row.last_status,
          last_tested_at: row.last_tested_at,
          last_message: row.last_message,
          fingerprint: row.fingerprint,
        };
      }
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        dbType: config.db_type || "PostgreSQL",
        host: config.host || "",
        port: config.port != null ? String(config.port) : "",
        database: config.database || "",
        user: config.username || "",
        ssl: config.ssl || "require",
        target: connectionTarget(config),
        last_status: row.last_status,
        last_tested_at: row.last_tested_at,
        last_message: row.last_message,
        fingerprint: row.fingerprint,
      };
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error in getErpConnections:", error);
    return res.status(200).json({
      success: false,
      message: error.message || "Failed to load connections",
    });
  }
});

// Test and save an ERP SQL connection (new form or re-test by connectionId).
const receiveErpConnection = asyncHandler(async (req, res) => {
  let client = null;
  try {
    const existingId = Number(req.body?.connectionId) || null;
    let connectionId = existingId;
    let host;
    let port;
    let database;
    let username;
    let password;
    let connName;
    let dbType;
    let fingerprint;

    if (existingId) {
      // Re-test a saved connection (wireframe: pick from dropdown).
      const loaded = await loadSqlConnection(existingId);
      if (!loaded) {
        return res
          .status(200)
          .json({ success: false, message: "Saved connection not found" });
      }
      if (!loaded.password) {
        return res.status(200).json({
          success: false,
          message:
            "This connection has no saved password. Add it again with a password.",
        });
      }
      host = loaded.config.host;
      port = loaded.config.port;
      database = loaded.config.database;
      username = loaded.config.username;
      password = loaded.password;
      connName = loaded.row.name;
      dbType = loaded.config.db_type || "PostgreSQL";
      fingerprint = loaded.row.fingerprint;
    } else {
      // New connection from the form.
      connName = String(req.body?.name || "").trim();
      dbType = String(req.body?.dbType || "PostgreSQL").trim() || "PostgreSQL";
      host = String(req.body?.host || "").trim();
      port = String(req.body?.port || "").trim();
      database = String(req.body?.database || "").trim();
      username = String(req.body?.user || req.body?.dbUser || "").trim();
      password = String(req.body?.password || "");
      if (!host || !database || !username || !password) {
        return res.status(200).json({
          success: false,
          message: "Host, Database, Database User and Password are required",
        });
      }
      fingerprint = `${host.toLowerCase()}|${port}|${database.toLowerCase()}|${username.toLowerCase()}`;
    }

    client = makeErpClient({ host, port, database, user: username, password });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    client = null;

    const config = JSON.stringify({
      db_type: dbType,
      host,
      port: Number(port),
      database,
      username,
      ssl: "require",
    });
    const checks = JSON.stringify([
      { label: "Sign in", status: "pass", detail: "SELECT 1 succeeded" },
    ]);

    if (existingId) {
      await db.query(
        `UPDATE public.connection
                 SET last_tested_at = now(), last_status = 'ok', last_message = 'Connected'
                 WHERE id = $1`,
        [existingId],
      );
    } else {
      // Encrypt password only when the user typed a new one.
      const secretRef = encryptSecret(password);
      const found = await db.query(
        `SELECT id FROM public.connection WHERE tenant_id = $1 AND fingerprint = $2 LIMIT 1`,
        [TENANT_ID, fingerprint],
      );
      connectionId = found.rows[0]?.id;
      if (connectionId) {
        await db.query(
          `UPDATE public.connection
                     SET name = COALESCE(NULLIF($2, ''), name),
                         config = $3::jsonb,
                         secret_ref = $4,
                         last_tested_at = now(),
                         last_status = 'ok',
                         last_message = 'Connected'
                     WHERE id = $1`,
          [connectionId, connName, config, secretRef],
        );
      } else {
        const inserted = await db.query(
          `INSERT INTO public.connection
                        (tenant_id, name, kind, config, secret_ref, fingerprint, last_tested_at, last_status, last_message)
                     VALUES ($1, $2, 'sql', $3::jsonb, $4, $5, now(), 'ok', 'Connected')
                     RETURNING id`,
          [
            TENANT_ID,
            connName || `${username} @ ${host}/${database}`,
            config,
            secretRef,
            fingerprint,
          ],
        );
        connectionId = inserted.rows[0].id;
      }
    }

    await db.query(
      `INSERT INTO public.connection_test (connection_id, ok, checks) VALUES ($1, true, $2::jsonb)`,
      [connectionId, checks],
    );

    return res.status(200).json({
      success: true,
      message: "Connected to ERP database successfully",
      data: { connectionId },
    });
  } catch (error) {
    try {
      if (client) await client.end();
    } catch (_) {
      /* ignore */
    }
    console.error("Error in receiveErpConnection:", error);
    return res.status(200).json({
      success: false,
      message: error.message || "Failed to connect to ERP database",
    });
  }
});

// Run a SELECT on the ERP connection and return columns/rows for the builder.
const receiveErpQuery = asyncHandler(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) {
    return res
      .status(200)
      .json({ success: false, message: "Query is required" });
  }

  let client = null;
  try {
    const connectionId = Number(req.body?.connectionId) || null;
    let host;
    let port;
    let database;
    let username;
    let password;

    if (connectionId) {
      const loaded = await loadSqlConnection(connectionId);
      if (!loaded) {
        return res
          .status(200)
          .json({ success: false, message: "Saved connection not found" });
      }
      if (!loaded.password) {
        return res.status(200).json({
          success: false,
          message:
            "This connection has no saved password. Add it again with a password.",
        });
      }
      host = loaded.config.host;
      port = loaded.config.port;
      database = loaded.config.database;
      username = loaded.config.username;
      password = loaded.password;
    } else {
      host = String(req.body?.host || "").trim();
      port = String(req.body?.port || "").trim();
      database = String(req.body?.database || "").trim();
      username = String(req.body?.user || req.body?.dbUser || "").trim();
      password = String(req.body?.password || "");
    }

    client = makeErpClient({ host, port, database, user: username, password });
    await client.connect();
    const result = await client.query(query);
    await client.end();
    client = null;

    const headers = (result.fields || []).map((field) => field.name);
    if (!headers.length) {
      return res.status(200).json({
        success: false,
        message: "Query returned no columns. Use a SELECT query.",
      });
    }

    const rows = (result.rows || []).map((row) => {
      const mapped = {};
      headers.forEach((header) => {
        const value = row[header];
        mapped[header] = value == null ? "" : value;
      });
      return mapped;
    });

    return res.status(200).json({
      success: true,
      message: `Query returned ${headers.length} columns`,
      data: {
        headers,
        rows,
        rowCount: rows.length,
      },
    });
  } catch (error) {
    try {
      if (client) await client.end();
    } catch (_) {
      /* ignore */
    }
    console.error("Error in receiveErpQuery:", error);
    return res.status(200).json({
      success: false,
      message: error.message || "Failed to run ERP query",
    });
  }
});

// Test and save an API connection (OAuth/headers proved before Connected).
const receiveApiConnection = asyncHandler(async (req, res) => {
  try {
    const existingId = Number(req.body?.connectionId) || null;
    let connectionId = existingId;
    let config;
    let secretPayload;
    let connName;
    let fingerprint;

    if (existingId) {
      const loaded = await loadApiConnection(existingId);
      if (!loaded) {
        return res
          .status(200)
          .json({ success: false, message: "Saved API connection not found" });
      }
      config = loaded.config;
      secretPayload = loaded.secret;
      connName = loaded.row.name;
      fingerprint = loaded.row.fingerprint;
    } else {
      connName = String(req.body?.name || "").trim();
      const baseUrl = String(req.body?.baseUrl || req.body?.sqlUrl || "")
        .trim()
        .replace(/\/+$/, "");
      const testPath = String(req.body?.testPath || "").trim();
      const authType = String(req.body?.authType || "none").trim() || "none";
      const headerName =
        String(req.body?.headerName || "X-API-Key").trim() || "X-API-Key";
      const headers = (Array.isArray(req.body?.headers) ? req.body.headers : [])
        .map((h) => ({
          key: String(h?.key || "").trim(),
          value: h?.value == null ? "" : String(h.value),
        }))
        .filter((h) => h.key);
      if (!connName || !baseUrl) {
        return res.status(200).json({
          success: false,
          message: "Connection name and Base URL are required",
        });
      }
      if (authType === "api_key" && !String(req.body?.apiKey || "").trim()) {
        return res
          .status(200)
          .json({ success: false, message: "API key is required" });
      }
      if (authType === "bearer" && !String(req.body?.token || "").trim()) {
        return res
          .status(200)
          .json({ success: false, message: "Bearer token is required" });
      }
      if (
        authType === "basic" &&
        (!String(req.body?.basicUser || "").trim() ||
          !String(req.body?.basicPassword || ""))
      ) {
        return res.status(200).json({
          success: false,
          message: "Username and password are required",
        });
      }
      const tokenUrl = String(req.body?.tokenUrl || "").trim();
      const grantType =
        String(req.body?.grantType || "").trim() === "password"
          ? "password"
          : "client_credentials";
      const clientId = String(req.body?.clientId || "").trim();
      const clientSecret = String(req.body?.clientSecret || "");
      const oauthUsername = String(req.body?.oauthUsername || "").trim();
      const oauthPassword = String(req.body?.oauthPassword || "");
      const oauthScope = String(req.body?.oauthScope || "").trim();
      if (authType === "oauth2" && (!tokenUrl || !clientId || !clientSecret)) {
        return res.status(200).json({
          success: false,
          message:
            "OAuth2 token URL, client ID, and client secret are required",
        });
      }
      if (
        authType === "oauth2" &&
        grantType === "password" &&
        (!oauthUsername || !oauthPassword)
      ) {
        return res.status(200).json({
          success: false,
          message:
            "OAuth2 username and password are required for the password grant",
        });
      }
      config = {
        base_url: baseUrl,
        test_path: testPath,
        auth_type: authType,
        header_name: headerName,
        headers,
        token_url: authType === "oauth2" ? tokenUrl : "",
        oauth_grant_type: authType === "oauth2" ? grantType : "",
        oauth_scope: authType === "oauth2" ? oauthScope : "",
      };
      secretPayload = {
        apiKey: String(req.body?.apiKey || ""),
        token: String(req.body?.token || ""),
        basicUser: String(req.body?.basicUser || ""),
        basicPassword: String(req.body?.basicPassword || ""),
        clientId: authType === "oauth2" ? clientId : "",
        clientSecret: authType === "oauth2" ? clientSecret : "",
        oauthUsername:
          authType === "oauth2" && grantType === "password"
            ? oauthUsername
            : "",
        oauthPassword:
          authType === "oauth2" && grantType === "password"
            ? oauthPassword
            : "",
      };
      fingerprint = `${baseUrl.toLowerCase()}|${authType}`;
    }

    // Always prove auth/connectivity before saving as Connected.
    // OAuth2: token endpoint must succeed. Then (and for every other auth type)
    // hit test_path, or the base URL when test_path is blank.
    let headers;
    try {
      headers = await resolveApiHeaders(config, secretPayload);
    } catch (authErr) {
      return res.status(200).json({
        success: false,
        message: authErr.message || "Authorization failed",
      });
    }

    // Optional smoke test. When blank: OAuth2 already proved via token; other auth
    // types probe the base URL so we never mark Connected without a live call.
    const testPath = String(config.test_path || "").trim();
    const shouldProbe = Boolean(testPath) || config.auth_type !== "oauth2";
    if (shouldProbe) {
      const probeUrl = joinUrl(config.base_url, testPath);
      try {
        const response = await axios.get(probeUrl, {
          headers,
          timeout: 15000,
          validateStatus: () => true,
        });
        if (response.status === 401 || response.status === 403) {
          return res.status(200).json({
            success: false,
            message: `Authorization failed (HTTP ${response.status}). Check sign-in method and credentials.`,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return res.status(200).json({
            success: false,
            message: testPath
              ? `Test path returned HTTP ${response.status}`
              : `Connection test returned HTTP ${response.status}`,
          });
        }
      } catch (probeErr) {
        return res.status(200).json({
          success: false,
          message: probeErr.message || "Failed to reach the API URL",
        });
      }
    }

    const secretRef = encryptSecret(JSON.stringify(secretPayload || {}));
    const configJson = JSON.stringify(config);

    if (existingId) {
      await db.query(
        `UPDATE public.connection
                 SET last_tested_at = now(), last_status = 'ok', last_message = 'Connected'
                 WHERE id = $1`,
        [existingId],
      );
    } else {
      const found = await db.query(
        `SELECT id FROM public.connection WHERE tenant_id = $1 AND fingerprint = $2 LIMIT 1`,
        [TENANT_ID, fingerprint],
      );
      connectionId = found.rows[0]?.id;
      if (connectionId) {
        await db.query(
          `UPDATE public.connection
                     SET name = COALESCE(NULLIF($2, ''), name),
                         config = $3::jsonb,
                         secret_ref = $4,
                         last_tested_at = now(),
                         last_status = 'ok',
                         last_message = 'Connected'
                     WHERE id = $1`,
          [connectionId, connName, configJson, secretRef],
        );
      } else {
        const inserted = await db.query(
          `INSERT INTO public.connection
                        (tenant_id, name, kind, config, secret_ref, fingerprint, last_tested_at, last_status, last_message)
                     VALUES ($1, $2, 'api', $3::jsonb, $4, $5, now(), 'ok', 'Connected')
                     RETURNING id`,
          [TENANT_ID, connName, configJson, secretRef, fingerprint],
        );
        connectionId = inserted.rows[0].id;
      }
    }

    await db.query(
      `INSERT INTO public.connection_test (connection_id, ok, checks) VALUES ($1, true, $2::jsonb)`,
      [
        connectionId,
        JSON.stringify([{ label: "API connection saved", status: "pass" }]),
      ],
    );

    return res.status(200).json({
      success: true,
      message: "API connection tested and saved",
      data: { connectionId },
    });
  } catch (error) {
    console.error("Error in receiveApiConnection:", error);
    return res.status(200).json({
      success: false,
      message: error.message || "Failed to save API connection",
    });
  }
});

// Pull a short human-readable message from an API/OAuth error body.
const formatApiErrorDetail = (data) => {
  if (data == null || data === "") return "";
  if (typeof data === "string") return data.slice(0, 300);
  const msg =
    data.message ||
    data.Message ||
    data.error ||
    data.Error ||
    data.error_description;
  if (msg) return String(msg).slice(0, 300);
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch (_) {
    return "";
  }
};

// Run an API request (JSON body or raw SQL → { sql }) and return columns/rows.
const receiveApiRequest = asyncHandler(async (req, res) => {
  try {
    const connectionId = Number(req.body?.connectionId) || null;
    if (!connectionId) {
      return res
        .status(200)
        .json({ success: false, message: "connectionId is required" });
    }
    const method = String(req.body?.method || "GET")
      .trim()
      .toUpperCase();
    const path = String(req.body?.path || "").trim();
    const recordsPath = String(req.body?.recordsPath || "").trim();
    const bodyRaw = String(req.body?.body || req.body?.query || "").trim();
    const queryParams = normalizeQueryParams(req.body?.queryParams);
    if (!path) {
      return res
        .status(200)
        .json({ success: false, message: "Path is required" });
    }
    if (method !== "GET" && method !== "POST") {
      return res
        .status(200)
        .json({ success: false, message: "Method must be GET or POST" });
    }

    const loaded = await loadApiConnection(connectionId);
    if (!loaded) {
      return res
        .status(200)
        .json({ success: false, message: "Saved API connection not found" });
    }

    const url = joinUrl(loaded.config.base_url || loaded.config.sql_url, path);
    const headers = await resolveApiHeaders(loaded.config, loaded.secret);
    const axiosCfg = {
      method,
      url,
      headers,
      timeout: 60000,
      validateStatus: () => true,
    };
    if (Object.keys(queryParams).length) axiosCfg.params = queryParams;
    if (method === "POST") {
      headers["Content-Type"] =
        headers["Content-Type"] ||
        headers["content-type"] ||
        "application/json";
      axiosCfg.data = parseApiRequestBody(bodyRaw);
    }

    const response = await axios(axiosCfg);
    if (response.status < 200 || response.status >= 300) {
      const detail = formatApiErrorDetail(response.data);
      return res.status(200).json({
        success: false,
        message: detail
          ? `API returned HTTP ${response.status}: ${detail}`
          : `API returned HTTP ${response.status}`,
      });
    }

    const records = extractApiRecords(response.data, recordsPath).slice(
      0,
      5000,
    );
    if (!records.length) {
      return res.status(200).json({
        success: false,
        message:
          "No records found. Check Records path (e.g. data or Data) or leave it blank if the response is already a list.",
      });
    }
    const flatRows = records.map(flattenApiRow);
    const headerSet = new Set();
    flatRows.forEach((row) =>
      Object.keys(row).forEach((key) => headerSet.add(key)),
    );
    const headersOut = Array.from(headerSet);
    if (!headersOut.length) {
      return res
        .status(200)
        .json({ success: false, message: "Records had no fields" });
    }

    return res.status(200).json({
      success: true,
      message: `Request returned ${headersOut.length} columns · ${flatRows.length} row${flatRows.length === 1 ? "" : "s"}`,
      data: {
        headers: headersOut,
        rows: flatRows,
        rowCount: flatRows.length,
      },
    });
  } catch (error) {
    console.error("Error in receiveApiRequest:", error);
    return res.status(200).json({
      success: false,
      message: error.message || "Failed to run API request",
    });
  }
});

module.exports = {
  getErpConnections,
  receiveErpConnection,
  receiveErpQuery,
  receiveApiConnection,
  receiveApiRequest,
};
