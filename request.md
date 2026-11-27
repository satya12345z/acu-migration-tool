# Acumatica lookup (REST GET)

```
GET {baseUrl}/entity/Default/24.200.001/{Entity}?$filter=...&$select=...&$top=10
Authorization: Bearer {token}
```

**Functions:** `startswith(Field,'x')`, `endswith(Field,'x')`, `substringof('x',Field)` (text first). Combine them with `and`.

**Rules:** case-insensitive; write each `'` as `''`; match spacing exactly; URL-encode the query.

## Customer
```
Customer?$filter=startswith(CustomerName,'ABC Capital')&$select=CustomerID,CustomerName
```
If the start of the name doesn't match, use `substringof`. If more than one customer is returned, add more of the name.

## StockItem
`Description` = form code + grade code + size code + finish + form desc + grade desc + size desc

- Form code (+ grade code) → `startswith`
- Size description → `endswith`
- Finish + form desc → `substringof('AMLPipe-Carbon-Seamless',Description)`
- Grade → `substringof`

```
StockItem?$filter=startswith(Description,'CSWGWP304S') and endswith(Description,'3/4" x 3/8" S/80')&$select=InventoryID,Description
```

Use the item only when exactly one Active row is returned. Otherwise, flag the line for review.
