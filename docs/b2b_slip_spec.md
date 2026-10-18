# b2b_slip_spec.md: B2B 4x6 packing slip

Status: sample approved by Andy, 2026-10-17. Same line format and pack-in treatment as the retail slip. Replaces the contents block of `drawSlipPage()` in `api/ship-doc.js` (current layout read from the portal repo; nothing written there). Sample: `retail_slip_sample_b2b.pdf` (#7407 boxes 1 to 3, #7433 boxes 1 to 2; company name is a placeholder). Generator: `build_b2b_slip_sample.py`.

One page per box, as today (`box_index`, `box_count`, `weight_lb`, `contents`).

| # | Field | Rule |
|---|---|---|
| 1 | Header | "TORQUE COFFEE" 15 pt bold with the logo, rule below (unchanged). |
| 2 | Order line | `#order · company name`, 8 pt (unchanged). |
| 3 | Box band | "BOX N OF M" 15 pt bold, weight in lb at right (unchanged). |
| 4 | CONTENTS | Heading and rule (unchanged). |
| 5 | Lines | `Nx | size | Coffee Name - Producer, Origin`, same rules as the retail slip: bold qty and size, name shrinks 10 to 8 pt, then drops the country, then truncates; never wraps. |
| 6 | Pack-in box | Small boxed band at the bottom: "PACK IN 14x10x10" (13 pt bold). The B2B box label comes from `box.box_label`. |
| 7 | Footer | "Packing list - not a shipping label", 7 pt (unchanged). |

Change from today: lines currently print `2x  Product (variant)`; they print `2x | 5lb | Product` instead. The size comes from the variant title weight (`12oz`, `2lb`, `5lb`, `250g`). The pack-in box is new.

Not changed: box splitting (`packBoxes()`, 20 lb net cap).
