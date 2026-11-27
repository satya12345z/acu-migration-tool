// Generates sample customer "Material Pull List / Quote Request" PDFs for
// testing an AI model that reads a PDF and creates an Acumatica Quote.
//
// Items are picked from the Invex input file (default inputs/APP-Products.csv).
// The PDFs never show the exact Customer Name, Customer ID or stock item
// Description. They show pieces of them (Form, Grade, Size, Finish, a partial
// customer name), so the model has to find the records with $filter
// startswith / endswith / substringof.
//
// For every PDF an "expected" JSON holds the right answer: customer ID, and for
// each line the Invex keys, the Acumatica Description, qty, unit price and a
// $filter that finds the item.
//
// Usage: node test-docs/generate_quote_test_pdfs.js [path/to/invex.csv]
// Needs Microsoft Edge or Google Chrome (used headless to print HTML to PDF).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { fieldMapping, FIELD_MAPPING_DELIMITER } = require("../field_mapping_setup");

const ROOT = __dirname;
// Args: [path/to/invex.csv] [--only <text>]   --only renders just the documents whose file name contains <text>
const ARGS = process.argv.slice(2);
const ONLY = ARGS.includes("--only") ? ARGS[ARGS.indexOf("--only") + 1] : "";
const CSV_ARG = ARGS.find((a, i) => !a.startsWith("--") && ARGS[i - 1] !== "--only");
const INPUT_CSV = path.resolve(CSV_ARG || path.join(ROOT, "..", "inputs", "APP-Products.csv"));
const OUT_PDF = path.join(ROOT, "pdfs");
const OUT_EXPECTED = path.join(ROOT, "expected");
const OUT_HTML = path.join(ROOT, "html");
const SEED = 20261126; // change to get a different set of items

// ---------- CSV ----------
const parseCsv = (text) => {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.replace(/^\uFEFF/, "").trim(), (r[i] || "").trim()])));
};

// Same Description the importer builds (field_mapping_setup.js order + delimiter).
const acumaticaDescription = (it) =>
  Object.entries(fieldMapping)
    .filter(([, target]) => target === "Description")
    .map(([src]) => it[src])
    .join(FIELD_MAPPING_DELIMITER);

const catalog = parseCsv(fs.readFileSync(INPUT_CSV, "utf8")).map((it) => ({ ...it, description: acumaticaDescription(it) }));

// ---------- customers ----------
// docName is what the PDF shows: part of the real name, never the exact name or ID.
const CUSTOMERS = {
  ABARTENDE: { name: "USA Bartending School", docName: "Bartending School", search: "substringof",
    address: ["740 Mixology Ave", "Las Vegas, NV 89109"], phone: "(702) 555-0131" },
  ABCHOLDING: { name: "ABC Holdings Inc", docName: "ABC Holdings", search: "startswith",
    address: ["12 Commerce Plaza, Floor 3", "Hartford, CT 06103"], phone: "(860) 555-0164" },
  ABCSTUDIOS: { name: "ABC Studios Inc", docName: "ABC Studios", search: "startswith",
    address: ["3300 Backlot Way", "Burbank, CA 91505"], phone: "(818) 555-0187" },
  ABCVENTURE: { name: "ABC Capital Ventures", docName: "ABC Capital", search: "startswith",
    address: ["500 Harbor Point Blvd", "Tampa, FL 33602"], phone: "(813) 555-0109" },
  ACTIVESTAF: { name: "Active Staffing Service", docName: "Active Staffing", search: "startswith",
    address: ["61 Workforce Lane", "Columbus, OH 43215"], phone: "(614) 555-0150" },
};

// ---------- documents ----------
// columns = which Invex field fills each PDF column, varied per document so the
// model sees codes in some documents and descriptions in others.
const DOCUMENTS = [
  { file: "Pull-List-ABARTENDE-4410-01", layout: "pullList", customer: "ABARTENDE", job: "4410-01", date: "11/02/2026",
    jobDescription: "CAMPUS CENTRAL PLANT EXPANSION", lines: 6,
    columns: { form: "frm_desc25", grade: "grd_desc25", size: "prm_size_desc" } },
  { file: "RFQ-ABCHOLDING-2290-07", layout: "rfq", customer: "ABCHOLDING", job: "2290-07", date: "11/09/2026",
    jobDescription: "CORPORATE HQ STEAM LOOP RETROFIT", lines: 7,
    columns: { form: "prm_frm", grade: "grd_grd", size: "prm_size_desc" } },
  // Form/Grade/Size/Finish show the Invex codes (prm_frm, grd_grd, prm_size, prm_fnsh) unless a document sets showCodes: false.
  { file: "Requisition-ABCSTUDIOS-6105-03", layout: "requisition", customer: "ABCSTUDIOS", job: "6105-03", date: "11/13/2026",
    jobDescription: "SOUND STAGE 12 CHILLED WATER", lines: 5,
    columns: { form: "frm_desc15", grade: "grd_desc15", size: "prm_size_desc" } },
  { file: "Bill-of-Material-ABCVENTURE-8832-01", layout: "bom", customer: "ABCVENTURE", job: "8832-01", date: "11/19/2026",
    jobDescription: "HARBOR POINT TOWER MECHANICAL", lines: 8,
    columns: { form: "frm_desc25", grade: "grd_grd", size: "prm_shrt_size_desc" } },
  { file: "Material-Request-ACTIVESTAF-5017-02", layout: "requestForm", customer: "ACTIVESTAF", job: "5017-02", date: "11/24/2026",
    jobDescription: "DISTRIBUTION CENTER PROCESS PIPING", lines: 6,
    columns: { form: "prm_frm", grade: "grd_desc25", size: "prm_size_desc" } },
];

// ---------- helpers ----------
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;
const odata = (s) => s.replace(/'/g, "''");

// What the PDF prints. By default the four Invex codes are printed as-is;
// they are the start of Description, so startswith(Description, form+grade+size+finish) finds the item.
const displayValues = (it, doc) =>
  doc.showCodes !== false
    ? { form: it.prm_frm, grade: it.grd_grd, size: it.prm_size, finish: it.prm_fnsh }
    : shownValues(it, doc.columns);
const displayFilter = (it, doc) =>
  doc.showCodes !== false
    ? `startswith(Description,'${odata(it.prm_frm + it.grd_grd + it.prm_size + it.prm_fnsh)}')`
    : filterFor(it, doc.columns);

// Description-based values per the document's column choice (used to pick items; shown only with showCodes: false).
const shownValues = (it, columns) => ({
  form: it[columns.form], grade: it[columns.grade], size: it[columns.size], finish: it.prm_fnsh,
});

// $filter the model could use: prm_frm is the start of Description, the full
// size description is its end, everything else is somewhere inside.
const filterFor = (it, columns) => {
  const v = shownValues(it, columns);
  const parts = [];
  if (columns.form === "prm_frm") parts.push(`startswith(Description,'${odata(v.form)}')`);
  else parts.push(`substringof('${odata(v.form)}',Description)`);
  parts.push(`substringof('${odata(v.grade)}',Description)`);
  if (columns.size === "prm_size_desc") parts.push(`endswith(Description,'${odata(v.size)}')`);
  else parts.push(`substringof('${odata(v.size)}',Description)`);
  parts.push(`substringof('${odata(v.finish)}',Description)`);
  return parts.join(" and ");
};

// The item is usable only if every value shown in the PDF is really inside its
// Description, and the filter above matches no other catalog item.
const matches = (row, it, columns) => {
  const v = shownValues(it, columns);
  const d = row.description;
  if (columns.form === "prm_frm" ? !d.startsWith(v.form) : !d.includes(v.form)) return false;
  if (!d.includes(v.grade) || !d.includes(v.finish)) return false;
  return columns.size === "prm_size_desc" ? d.endsWith(v.size) : d.includes(v.size);
};
const usable = (it, columns) => {
  const v = shownValues(it, columns);
  if (Object.values(v).some((x) => !x)) return false;
  if (!matches(it, it, columns)) return false;
  let hits = 0;
  for (const row of catalog) if (matches(row, it, columns) && ++hits > 1) return false;
  return true;
};

// With codes shown, startswith(form+grade+size+finish) must hit only this item.
// Matching ignores case, and finish COM is also the start of COMV, so check every item.
const codePrefix = (it) => (it.prm_frm + it.grd_grd + it.prm_size + it.prm_fnsh).toLowerCase();
const catalogPrefixes = catalog.map(codePrefix);
const codesUnique = (it, doc) => {
  if (doc.showCodes === false) return true;
  const p = codePrefix(it);
  let hits = 0;
  for (const c of catalogPrefixes) if (c.startsWith(p) && ++hits > 1) return false;
  return true;
};

const pickLines = (doc, used) => {
  const lines = [];
  const forms = new Set();
  for (let tries = 0; lines.length < doc.lines && tries < 5000; tries++) {
    const it = catalog[randInt(0, catalog.length - 1)];
    if (used.has(it.description) || forms.has(it.prm_frm) || !usable(it, doc.columns) || !codesUnique(it, doc)) continue;
    used.add(it.description);
    forms.add(it.prm_frm);
    const qty = [2, 4, 5, 6, 8, 10, 12, 15, 20, 24, 30, 40][randInt(0, 11)];
    lines.push({ it, qty, uom: "EA", price: round2(randInt(1250, 98000) / 100) });
  }
  if (lines.length < doc.lines) throw new Error(`Only found ${lines.length} usable items for ${doc.file}`);
  return lines;
};

// ---------- layout ----------
const CSS = `
  @page { size: Letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 5px 6px; vertical-align: top; }
  th { text-align: left; }
  .r { text-align: right !important; } .c { text-align: center !important; } .muted { color: #555; }
  .nw { white-space: nowrap; }
`;

// Each layout returns { css, body }. All show the same facts: customer text,
// phone, ship-to, job #, date, and per line Qty, UOM, Form, Grade, Size,
// Finish, Unit Price, Amount.
const layouts = {
  // Shop picking-list look (the format that was closest to real documents).
  pullList: (doc, cust, lines, total) => ({
    css: `th { font-weight: normal; text-decoration: underline; }`,
    body: `
    <div style="border:1px solid #111;padding:6px 10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><b>${esc(cust.docName)}</b><br>${esc(doc.date)} 3:42:10 PM<br>Job Description: ${esc(doc.jobDescription)}</div>
        <div class="c" style="font-size:15pt;font-weight:bold">Material Pull List / Quote Request</div>
        <div class="r" style="white-space:nowrap">Page 1 of 1<br><b>Job #: ${esc(doc.job)}</b></div>
      </div></div>
    <div style="border:1px solid #111;border-top:none;padding:6px 10px">
      Job Date: ${esc(doc.date)} &nbsp;&nbsp; Phone: ${esc(cust.phone)}<br>
      Sold To: ${esc(cust.docName)} &nbsp;&nbsp;&nbsp; Ship To: ${cust.address.map(esc).join(", ")}</div>
    <div style="border:1px solid #111;border-top:none;padding:6px 10px"><b><u>Filters:</u></b> &nbsp; Shape: All &nbsp;&nbsp; Cut List: -</div>
    <table style="margin-top:14px">
      <tr><th class="r">Qty</th><th class="c">UOM</th><th>Form</th><th>Grade</th><th>Size</th>
        <th class="c">Finish</th><th class="c">P.O. #</th><th class="r">Unit Price</th><th class="r">Amount</th></tr>
      ${lines.map((l) => {
        const v = displayValues(l.it, doc);
        return `<tr style="border-bottom:1px solid #999"><td class="r">${l.qty}</td><td class="c">${l.uom}</td>
          <td>${esc(v.form)}</td><td>${esc(v.grade)}</td><td style="white-space:nowrap">${esc(v.size)}</td>
          <td class="c">${esc(v.finish)}</td><td class="c">${esc(doc.job)}</td>
          <td class="r">${money(l.price)}</td><td class="r">${money(l.qty * l.price)}</td></tr>`;
      }).join("")}
      <tr><td colspan="8" class="r"><b>Total</b></td><td class="r"><b>${money(total)}</b></td></tr>
    </table>
    <p class="muted">Unit prices are last-paid prices. Please quote current pricing and availability. MTRs required.</p>`,
  }),

  // Corporate RFQ: colored title band, two address boxes, striped table with line numbers.
  rfq: (doc, cust, lines, total) => ({
    css: `
      body { font-family: "Segoe UI", Calibri, Arial, sans-serif; }
      .band { background: #0f4c5c; color: #fff; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
      .box { border: 1px solid #b9cfd4; border-radius: 6px; padding: 8px 12px; flex: 1; }
      .box h4 { margin: 0 0 4px; font-size: 8pt; color: #0f4c5c; letter-spacing: 1px; text-transform: uppercase; }
      .items th { background: #e3eef0; color: #0f4c5c; font-size: 8.5pt; text-transform: uppercase; border-bottom: 2px solid #0f4c5c; }
      .items tr:nth-child(even) td { background: #f5f9fa; }`,
    body: `
    <div class="band">
      <div><div style="font-size:20pt;font-weight:600">${esc(cust.docName)}</div>
        <div style="opacity:.85">${cust.address.map(esc).join(" | ")}</div></div>
      <div class="r"><div style="font-size:16pt;letter-spacing:2px">REQUEST FOR QUOTE</div>
        <div>RFQ # ${esc(doc.job)} &nbsp;|&nbsp; ${esc(doc.date)}</div></div>
    </div>
    <div style="display:flex;gap:12px;margin:14px 0">
      <div class="box"><h4>Customer</h4>${esc(cust.docName)}<br>${esc(cust.phone)}</div>
      <div class="box"><h4>Deliver to</h4>${esc(cust.docName)}<br>${cust.address.map(esc).join("<br>")}</div>
      <div class="box"><h4>Project</h4>${esc(doc.jobDescription)}<br>Quote needed within 5 business days</div>
    </div>
    <table class="items">
      <tr><th class="c">#</th><th>Form</th><th>Grade</th><th>Size</th><th class="c">Finish</th>
        <th class="r">Qty</th><th class="c">UOM</th><th class="r">Target Price</th><th class="r">Extended</th></tr>
      ${lines.map((l, n) => {
        const v = displayValues(l.it, doc);
        return `<tr><td class="c">${n + 1}</td><td>${esc(v.form)}</td><td>${esc(v.grade)}</td>
          <td class="nw">${esc(v.size)}</td><td class="c">${esc(v.finish)}</td><td class="r">${l.qty}</td>
          <td class="c">${l.uom}</td><td class="r">$${money(l.price)}</td><td class="r">$${money(l.qty * l.price)}</td></tr>`;
      }).join("")}
    </table>
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <div style="background:#0f4c5c;color:#fff;padding:8px 16px;font-size:12pt">Estimated Total &nbsp; <b>$${money(total)}</b></div></div>
    <p class="muted" style="margin-top:18px">Terms: Net 30. Include lead time and MTRs. Target prices are budget figures only.</p>`,
  }),

  // Internal purchase requisition: serif type, monogram, one stacked "Material" cell per line.
  requisition: (doc, cust, lines, total) => ({
    css: `
      body { font-family: Georgia, "Times New Roman", serif; font-size: 10.5pt; }
      .mono { width: 54px; height: 54px; border: 2px solid #6b4f2a; color: #6b4f2a; border-radius: 50%;
        display: flex; align-items: center; justify-content: center; font-size: 15pt; font-weight: bold; }
      .meta td { border: 1px solid #c8bca8; background: #faf7f1; }
      .items td { border-bottom: 1px dotted #9a8a70; padding: 8px 6px; }
      .items th { border-top: 2px solid #6b4f2a; border-bottom: 2px solid #6b4f2a; font-variant: small-caps; }
      .lbl { color: #6b4f2a; font-size: 8.5pt; font-variant: small-caps; }`,
    body: `
    <div style="display:flex;gap:14px;align-items:center">
      <div class="mono">${esc(cust.docName.split(/\s+/).map((w) => w[0]).join("").slice(0, 3))}</div>
      <div style="flex:1"><div style="font-size:17pt">${esc(cust.docName)}</div>
        <div class="muted">Production Purchasing &middot; ${cust.address.map(esc).join(", ")}</div></div>
      <div class="r" style="font-size:14pt;font-style:italic">Purchase Requisition</div>
    </div>
    <table class="meta" style="margin:14px 0">
      <tr><td><span class="lbl">Requisition No.</span><br>${esc(doc.job)}</td><td><span class="lbl">Date</span><br>${esc(doc.date)}</td>
        <td><span class="lbl">Customer</span><br>${esc(cust.docName)}, ${esc(cust.phone)}</td>
        <td><span class="lbl">Charge To</span><br>${esc(doc.jobDescription)}</td></tr>
    </table>
    <table class="items">
      <tr><th style="width:6%">Ln</th><th>Material</th><th class="r">Quantity</th><th class="r">Est. Unit Cost</th><th class="r">Est. Total</th></tr>
      ${lines.map((l, n) => {
        const v = displayValues(l.it, doc);
        return `<tr><td>${n + 1}.</td>
          <td><span class="lbl">Form</span> ${esc(v.form)} &nbsp; <span class="lbl">Grade</span> ${esc(v.grade)}<br>
            <span class="lbl">Size</span> ${esc(v.size)} &nbsp; <span class="lbl">Finish</span> ${esc(v.finish)}</td>
          <td class="r">${l.qty} ${l.uom}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.qty * l.price)}</td></tr>`;
      }).join("")}
      <tr><td colspan="4" class="r" style="border:none;font-style:italic">Estimated requisition total</td>
        <td class="r" style="border:none;border-top:2px solid #6b4f2a"><b>${money(total)}</b></td></tr>
    </table>
    <div style="display:flex;gap:40px;margin-top:50px">
      <div style="flex:1;border-top:1px solid #111;padding-top:4px">Requested by: ${esc(cust.docName)} Purchasing</div>
      <div style="flex:1;border-top:1px solid #111;padding-top:4px">Approved by</div></div>`,
  }),

  // Engineering bill of material: landscape, full grid, dark header, title block in the corner.
  bom: (doc, cust, lines, total) => ({
    css: `
      @page { size: Letter landscape; margin: 0.4in; }
      body { font-family: "Courier New", Consolas, monospace; font-size: 9.5pt; }
      .grid td, .grid th { border: 1px solid #333; }
      .grid th { background: #222; color: #fff; font-size: 8.5pt; }
      .tb td { border: 1px solid #333; font-size: 8.5pt; }`,
    body: `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px double #222;padding-bottom:6px">
      <div><div style="font-size:18pt;font-weight:bold">BILL OF MATERIAL</div><div>PIPING MATERIAL TAKE-OFF - FOR PRICING</div></div>
      <div style="font-size:13pt;font-weight:bold">${esc(cust.docName.toUpperCase())}</div>
    </div>
    <table class="grid" style="margin-top:12px">
      <tr><th>ITEM</th><th>QTY</th><th>U/M</th><th>FORM</th><th>GRADE</th><th>SIZE</th><th>FINISH</th><th>UNIT $</th><th>TOTAL $</th><th>REMARKS</th></tr>
      ${lines.map((l, n) => {
        const v = displayValues(l.it, doc);
        return `<tr><td class="c">${String(n + 1).padStart(3, "0")}</td><td class="r">${l.qty}</td><td class="c">${l.uom}</td>
          <td>${esc(v.form)}</td><td>${esc(v.grade)}</td><td class="nw">${esc(v.size)}</td><td class="c">${esc(v.finish)}</td>
          <td class="r">${money(l.price)}</td><td class="r">${money(l.qty * l.price)}</td><td>${n % 3 === 0 ? "MTR REQ'D" : ""}</td></tr>`;
      }).join("")}
      <tr><td colspan="8" class="r"><b>BOM TOTAL</b></td><td class="r"><b>${money(total)}</b></td><td></td></tr>
    </table>
    <table class="tb" style="width:55%;margin-left:auto;margin-top:16px">
      <tr><td>PROJECT</td><td colspan="3">${esc(doc.jobDescription)}</td></tr>
      <tr><td>JOB NO.</td><td>${esc(doc.job)}</td><td>DATE</td><td>${esc(doc.date)}</td></tr>
      <tr><td>CUSTOMER</td><td>${esc(cust.docName)}</td><td>PHONE</td><td>${esc(cust.phone)}</td></tr>
      <tr><td>SHIP TO</td><td colspan="3">${cust.address.map(esc).join(", ")}</td></tr>
      <tr><td>REV</td><td>0</td><td>SHEET</td><td>1 OF 1</td></tr>
    </table>`,
  }),

  // Fill-in request form: no item table, one labeled card per item.
  requestForm: (doc, cust, lines, total) => ({
    css: `
      body { font-family: Verdana, Tahoma, sans-serif; font-size: 9pt; }
      .field { border-bottom: 1px solid #888; padding: 2px 4px; min-width: 120px; display: inline-block; font-weight: bold; color: #1a3d8f; }
      .card { border: 1.5px solid #1a3d8f; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; page-break-inside: avoid; }
      .card .no { background: #1a3d8f; color: #fff; border-radius: 50%; width: 22px; height: 22px; display: inline-flex;
        align-items: center; justify-content: center; font-weight: bold; margin-right: 8px; }
      .kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; margin-top: 6px; }
      .kv div span { display: block; font-size: 7.5pt; color: #666; text-transform: uppercase; }`,
    body: `
    <div style="text-align:center;border-bottom:3px solid #1a3d8f;padding-bottom:6px">
      <div style="font-size:16pt;font-weight:bold;color:#1a3d8f">MATERIAL REQUEST FORM</div>
      <div class="muted">Please complete all fields and return for pricing</div></div>
    <div style="margin:12px 0;line-height:2.1">
      Company: <span class="field">${esc(cust.docName)}</span> &nbsp; Request #: <span class="field">${esc(doc.job)}</span>
      &nbsp; Date: <span class="field">${esc(doc.date)}</span><br>
      Phone: <span class="field">${esc(cust.phone)}</span><br>
      Job: <span class="field">${esc(doc.jobDescription)}</span><br>
      Ship To: <span class="field">${cust.address.map(esc).join(", ")}</span></div>
    ${lines.map((l, n) => {
      const v = displayValues(l.it, doc);
      return `<div class="card"><span class="no">${n + 1}</span><b>Item ${n + 1}</b>
        <div class="kv">
          <div><span>Form</span>${esc(v.form)}</div><div><span>Grade</span>${esc(v.grade)}</div>
          <div><span>Size</span>${esc(v.size)}</div><div><span>Finish</span>${esc(v.finish)}</div>
          <div><span>Quantity</span>${l.qty} ${l.uom}</div><div><span>Price per ${l.uom}</span>$${money(l.price)}</div>
          <div><span>Line total</span>$${money(l.qty * l.price)}</div><div><span>Required</span>ASAP</div>
        </div></div>`;
    }).join("")}
    <div class="r" style="font-size:11pt;margin-top:6px">Request total: <b>$${money(total)}</b></div>
    <p class="muted">&#9744; Partial shipment OK &nbsp;&nbsp; &#9745; Certs required &nbsp;&nbsp; &#9744; Will pick up</p>`,
  }),
};

const render = (doc, cust, lines) => {
  const total = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  const { css, body } = layouts[doc.layout](doc, cust, lines, total);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.file)}</title>
    <style>${CSS}${css}</style></head><body>${body}</body></html>`;
};

const expectedFor = (doc, cust, lines) => ({
  document: `${doc.file}.pdf`,
  customer: { customerId: doc.customer, customerName: cust.name, textInPdf: cust.docName,
    filter: cust.search === "startswith"
      ? `startswith(CustomerName,'${odata(cust.docName)}')`
      : `substringof('${odata(cust.docName)}',CustomerName)` },
  jobNumber: doc.job,
  date: doc.date,
  lines: lines.map((l, n) => ({
    line: n + 1,
    textInPdf: displayValues(l.it, doc),
    invex: { prm_frm: l.it.prm_frm, grd_grd: l.it.grd_grd, prm_size: l.it.prm_size, prm_fnsh: l.it.prm_fnsh },
    acumaticaDescription: l.it.description,
    filter: displayFilter(l.it, doc),
    qty: l.qty,
    uom: l.uom,
    unitPrice: l.price,
    extPrice: round2(l.qty * l.price),
  })),
  total: round2(lines.reduce((s, l) => s + l.qty * l.price, 0)),
});

// ---------- run ----------
const findBrowser = () => {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Microsoft Edge or Google Chrome not found");
  return found;
};

const main = () => {
  console.log(`Read ${catalog.length} items from ${path.relative(process.cwd(), INPUT_CSV)}`);
  [OUT_PDF, OUT_EXPECTED, OUT_HTML].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdfgen-"));
  const used = new Set();
  try {
    for (const doc of DOCUMENTS) {
      const cust = CUSTOMERS[doc.customer];
      const lines = pickLines(doc, used); // always pick, so every document keeps the same items
      if (ONLY && !doc.file.includes(ONLY)) continue;
      const htmlPath = path.join(OUT_HTML, `${doc.file}.html`);
      const pdfPath = path.join(OUT_PDF, `${doc.file}.pdf`);
      fs.writeFileSync(htmlPath, render(doc, cust, lines));
      execFileSync(browser, [
        "--headless", "--disable-gpu", "--no-pdf-header-footer", "--print-to-pdf-no-header",
        `--user-data-dir=${profile}`, `--print-to-pdf=${pdfPath}`,
        "file:///" + htmlPath.replace(/\\/g, "/"),
      ], { stdio: "ignore" });
      fs.writeFileSync(path.join(OUT_EXPECTED, `${doc.file}.json`), JSON.stringify(expectedFor(doc, cust, lines), null, 2));
      console.log(`Created ${path.relative(process.cwd(), pdfPath)} (${lines.length} lines)`);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
};

main();
