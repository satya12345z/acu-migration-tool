require("dotenv").config();
const axios = require("axios");

const trimSlash = (v) =>
  String(v || "")
    .trim()
    .replace(/\/+$/, "");

const CONFIG = {
  baseUrl: trimSlash(process.env.ACUMATICA_BASE_URL),
  tokenUrl:
    String(process.env.ACUMATICA_TOKEN_URL || "").trim() ||
    `${trimSlash(process.env.ACUMATICA_BASE_URL)}/identity/connect/token`,
  clientId: String(process.env.ACUMATICA_CLIENT_ID || "").trim(),
  clientSecret: String(process.env.ACUMATICA_CLIENT_SECRET || ""),
  username: String(process.env.ACUMATICA_USERNAME || "").trim(),
  password: String(process.env.ACUMATICA_PASSWORD || ""),
  scope: String(process.env.ACUMATICA_SCOPE || "api offline_access").trim(),
  endpoint: String(process.env.ACUMATICA_ENDPOINT || "Default").trim(),
  endpointVersion: String(
    process.env.ACUMATICA_ENDPOINT_VERSION || "24.200.001",
  ).trim(),
  timeoutMs: Number(process.env.ACUMATICA_TIMEOUT_MS) || 60000,
};

const validateConfig = () => {
  const missing = [
    ["ACUMATICA_BASE_URL", CONFIG.baseUrl],
    ["ACUMATICA_CLIENT_ID", CONFIG.clientId],
    ["ACUMATICA_CLIENT_SECRET", CONFIG.clientSecret],
    ["ACUMATICA_USERNAME", CONFIG.username],
    ["ACUMATICA_PASSWORD", CONFIG.password],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Missing Acumatica settings in .env: ${missing.join(", ")}`,
    );
  }
};

// In-memory token cache (one process). Refresh a minute before expiry.
let tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };
const EXPIRY_SKEW_MS = 60 * 1000;

// Same request shape and error handling as fetchOAuth2AccessToken in the controller.
const requestToken = async (extraParams) => {
  const params = new URLSearchParams();
  params.append("client_id", CONFIG.clientId);
  params.append("client_secret", CONFIG.clientSecret);
  Object.entries(extraParams).forEach(([k, v]) => params.append(k, v));

  const response = await axios.post(CONFIG.tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const detail =
      response.data?.error_description || response.data?.error || "";
    throw new Error(
      detail
        ? `Acumatica token request failed (HTTP ${response.status}): ${detail}`
        : `Acumatica token request failed (HTTP ${response.status})`,
    );
  }
  const { access_token, refresh_token, expires_in } = response.data || {};
  if (!access_token) {
    throw new Error("Acumatica token response did not include access_token");
  }
  tokenCache = {
    accessToken: access_token,
    refreshToken: refresh_token || tokenCache.refreshToken,
    expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000,
  };
  return access_token;
};

// Resource Owner Password grant: Acumatica's usual grant for server-to-server use,
// because every API call must run as a real Acumatica user.
const loginWithPassword = () =>
  requestToken({
    grant_type: "password",
    username: CONFIG.username,
    password: CONFIG.password,
    scope: CONFIG.scope,
  });

const getAccessToken = async ({ forceNew = false } = {}) => {
  validateConfig();
  if (
    !forceNew &&
    tokenCache.accessToken &&
    Date.now() < tokenCache.expiresAt - EXPIRY_SKEW_MS
  ) {
    return tokenCache.accessToken;
  }
  if (!forceNew && tokenCache.refreshToken) {
    try {
      return await requestToken({
        grant_type: "refresh_token",
        refresh_token: tokenCache.refreshToken,
      });
    } catch (_) {
      // Refresh token expired or revoked: fall back to a fresh password login.
    }
  }
  return loginWithPassword();
};

// Equivalent of resolveApiHeaders(config, secret) for an Acumatica connection.
const getAuthHeaders = async () => ({
  Accept: "application/json",
  Authorization: `Bearer ${await getAccessToken()}`,
});

// Contract-based REST URL, e.g. entityUrl("Customer") ->
// {base}/entity/Default/24.200.001/Customer
const entityUrl = (entityPath) =>
  `${CONFIG.baseUrl}/entity/${CONFIG.endpoint}/${CONFIG.endpointVersion}/${String(
    entityPath || "",
  ).replace(/^\/+/, "")}`;

// Authenticated call. Retries once with a brand-new token on 401.
const acumaticaRequest = async ({ method = "GET", path, params, data }) => {
  const send = async () =>
    axios({
      method,
      url: entityUrl(path),
      headers: {
        ...(await getAuthHeaders()),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      params,
      data,
      timeout: CONFIG.timeoutMs,
      validateStatus: () => true,
    });

  let response = await send();
  if (response.status === 401) {
    tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };
    await getAccessToken({ forceNew: true });
    response = await send();
  }
  if (response.status < 200 || response.status >= 300) {
    const body = response.data;
    const detail =
      (body && (body.exceptionMessage || body.message || body.error)) ||
      (typeof body === "string" ? body.slice(0, 300) : "");
    const err = new Error(
      detail
        ? `Acumatica returned HTTP ${response.status}: ${detail}`
        : `Acumatica returned HTTP ${response.status}`,
    );
    // Keep the raw response so callers can read field-level errors (HTTP 422).
    err.status = response.status;
    err.data = body;
    throw err;
  }
  return response.data;
};

// Ends the API session on the Acumatica side so it stops counting against
// the API user/session limit. Call on shutdown or after batch jobs.
const logout = async () => {
  if (!tokenCache.accessToken) return;
  try {
    await axios.post(`${CONFIG.baseUrl}/entity/auth/logout`, null, {
      headers: { Authorization: `Bearer ${tokenCache.accessToken}` },
      timeout: 15000,
      validateStatus: () => true,
    });
  } finally {
    tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };
  }
};

// Connection test, mirroring receiveApiConnection: get a token, then make one live call.
const testConnection = async () => {
  await getAccessToken({ forceNew: true });
  const rows = await acumaticaRequest({
    path: process.env.ACUMATICA_TEST_ENTITY || "Customer",
    params: { $top: 1 },
  });
  return { ok: true, sampleCount: Array.isArray(rows) ? rows.length : 1 };
};

module.exports = {
  getAccessToken,
  getAuthHeaders,
  acumaticaRequest,
  testConnection,
  logout,
};

// Run directly:  node acumaticaAuth.js
if (require.main === module) {
  testConnection()
    .then((r) => console.log("Acumatica connection OK", r))
    .catch((e) => {
      console.error("Acumatica connection failed:", e.message);
      process.exitCode = 1;
    })
    .finally(logout);
}
