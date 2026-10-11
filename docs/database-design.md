# Database design

The household data lives in the Azure SQL database `pantry` on `charlotte-inventory2.database.windows.net`. This page documents the phase 2 design (made by [`database/phase2-upgrade.sql`](../database/phase2-upgrade.sql)) and the phase 1 tables it replaces, each as a crow's foot entity-relationship diagram and a UML class diagram.

The table definitions are in [`database/create-tables.sql`](../database/create-tables.sql). The diagrams are drawn by hand into the SVG files in [`docs/diagrams`](diagrams).

## Reading the UML diagrams

**Each box is one table**

![Each box is one table](diagrams/uml-class.svg)

The small name in angle brackets at the top, like <<inventory>>, is the real SQL table. The bigger name under it is a friendly name for one row of that table. Each line below is one column: the SQL type, the column name, then PK (part of the primary key), FK (points at another table) or UNIQUE. The + at the start of each line is standard UML decoration and can be ignored.

**Filled diamond: "belongs to"**

![Filled diamond: "belongs to"](diagrams/uml-composition.svg)

The diamond sits on the owner. Recipe ingredients belong to their recipe, so deleting a recipe deletes its ingredients too (ON DELETE CASCADE). Used for recipe ingredients, votes and meal plan entries.

**Plain line: "points at"**

![Plain line: "points at"](diagrams/uml-association.svg)

One table refers to another with a foreign key, and the database refuses a row that points at something missing. Nothing is deleted automatically.

**Numbers at the ends: "how many"**

![Numbers at the ends: "how many"](diagrams/uml-optional.svg)

Read across the line, using the number at the far end. Store 1 to Price 0..* means one store has any number of prices, and each price is at exactly 1 store. 1 = exactly one. 0..1 = none or one (optional, e.g. a log line with nobody logged in). 0..* = any number, including none.

**Dashed arrow: "looked up by name"**

![Dashed arrow: "looked up by name"](diagrams/uml-dependency.svg)

There is no foreign key yet. The website code finds the matching row by comparing names, and the arrow points at the table being looked up. The ingredients table, planned after phase 2, turns these into real links.

## Phase 2

Adds `people`, `stores` and `locations`, and links the other tables to them.

- Number ids are used only for people. Every other table is keyed by its real-world identity, using a composite key where one column is not enough.
- Foreign keys that point at a natural key (store_name, location_code) get ON UPDATE CASCADE, so renaming a store or storage area carries through to every row that uses it.
- Text keys compare without regard to capitals (the database collation is case-insensitive), the same way the site compares names.
- activity_log swaps its separate date and time columns for one exact logged_at time. The NZ date and time are worked out with AT TIME ZONE when reading.
- watch_list loses its Date.now() id. The Price Checker page removes a watched product by store, name and size instead.
- prices loses its id too. Saved prices are sorted by date_checked.
- The store list, the "Our N stores" search and who can log in now come from the stores and people tables, so adding a store or a person is one INSERT.
- The CSV fallback is retired. The old CSV files stay on the garage and in /root/csv-backup-2026-10-11 as an archive.

### Every table and its columns

| Table | Primary key | Other columns | Why that key |
|---|---|---|---|
| `people` | `person_id (INT IDENTITY)` | name | The only number id. Every other table stores person_id, never the name, so renaming someone changes one row. |
| `stores` | `store_name` | chain, suburb, store_code, is_main_store, is_preferred, is_active | The name the scrapers, the store dropdown and the price history already use, e.g. Woolworths Ferrymead. |
| `locations` | `location_code` | location_name, storage_type, sort_order | Short fixed codes (pantry, fridge, freezer, chest), with the friendly name beside each. |
| `inventory` | `location_code + name + unit` | quantity, track, low | One row per thing, per place, per unit. The site already enforces this rule when it merges stock. |
| `recipes` | `recipe_id` | name, instructions, servings | The existing text code (from Date.now() when added), so nothing the pages already know changes. |
| `recipe_ingredients` | `recipe_id + ingredient_name + unit` | quantity, sort_order | One row per ingredient per unit in a recipe ("2 tbsp butter" and "50 g butter" can both be listed). sort_order keeps the recipe's own order. |
| `recipe_votes` | `recipe_id + person_id` | vote | One vote per person per recipe. |
| `meal_plan` | `day + recipe_id` | people_count | Several recipes a day, each recipe once per day. |
| `ingredient_aliases` | `alias` | canonical_name | Each alternative name points to one main name. |
| `prices` | `store_name + item_name + date_checked` | price, cup_price, cup_measure, package_size, original_name | One price per product, per store, per moment. Full history, never updated. |
| `activity_log` | `logged_at + line_no` | person_id, action, item, quantity, unit, location_code, details | The exact time of a change, plus line 1, 2, 3 for changes that log several rows at once (I made this). No number id: the time is the identity. |
| `stock_minimums` | `name + unit` | minimum | One minimum per item and unit. |
| `barcodes` | `barcode` | item_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added | Your own barcode database: the number under the bars, with your name for the product, its brand and its full name. |
| `watch_list` | `store_name + item_name + package_size` | search_term, added_by_person_id, date_added | The same rule the site already uses to stop the same product being starred twice. |

### Crow's foot diagram

Dotted lines are matched by name in the website code, not by a foreign key.

![Phase 2 crow's foot diagram](diagrams/p2-er.svg)

### UML class diagram

![Phase 2 UML class diagram](diagrams/p2-uml.svg)

## Phase 1 (replaced by phase 2)

The tables as first moved off the CSV files on 11 October 2026. Each mirrored one CSV file. Only recipes were linked by foreign keys.

### Crow's foot diagram

Dotted lines are matched by name in the website code, not by a foreign key.

![Phase 1 crow's foot diagram](diagrams/p1-er.svg)

### UML class diagram

![Phase 1 UML class diagram](diagrams/p1-uml.svg)

## Later: the ingredients table

The next step after phase 2 is an ingredients table keyed by the ingredient name. ingredient_aliases, inventory, recipe_ingredients, stock_minimums and barcodes would then point at it with real foreign keys, and the dotted lines become solid.
