// Create Acumatica Stock Items from a CSV file.
//
//   node importStockItems.js                      -> uses DEFAULT_INPUT_CSV_FILE
//   node importStockItems.js inputs/other.csv
//   node importStockItems.js --dry-run            -> build + validate only, nothing sent or written
//   node importStockItems.js --verbose            -> also print each full Acumatica response
//
// Mapping, fixed values, ID numbering and output files come from field_mapping_setup.js.
// Results: created rows -> SUCCESS_CSV_FILE, everything else (with reason) -> FAIL_CSV_FILE.
// Each row is appended right after its create/fail; files are never cleared between runs
// (the header is written only when a file is missing or empty).

const fs = require("fs");
const path = require("path");
const auth = require("./acumaticaAuth");
const setup = require("./field_mapping_setup");

const ENTITY = "StockItem";
const PAGE_SIZE = 1000;

// ---------- CSV helpers ----------

// RFC 4180 parser: quoted fields, "" escapes, commas/newlines inside quotes, CRLF.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
};

const csvCell = (value) => {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Append one row; write the header first if the file is missing or empty.
// Sync write, so rows from parallel requests never interleave.
const appendCsvRow = (file, headers, row) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isEmpty = !fs.existsSync(file) || fs.statSync(file).size === 0;
  const lines = isEmpty ? [headers, row] : [row];
  fs.appendFileSync(file, `${lines.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
};

// ---------- Acumatica helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
const odataString = (v) => `'${String(v).replace(/'/g, "''")}'`;

// Retry on rate limiting (429) and temporary server errors.
const withRetry = async (fn, attempts = 3) => {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const retryable = [429, 502, 503, 504].includes(err.status);
      if (!retryable || i >= attempts) throw err;
      await sleep(1000 * 2 ** i);
    }
  }
};

// Read every existing stock item (InventoryID + match field) once, page by page.
const fetchExistingItems = async (matchField) => {
  const select = ["InventoryID", matchField].filter(Boolean);
  const all = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await withRetry(() =>
      auth.acumaticaRequest({
        path: ENTITY,
        params: { $select: [...new Set(select)].join(","), $top: PAGE_SIZE, $skip: skip },
      }),
    );
    const list = Array.isArray(page) ? page : [];
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
  }
  return all.map((item) => ({
    inventoryId: String(item.InventoryID?.value || "").trim(),
    matchValue: matchField ? String(item[matchField]?.value || "").trim() : "",
  }));
};

// Collect readable messages from an Acumatica error body. HTTP 422 puts an
// "error" property on each failing field, e.g. { ItemClass: { value, error } }.
const describeError = (err) => {
  const messages = [];
  const walk = (node, keyPath) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${keyPath}[${i}]`));
      return;
    }
    if (typeof node.error === "string" && node.error) {
      messages.push(keyPath ? `${keyPath}: ${node.error}` : node.error);
    }
    Object.entries(node).forEach(([k, v]) => {
      if (k !== "error" && v && typeof v === "object") walk(v, keyPath ? `${keyPath}.${k}` : k);
    });
  };
  const data = err.data;
  if (data && typeof data === "object") {
    if (data.exceptionMessage) messages.push(data.exceptionMessage);
    else if (data.message) messages.push(data.message);
    walk(data, "");
  }
  const unique = [...new Set(messages)];
  const prefix = err.status ? `HTTP ${err.status}` : "";
  if (unique.length) return [prefix, unique.join("; ")].filter(Boolean).join(": ");
  return err.message || String(err);
};

// ---------- Row building ----------

// Group CSV columns by Acumatica field (keeps mapping order) and join with the delimiter.
const buildFieldValues = (record) => {
  const grouped = {};
  Object.entries(setup.fieldMapping).forEach(([csvCol, acuField]) => {
    const value = String(record[csvCol] == null ? "" : record[csvCol]).trim();
    if (!grouped[acuField]) grouped[acuField] = [];
    if (value) grouped[acuField].push(value);
  });
  const values = { ...setup.FIXED_VALUES };
  Object.entries(grouped).forEach(([acuField, parts]) => {
    if (parts.length) values[acuField] = parts.join(setup.FIELD_MAPPING_DELIMITER);
  });
  return values;
};

const toPayload = (values) => {
  const body = {};
  Object.entries(values).forEach(([field, value]) => {
    if (value !== undefined && value !== null && value !== "") body[field] = { value };
  });
  return body;
};

// One line per Acumatica create response; --verbose also prints the full response body.
const logCreateResponse = (r, progress, verbose) => {
  const desc = r.result?.Description?.value ?? r.values.Description ?? "";
  if (r.error) {
    console.error(`[${progress}] Line ${r.lineNo}: FAILED ${r.inventoryId || ""} - ${r.error}`);
    if (verbose && r.errorBody) console.error(JSON.stringify(r.errorBody, null, 2));
    return;
  }
  console.log(
    `[${progress}] Line ${r.lineNo}: CREATED InventoryID=${r.inventoryId} id=${r.result?.id || ""} Description="${desc}"`,
  );
  if (verbose) console.log(JSON.stringify(r.result, null, 2));
};

// ---------- Main ----------

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  const inputFile = args.find((a) => !a.startsWith("--")) || setup.DEFAULT_INPUT_CSV_FILE;
  const matchField = String(setup.MATCH_FIELD || "").trim();
  const prefixField = String(setup.INVENTORY_ID_PREFIX_FIELD || "").trim();

  const table = parseCsv(fs.readFileSync(inputFile, "utf8"));
  if (table.length < 2) throw new Error(`${inputFile} has no data rows`);
  const headers = table[0].map((h) => h.trim());
  const missingCols = [...Object.keys(setup.fieldMapping), prefixField]
    .filter(Boolean)
    .filter((c) => !headers.includes(c));
  if (missingCols.length) {
    throw new Error(`Columns missing from ${inputFile}: ${missingCols.join(", ")}`);
  }

  const rows = table.slice(1).map((cells, i) => {
    const record = {};
    headers.forEach((h, idx) => {
      record[h] = cells[idx] == null ? "" : cells[idx];
    });
    return {
      lineNo: i + 2, // CSV line, header = line 1
      cells: headers.map((_, idx) => (cells[idx] == null ? "" : cells[idx])),
      record,
      values: buildFieldValues(record),
      inventoryId: "",
      error: "",
      result: null,
    };
  });
  console.log(`Read ${rows.length} row(s) from ${inputFile}`);

  // Existing items: used for the duplicate check and to continue ID numbering.
  let existing = [];
  if (matchField || prefixField) {
    try {
      existing = await fetchExistingItems(matchField);
      console.log(`Found ${existing.length} existing stock item(s) in Acumatica`);
    } catch (err) {
      // Can't check duplicates or numbering safely, so nothing is sent.
      const reason = `Could not read existing stock items: ${describeError(err)}`;
      rows.forEach((r) => {
        r.error = reason;
      });
    }
  }

  // Duplicate check on MATCH_FIELD (against Acumatica and earlier rows of this file).
  if (matchField) {
    const inAcumatica = new Map();
    existing.forEach((e) => {
      if (e.matchValue && !inAcumatica.has(norm(e.matchValue))) {
        inAcumatica.set(norm(e.matchValue), e.inventoryId);
      }
    });
    const seenInFile = new Map();
    rows.forEach((r) => {
      if (r.error) return;
      const key = norm(r.values[matchField]);
      if (!key) {
        r.error = `${matchField} is empty after mapping`;
      } else if (inAcumatica.has(key)) {
        r.error = `Already exists in Acumatica as InventoryID ${inAcumatica.get(key)} (same ${matchField})`;
      } else if (seenInFile.has(key)) {
        r.error = `Duplicate of CSV line ${seenInFile.get(key)} (same ${matchField})`;
      } else {
        seenInFile.set(key, r.lineNo);
      }
    });
  }

  // InventoryID = <prefix><separator><next number>, continuing after Acumatica's highest.
  // Note: with an empty separator, a prefix such as "10D4" also matches "10D451000";
  // use a separator if your prefixes can be prefixes of each other.
  if (prefixField) {
    const sep = String(setup.INVENTORY_ID_SEPARATOR || "");
    const maxLen = Number(setup.INVENTORY_ID_MAX_LENGTH) || Infinity;
    const start = Number(setup.INVENTORY_ID_START_NUMBER) || 1;
    const nextByPrefix = new Map();
    const nextNumber = (prefix) => {
      const key = norm(prefix);
      if (!nextByPrefix.has(key)) {
        const head = norm(prefix + sep);
        let max = start - 1;
        existing.forEach((e) => {
          const id = norm(e.inventoryId);
          const rest = id.startsWith(head) ? id.slice(head.length) : "";
          if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
        });
        nextByPrefix.set(key, max + 1);
      }
      const n = nextByPrefix.get(key);
      nextByPrefix.set(key, n + 1);
      return n;
    };
    rows.forEach((r) => {
      if (r.error) return;
      const prefix = String(r.record[prefixField] || "").trim();
      if (!prefix) {
        r.error = `${prefixField} is empty, cannot build InventoryID`;
        return;
      }
      const candidate = `${prefix}${sep}${nextNumber(prefix)}`;
      if (candidate.length > maxLen) {
        r.error = `Generated InventoryID ${candidate} is longer than ${maxLen} characters`;
        return;
      }
      r.inventoryId = candidate;
      r.values = { InventoryID: candidate, ...r.values };
    });
  }

  const toSend = rows.filter((r) => !r.error);

  if (dryRun) {
    rows.forEach((r) => {
      console.log(`\nLine ${r.lineNo}: ${r.error ? `SKIP - ${r.error}` : "WOULD CREATE"}`);
      if (!r.error) console.log(JSON.stringify(toPayload(r.values), null, 2));
    });
    console.log(`\nDry run: ${toSend.length} to create, ${rows.length - toSend.length} would fail. Nothing sent or written.`);
    return;
  }

  // Each result is appended to fail.csv / success.csv as soon as it is known,
  // so an interrupted run still has every finished row on disk.
  const descField = matchField || "Description";
  const failHeader = ["csv_line", ...headers, "InventoryID", descField, "Error"];
  const successHeader = ["csv_line", ...headers, "InventoryID", descField, "AcumaticaRecordId", "Status"];
  const recordResult = (r) => {
    if (r.error) {
      appendCsvRow(setup.FAIL_CSV_FILE, failHeader, [
        r.lineNo, ...r.cells, r.inventoryId, r.values[descField] || "", r.error,
      ]);
    } else if (setup.GENERATE_SUCCESS_CSV_FILE) {
      appendCsvRow(setup.SUCCESS_CSV_FILE, successHeader, [
        r.lineNo,
        ...r.cells,
        r.inventoryId,
        r.result?.[descField]?.value ?? r.values[descField] ?? "",
        r.result?.id || "",
        "Created",
      ]);
    }
  };

  // Rows that fail before sending (duplicates, bad IDs) are logged and appended here.
  rows
    .filter((r) => r.error)
    .forEach((r) => {
      console.log(`Line ${r.lineNo}: SKIPPED - ${r.error}`);
      recordResult(r);
    });
  if (toSend.length) console.log(`Creating ${toSend.length} stock item(s)...`);

  // Create items, PARALLEL_REQUESTS at a time.
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < toSend.length) {
      const r = toSend[cursor];
      cursor += 1;
      try {
        const created = await withRetry(() =>
          auth.acumaticaRequest({ method: "PUT", path: ENTITY, data: toPayload(r.values) }),
        );
        r.result = created;
        r.inventoryId = String(created?.InventoryID?.value || r.inventoryId).trim();
      } catch (err) {
        r.error = describeError(err);
        r.errorBody = err.data;
      }
      done += 1;
      logCreateResponse(r, `${done}/${toSend.length}`, verbose);
      recordResult(r);
    }
  };
  const parallel = Math.max(1, Number(setup.PARALLEL_REQUESTS) || 1);
  await Promise.all(Array.from({ length: Math.min(parallel, toSend.length) }, worker));

  const failed = rows.filter((r) => r.error);
  const succeeded = rows.filter((r) => !r.error && r.result);
  console.log(`\nCreated: ${succeeded.length}  Failed: ${failed.length}`);
  console.log(`Fail report: ${setup.FAIL_CSV_FILE}`);
  if (setup.GENERATE_SUCCESS_CSV_FILE) console.log(`Success report: ${setup.SUCCESS_CSV_FILE}`);
};

main()
  .catch((err) => {
    console.error("Import stopped:", err.message);
    process.exitCode = 1;
  })
  .finally(() => auth.logout());
