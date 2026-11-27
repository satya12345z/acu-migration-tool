// Checks each test PDF's answer key against Acumatica: does the customer filter
// find the right customer, and does each line's item filter find a stock item?
// Read-only (GET requests only).
//
// Usage: node test-docs/check_matches.js

const fs = require("fs");
const path = require("path");
const auth = require("../acumaticaAuth");

const EXPECTED_DIR = path.join(__dirname, "expected");

const find = async (entity, filter, select) => {
  const rows = await auth.acumaticaRequest({ path: entity, params: { $filter: filter, $select: select, $top: 5 } });
  return Array.isArray(rows) ? rows : [];
};

const main = async () => {
  let totalLines = 0, totalMatched = 0;
  for (const file of fs.readdirSync(EXPECTED_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(EXPECTED_DIR, file), "utf8"));
    const custs = await find("Customer", doc.customer.filter, "CustomerID,CustomerName");
    const custIds = custs.map((c) => c.CustomerID?.value);
    const custOk = custIds.length === 1 && custIds[0] === doc.customer.customerId;
    console.log(`\n${doc.document}`);
    console.log(`  Customer ${custOk ? "MATCH" : "NO MATCH"}: ${doc.customer.filter} -> [${custIds.join(", ")}]`);
    let matched = 0;
    for (const l of doc.lines) {
      const items = await find("StockItem", l.filter, "InventoryID,Description");
      const ok = items.length === 1 && items[0].Description?.value === l.acumaticaDescription;
      if (ok) matched++;
      const found = items.map((i) => i.InventoryID?.value).join(", ");
      console.log(`  Line ${l.line} ${ok ? "MATCH   " : items.length > 1 ? "MULTIPLE" : "NOT FOUND"} ${found ? `[${found}] ` : ""}${l.acumaticaDescription}`);
    }
    console.log(`  => ${matched} of ${doc.lines.length} lines matched`);
    totalLines += doc.lines.length;
    totalMatched += matched;
  }
  console.log(`\nTOTAL: ${totalMatched} of ${totalLines} lines matched`);
};

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => auth.logout());
