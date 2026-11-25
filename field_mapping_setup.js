const invexfield_to_acumatica_fieldMapping = {
  prm_frm: "Description",
  grd_grd: "Description",

  prm_size: "Description",
  prm_fnsh: "Description",

  frm_desc25: "Description",
  grd_desc25: "Description",
  prm_size_desc: "Description",
  

  // frm_desc15: "Description",
  // grd_desc15: "Description",
  // prm_shrt_size_desc: "Description",
};

const FIELD_MAPPING_DELIMITER = "";

// Acumatica field -> value applied to every record (defaults from the sample Stock Item).
const FIXED_VALUES = {
  ItemStatus: "Active",
  ItemClass: "ALLOTHER",
  ItemType: "Finished Good", // Acumatica's field name is ItemType (not Type)
  LotSerialClass: "NOTTRACKED",
  PostingClass: "CON",
  BaseUOM: "EA",
  SalesUOM: "EA",
  PurchaseUOM: "EA",
  TaxCategory: "TAXABLE",
  // Uncomment to apply the same price/cost/weight/volume to every item:
  // DefaultPrice: 100,
  // DefaultCost: 50,
  // Weight: 2,
  // Volume: 1,
};

const MATCH_FIELD = "Description";

// InventoryID is generated as: <value of INVENTORY_ID_PREFIX_FIELD><SEPARATOR><running number>
// e.g. "10D451000", "10D451001". Numbering is per prefix and continues
// after the highest number already in Acumatica for that prefix.
// Set INVENTORY_ID_PREFIX_FIELD to "" to let Acumatica auto-number instead.
const INVENTORY_ID_PREFIX_FIELD = "prm_frm";
const INVENTORY_ID_SEPARATOR = "";
const INVENTORY_ID_START_NUMBER = 1000;
// Length of the INVENTORY segmented key in Acumatica (Segmented Keys, CS202000).
// Longer IDs are cut off by Acumatica, so such rows are failed instead of saved.
const INVENTORY_ID_MAX_LENGTH = 10;

const DEFAULT_INPUT_CSV_FILE = "inputs/test.csv";

const FAIL_CSV_FILE = "outputs/fail.csv";

const GENERATE_SUCCESS_CSV_FILE = true;
const SUCCESS_CSV_FILE = "outputs/success.csv";

const PARALLEL_REQUESTS = 2;

module.exports = {
  fieldMapping: invexfield_to_acumatica_fieldMapping,
  FIELD_MAPPING_DELIMITER,
  FIXED_VALUES,
  MATCH_FIELD,
  INVENTORY_ID_PREFIX_FIELD,
  INVENTORY_ID_SEPARATOR,
  INVENTORY_ID_START_NUMBER,
  INVENTORY_ID_MAX_LENGTH,
  DEFAULT_INPUT_CSV_FILE,
  FAIL_CSV_FILE,
  GENERATE_SUCCESS_CSV_FILE,
  SUCCESS_CSV_FILE,
  PARALLEL_REQUESTS,
};
