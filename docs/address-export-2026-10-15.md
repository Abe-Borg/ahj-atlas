# Exporting project addresses — October 15, 2026

**Before.** Exports were per project: open a project and choose PDF, Excel, Excel essentials or JSON. Getting the addresses of several projects into one list meant opening each project and copying its address by hand.

**Now.** **Export addresses** in the sidebar opens a checklist of every project. The user chooses which projects to include and downloads one CSV or Excel file with a row per project.

## Design

- **What the file holds.** Project name, address, country, parcel or site description, and discipline (`addressRows` in `lib/exports.mjs`). Nothing from the report, sources or costs. Projects saved before the country field existed read as United States, as they do in the project header.
- **CSV.** UTF-8 with a byte-order mark so Excel on Windows reads accented names, CRLF rows, and RFC 4180 quoting for commas, quotes and line breaks. A cell starting with `=`, `+`, `-`, `@`, a tab or a return gets a leading apostrophe so a spreadsheet does not run it as a formula. The workbook (`addressWorkbook`) reuses the report workbook's sheet styling, now the shared `addSheet`, which writes every cell as text.
- **Route.** `GET /api/addresses/export?format=csv|xlsx&projects=<id>,<id>,…` in `createServices.route`. IDs are de-duplicated and exported in the order given; the dialog sends them in sidebar order. An empty selection or another format is a 400; an ID with no project is a 404 and nothing is written. Like the per-project exports it is a GET, so the browser download and the desktop's `will-download` path handle it the same way.
- **Long selections.** The IDs travel in the link, about 37 characters each. Node's default 16 KB header limit would refuse a link naming roughly 400 projects with a 431, so `createApp` sets `maxHeaderSize` to 64 KB. The dialog refuses a link longer than 60,000 characters with a message to export in parts.
- **Desktop.** `desktop/downloads.mjs` accepts `/api/addresses/export` only with `format` and `projects` parameters, `csv` or `xlsx`, and a comma-separated list of hex-and-hyphen IDs. The save filter is **CSV file** or **Excel workbook**. The filename is `AHJ Atlas project addresses YYYY-MM-DD.<ext>` (`addressExportFilename`), dated so exports of different selections are easy to tell apart.
- **UI.** The list opens with every project checked. The filter hides rows that do not match name, address, discipline or country; hidden rows keep their checks, and the count says how many checked projects are hidden. **Select all** / **Clear all** become **Select shown** / **Clear shown** while a filter is typed. Export rereads the project list first: a project deleted since the list opened is removed from it with a message, and nothing downloads until the user exports again. The button is hidden while the workspace has no projects.

## Verification

- `node --test tests/address-export.test.mjs`: CSV quoting and formula guard, BOM and CRLF, dated filename, chosen projects only and in the given order, workbook sheet and text cells, refused empty, unknown-format and deleted selections, and a link of more than 40,000 characters accepted (it fails with 431 without the header limit change).
- `node --test tests/desktop-downloads.test.mjs`: the desktop accepts the address link for CSV and Excel, refuses other formats, extra parameters and malformed ID lists, and saves through the CSV filter.
- `node tests/address-export-ui.mjs`: default selection, escaped names, filter, select and clear, a downloaded CSV in sidebar order, a project deleted while the list is open, mobile layout and an empty workspace.
