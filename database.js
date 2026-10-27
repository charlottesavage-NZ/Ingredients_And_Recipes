// -------------------------------------------------------------
// THE AZURE SQL DATABASE
// -------------------------------------------------------------
// Everything that talks to the database lives in this one file, so
// server.js barely has to know it exists. server.js still thinks in
// terms of its old CSV files ("read pantry.csv", "save this list as
// recipes.csv") - this file turns each of those into the matching
// SQL against the tables made by database/create-tables.sql.
//
// The database settings live in the gitignored database-config.js
// file. (UPDATE, phase 2: the CSV files are retired, so the site
// needs that file to run - server.js stops with a clear message if
// it's missing. database.enabled says whether it was found.)
//
// Every row handed back looks EXACTLY like a row from parseCSV():
// every value is text, a missing value is '' (not null), "running
// low" is 'yes' or '' - so none of the code in server.js that
// already works on CSV rows has to change.
//
// UPDATE, phase 2: the tables now point at each other by key -
// person_id for people, store_name for stores, location_code for the
// storage areas - but server.js still works with names ("Todd",
// "Woolworths Ferrymead", "Fridge"). This file swaps between the two:
// reads look the name up from the key, and saves look the key up from
// the name, both inside the SQL (see "lookup" below).
//
// UPDATE, phase 3: the ingredients table. Stock, recipe ingredients,
// minimums, barcodes and aliases keep the name as typed, plus an
// "ingredient" value - the ingredient it counts as - which server.js
// works out (see linkIngredients() there) and this file saves into
// each table's ingredient_name column, a foreign key to ingredients.
//
// UPDATE, phase 5: products by barcode (database/products-upgrade.sql).
// - the barcodes table became "products" - one row per real product,
//   keyed by its barcode. server.js calls it 'products' now.
// - store_products links each supermarket chain's own product code
//   (e.g. PAK'nSAVE's "5001949-EA-000") to a barcode - see
//   linkStoreProducts() (replaced in phase 7 - see below)
// - every saved price keeps that product code, and reading prices
//   hands back the barcode it links to (if it's been linked yet)
// - the minimums moved onto the ingredients table, but server.js still
//   reads and saves them as 'stock_minimums.csv' (see setColumns below)
//
// UPDATE, phase 7: every price points at a product
// (database/product-ids-upgrade.sql).
// - products has a number key, product_id, and the barcode is optional
//   (most products now come from price checks, and many never get one)
// - store_products links each chain's product code to a product_id.
//   Stores with no codes (Trents) use "name:" + the saved name instead.
// - prices are saved by savePrices() at the bottom of this file, which
//   finds (or makes) each price's product first. Prices also record
//   specials: is_special, was_price, special_type, special_note.
// - linkBarcode() runs dbo.usp_link_barcode, which links a barcode to a
//   product code - merging two products when they turn out to be one
//
// The free Azure SQL Database pauses itself when nobody's using it,
// and every minute it's awake counts against the free monthly
// allowance. So this file:
// - never connects when the server starts (the garage restarts it
//   every hour) - only when a page actually asks for something
// - closes its connections again 30 seconds after the last request,
//   because the database can't pause while a connection is open
// - waits and tries again (up to about a minute) when the database
//   says it's still waking up
// -------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// -------------------------------------------------------------
// The connection details live in their own gitignored file, never
// typed into this one - same idea as credentials.js. It looks like
// database-config.example.js (which IS in git, with no real password).
// -------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, 'database-config.js');

let config = null;
if (fs.existsSync(CONFIG_FILE)) {
    config = require(CONFIG_FILE);
}

const enabled = Boolean(config);

// Only load the database driver when it's actually going to be used.
const sql = enabled ? require('mssql') : null;

// -------------------------------------------------------------
// Which table (and which columns) each old CSV file now lives in.
//
// Each column says:
// - csv:      its name in the CSV file / in server.js
// - column:   its name in the database table, if different
// - type:     the T-SQL type, used when the rows are unpacked from
//             JSON in the SQL (see "How saving works" further down)
// - kind:     how to turn the text value into a database value and
//             back again: 'text', 'number', 'yesno' ('yes' <-> 1),
//             'bool' (true/false), 'datetime' (full ISO date/time
//             text) or 'date' (just "2026-10-14")
// - required: the table column is NOT NULL, so a blank becomes ''
//             (text) or 0 (number) instead of NULL
// - orUse:    if this value is blank, use that other column's value
//             instead (e.g. an ingredient link falls back to the name
//             as typed, so it's never empty) (UPDATE, phase 3)
// - lookup:   the table stores another table's KEY, but server.js
//             works with a NAME. e.g. recipe_votes.person_id holds 2,
//             server.js sees person: "Todd". { table, key, label,
//             match } = look in table, where any of the match columns
//             equals the name, and use its key (and on reading, show
//             its label column)
// - position: filled in by the database with the row's place in the
//             list (1, 2, 3...) - e.g. a recipe's ingredient order
// - now:      filled in by the database with the exact time right now
// - readSql:  read-only, worked out by this SQL instead of stored
//
// And each table says:
// - where:    extra fixed columns, e.g. pantry.csv is the inventory
//             table's rows WHERE location_code = 'pantry'
// - key:      what makes a row unique, by server.js's names (matched
//             ignoring capitals, same as the database does). Saving a
//             list with two rows that clash on this would be refused
//             by the database, so they're combined first - see dedupe().
// - mergeQuantities: combining two clashing rows ADDS their quantities
//             together (500 g + 250 g rice = 750 g rice) instead of
//             keeping just the last one
// - recipeChild: rows belong to a recipe (recipe_id). Any row whose
//             recipe no longer exists is quietly left out when
//             saving, the same as ON DELETE CASCADE would have done.
// - mergeSave: save with MERGE (update/insert/delete row by row)
//             instead of "delete everything, insert the new list".
//             Needed for recipes: deleting every recipe, even for a
//             moment inside a transaction, would CASCADE and wipe out
//             every recipe's ingredients, votes and meal plan entries.
// - keepMissing: (with mergeSave) a row that's NOT in the list being
//             saved is kept instead of deleted. Needed for products:
//             a product a supermarket code points at can't be deleted,
//             and one might be added by a price check while a barcode
//             is being saved (UPDATE, phase 5)
// - setColumns: the "file" is really just a few COLUMNS of another
//             table's rows - the minimums live on the ingredients table.
//             Saving never adds or deletes a row: it empties those
//             columns on every row, then fills them in again for the
//             rows in the list (matched on the key). readWhere says
//             which rows count when reading (UPDATE, phase 5)
// - addMissingStores: before saving, any store name not in the
//             stores table yet is added to it (switched off, with no
//             store code), so a price is never refused over its store
// - addMissingIngredients: the same for ingredients - any ingredient
//             name not in the ingredients table yet is added (as one of
//             yours) before saving (UPDATE, phase 3)
// - uniqueTime: when adding rows, two that would share the same key
//             AND the same millisecond get the second one moved on by
//             1 ms, so neither is refused
// - deriveId: an id server.js and the pages can use, made from the
//             row's own key (the watch list has no id column)
// - orderBy:  the order rows come back in
// -------------------------------------------------------------
const PEOPLE_LOOKUP = { table: 'dbo.people', key: 'person_id', label: 'name', match: ['name'] };
const STORE_LOOKUP = { table: 'dbo.stores', key: 'store_name', label: 'store_name', match: ['store_name'] };
// The pages send a storage area's code ("fridge"), the activity log
// sends its friendly name ("Fridge") - either is found.
const LOCATION_CODE_LOOKUP = { table: 'dbo.locations', key: 'location_code', label: 'location_code', match: ['location_code', 'location_name'] };
const LOCATION_NAME_LOOKUP = { table: 'dbo.locations', key: 'location_code', label: 'location_name', match: ['location_code', 'location_name'] };

// The link to the ingredients table that phase 3 added to several
// tables. server.js fills in "ingredient"; if it's ever missing, the
// name as typed is used, which then becomes a new ingredient.
// (UPDATE, phase 5: optional = the link can be left empty - NULL -
// which products need, for a product a supermarket told us about
// before anyone at home has named it.)
function ingredientLink(typedNameField, optional) {
    return { csv: 'ingredient', column: 'ingredient_name', type: 'NVARCHAR(200)', kind: 'text', required: !optional, orUse: typedNameField };
}

function inventoryTable(location) {
    return {
        table: 'dbo.inventory',
        where: { location_code: location },
        key: ['name', 'unit'],
        mergeQuantities: true,
        addMissingIngredients: 'ingredient',
        orderBy: 'name',
        columns: [
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number', required: true },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'track', type: 'NVARCHAR(10)', kind: 'text' },
            { csv: 'low', type: 'BIT', kind: 'yesno', required: true },
            ingredientLink('name')
        ]
    };
}

const TABLES = {
    'pantry.csv': inventoryTable('pantry'),
    'fridge.csv': inventoryTable('fridge'),
    'freezer.csv': inventoryTable('freezer'),
    'chest.csv': inventoryTable('chest'),

    'recipes.csv': {
        table: 'dbo.recipes',
        key: ['id'],
        mergeSave: true,
        orderBy: 'recipe_id',
        columns: [
            { csv: 'id', column: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'instructions', type: 'NVARCHAR(MAX)', kind: 'text', required: true },
            { csv: 'servings', type: 'INT', kind: 'number' }
        ]
    },

    'recipe_ingredients.csv': {
        table: 'dbo.recipe_ingredients',
        key: ['recipe_id', 'ingredient_name', 'unit'],
        mergeQuantities: true,
        recipeChild: true,
        addMissingIngredients: 'ingredient',
        orderBy: 'recipe_id, sort_order',
        columns: [
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            // (UPDATE, phase 3: the name as the recipe words it is the
            // "name" column now; ingredient_name is the link below.)
            { csv: 'ingredient_name', column: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            ingredientLink('ingredient_name'),
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'sort_order', type: 'INT', kind: 'number', position: true }
        ]
    },

    'recipe_votes.csv': {
        table: 'dbo.recipe_votes',
        key: ['recipe_id', 'person'],
        recipeChild: true,
        orderBy: 'recipe_id, person_id',
        columns: [
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'person', column: 'person_id', type: 'NVARCHAR(50)', kind: 'text', required: true, lookup: PEOPLE_LOOKUP },
            { csv: 'vote', type: 'NVARCHAR(10)', kind: 'text', required: true }
        ]
    },

    // (UPDATE, phase 3: every alias now - the built-in ones too - each
    // pointing at an ingredient. canonical_name is the ingredient_name
    // column, and source says built_in or yours.)
    'ingredient_aliases.csv': {
        table: 'dbo.ingredient_aliases',
        key: ['alias'],
        addMissingIngredients: 'canonical_name',
        orderBy: 'alias',
        columns: [
            { csv: 'alias', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'canonical_name', column: 'ingredient_name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'source', type: 'NVARCHAR(10)', kind: 'text', required: true }
        ]
    },

    // ---- The master list of ingredients (UPDATE, phase 3) ----
    'ingredients': {
        table: 'dbo.ingredients',
        key: ['ingredient_name'],
        orderBy: 'ingredient_name',
        columns: [
            { csv: 'ingredient_name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'tin_quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'tin_unit', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'source', type: 'NVARCHAR(10)', kind: 'text', required: true }
        ]
    },

    // (UPDATE, phase 7: read through this, but SAVED by savePrices() -
    // a new price needs its product found or made first, which the
    // general save code can't do. uniqueTime is used by savePrices():
    // a price is one product at one store at one moment, so two rows for
    // the same product in the same millisecond get moved apart.)
    'prices.csv': {
        table: 'dbo.prices',
        addMissingStores: 'store',
        uniqueTime: { key: ['store', 'product_code', 'item_name'], time: 'date_checked' },
        orderBy: 'date_checked',
        columns: [
            { csv: 'store', column: 'store_name', type: 'NVARCHAR(100)', kind: 'text', required: true, lookup: STORE_LOOKUP },
            { csv: 'item_name', type: 'NVARCHAR(300)', kind: 'text', required: true },
            { csv: 'date_checked', type: 'DATETIMEOFFSET(3)', kind: 'datetime', required: true },
            { csv: 'price', type: 'DECIMAL(10,2)', kind: 'number' },
            { csv: 'cup_price', type: 'DECIMAL(10,2)', kind: 'number' },
            { csv: 'cup_measure', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'package_size', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'original_name', type: 'NVARCHAR(300)', kind: 'text' },
            // (UPDATE, phase 5) The supermarket's own code for the
            // product, e.g. PAK'nSAVE "5001949-EA-000" - blank for Trents
            // and for prices saved before phase 5.
            { csv: 'product_code', type: 'NVARCHAR(50)', kind: 'text' },
            // (UPDATE, phase 7) The product this price is for, and that
            // product's barcode - blank until one is linked (see
            // linkBarcode()). Read-only here; savePrices() fills in
            // product_id.
            { csv: 'product_id', kind: 'text', readSql: 't.product_id' },
            { csv: 'barcode', kind: 'text', readSql: '(SELECT p.barcode FROM dbo.products AS p WHERE p.product_id = t.product_id)' },
            // (UPDATE, phase 7) Specials. price is always what you'd
            // actually pay; on special, was_price is the normal price.
            // special_type: 'special', 'club' (needs the club card) or
            // 'multibuy' (e.g. 2 for $5 - price is still the single price).
            // Also 'extra_low' - Pak'nSAVE's everyday low price - which
            // is NOT a special (is_special stays 0), just a kind of price.
            { csv: 'is_special', type: 'BIT', kind: 'yesno', required: true },
            { csv: 'was_price', type: 'DECIMAL(10,2)', kind: 'number' },
            { csv: 'special_type', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'special_note', type: 'NVARCHAR(100)', kind: 'text' }
        ]
    },

    'activity_log.csv': {
        table: 'dbo.activity_log',
        orderBy: 'logged_at, line_no',
        columns: [
            { csv: 'logged_at', type: 'DATETIMEOFFSET(7)', kind: 'datetime', now: true },
            { csv: 'line_no', type: 'INT', kind: 'number', position: true },
            // The NZ date and time, worked out from logged_at when read.
            { csv: 'date', kind: 'text', readSql: "CONVERT(CHAR(10), logged_at AT TIME ZONE 'New Zealand Standard Time', 23)" },
            { csv: 'time', kind: 'text', readSql: "CONVERT(CHAR(5), CAST(logged_at AT TIME ZONE 'New Zealand Standard Time' AS TIME), 108)" },
            { csv: 'person', column: 'person_id', type: 'NVARCHAR(50)', kind: 'text', lookup: PEOPLE_LOOKUP },
            { csv: 'action', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'item', type: 'NVARCHAR(200)', kind: 'text' },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'location', column: 'location_code', type: 'NVARCHAR(50)', kind: 'text', lookup: LOCATION_NAME_LOOKUP },
            { csv: 'details', type: 'NVARCHAR(MAX)', kind: 'text' }
        ]
    },

    // (UPDATE, phase 5: the minimums are now two columns on the
    // ingredients table - minimum_quantity and minimum_unit - so each
    // ingredient has at most one minimum. server.js still sees rows of
    // { name, minimum, unit }; "name" is the ingredient's name.)
    'stock_minimums.csv': {
        table: 'dbo.ingredients',
        setColumns: true,
        readWhere: 't.minimum_quantity IS NOT NULL',
        key: ['ingredient'],
        addMissingIngredients: 'ingredient',
        orderBy: 'ingredient_name',
        columns: [
            { csv: 'name', kind: 'text', readSql: 't.ingredient_name' },
            ingredientLink('name'),
            { csv: 'minimum', column: 'minimum_quantity', type: 'DECIMAL(12,3)', kind: 'number', required: true },
            { csv: 'unit', column: 'minimum_unit', type: 'NVARCHAR(20)', kind: 'text', required: true }
        ]
    },

    // (UPDATE, phase 5: was 'barcodes.csv' / dbo.barcodes. The name and
    // ingredient are optional now - a product learned from a supermarket
    // has neither until someone scans it at home.)
    // (UPDATE, phase 7: products are keyed by product_id now, and only
    // some have a barcode. This "file" is just the ones WITH a barcode -
    // what scanning needs - and saving matches on the barcode, so the
    // products made by price checks are never touched by it.)
    'products': {
        table: 'dbo.products',
        key: ['barcode'],
        mergeSave: true,
        keepMissing: true,
        readWhere: 't.barcode IS NOT NULL',
        addMissingIngredients: 'ingredient',
        orderBy: 'barcode',
        columns: [
            { csv: 'barcode', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'name', column: 'item_name', type: 'NVARCHAR(200)', kind: 'text' },
            ingredientLink('name', true),
            { csv: 'brand', type: 'NVARCHAR(100)', kind: 'text' },
            { csv: 'product_name', type: 'NVARCHAR(300)', kind: 'text' },
            { csv: 'package_size', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'location', column: 'location_code', type: 'NVARCHAR(50)', kind: 'text', lookup: LOCATION_CODE_LOOKUP },
            { csv: 'source', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'added_by', column: 'added_by_person_id', type: 'NVARCHAR(50)', kind: 'text', lookup: PEOPLE_LOOKUP },
            { csv: 'date_added', type: 'DATE', kind: 'date' }
        ]
    },

    'meal_plan.csv': {
        table: 'dbo.meal_plan',
        key: ['day', 'recipe_id'],
        recipeChild: true,
        orderBy: 'day, recipe_id',
        columns: [
            { csv: 'day', type: 'NVARCHAR(10)', kind: 'text', required: true },
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'people', column: 'people_count', type: 'INT', kind: 'number' }
        ]
    },

    'watch_list.csv': {
        table: 'dbo.watch_list',
        key: ['store', 'item_name', 'package_size'],
        addMissingStores: 'store',
        deriveId: row => watchListId(row),
        orderBy: 'date_added, store_name, item_name',
        columns: [
            { csv: 'store', column: 'store_name', type: 'NVARCHAR(100)', kind: 'text', required: true, lookup: STORE_LOOKUP },
            { csv: 'item_name', type: 'NVARCHAR(300)', kind: 'text', required: true },
            { csv: 'package_size', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'search_term', type: 'NVARCHAR(300)', kind: 'text' },
            { csv: 'added_by', column: 'added_by_person_id', type: 'NVARCHAR(50)', kind: 'text', lookup: PEOPLE_LOOKUP },
            { csv: 'date_added', type: 'DATE', kind: 'date' }
        ]
    },

    // ---- Lookup tables server.js reads directly ----
    'stores': {
        table: 'dbo.stores',
        key: ['store_name'],
        orderBy: 'is_preferred DESC, chain, store_name',
        columns: [
            { csv: 'store_name', type: 'NVARCHAR(100)', kind: 'text', required: true },
            { csv: 'chain', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'suburb', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'store_code', type: 'NVARCHAR(200)', kind: 'text' },
            { csv: 'is_main_store', type: 'BIT', kind: 'bool', required: true },
            { csv: 'is_preferred', type: 'BIT', kind: 'bool', required: true },
            { csv: 'is_active', type: 'BIT', kind: 'bool', required: true }
        ]
    },

    'people': {
        table: 'dbo.people',
        key: ['name'],
        orderBy: 'person_id',
        columns: [
            { csv: 'person_id', type: 'INT', kind: 'number', readSql: 'person_id' },
            { csv: 'name', type: 'NVARCHAR(50)', kind: 'text', required: true }
        ]
    }
};

// The watch list has no id column - its key is store + product +
// size. This turns that key into one piece of text the pages can use
// as an id (e.g. for the un-star button). The same key always gives
// the same id.
function watchListId(row) {
    return [row.store, row.item_name, row.package_size || ''].join('|');
}

function tableFor(file) {
    const definition = TABLES[file];
    if (!definition) throw new Error(`No database table set up for ${file}`);
    return definition;
}

function columnName(col) {
    return col.column || col.csv;
}

// Columns server.js sends values for (not ones the database numbers
// itself, and not read-only ones). A "now" column is sent too, so a
// row that already has its own time keeps it - only a blank one gets
// "now".
function sentColumns(definition) {
    return definition.columns.filter(col => !col.position && !col.readSql);
}

// Columns that are actually stored in the table.
function storedColumns(definition) {
    return definition.columns.filter(col => !col.readSql);
}

// -------------------------------------------------------------
// Turning values from server.js (always text, like the CSV) into
// proper database values, and back again.
// -------------------------------------------------------------
function toDatabaseValue(value, col) {
    const text = (value === null || value === undefined) ? '' : String(value).trim();

    if (col.kind === 'number') {
        const number = Number(text);
        if (text === '' || !Number.isFinite(number)) return col.required ? 0 : null;
        // Whole-number columns (servings, people) can't take "4.5".
        return col.type === 'INT' ? Math.round(number) : number;
    }
    if (col.kind === 'yesno' || col.kind === 'bool') {
        return text.toLowerCase() === 'yes' || text === '1' || text.toLowerCase() === 'true' ? 1 : 0;
    }
    if (text === '') return col.required ? '' : null;
    return text;
}

function fromDatabaseValue(value, col) {
    if (col.kind === 'bool') return Boolean(value);
    if (value === null || value === undefined) return '';

    if (col.kind === 'yesno') return value ? 'yes' : '';
    if (value instanceof Date) {
        if (col.kind === 'date') return value.toISOString().slice(0, 10);    // "2026-10-14"
        return value.toISOString();                                         // "2026-10-14T05:05:00.000Z"
    }
    return String(value);
}

// -------------------------------------------------------------
// If a list being saved has two rows that the database would see as
// the same row (e.g. "Rice" and "rice ", both in g), combine them,
// otherwise the whole save would be refused. Stock adds the
// quantities together; anything else keeps the LAST one, the same
// way the routes in server.js treat a repeat as "replace it".
// The database ignores capitals and trailing spaces when comparing,
// so the match here does too.
// -------------------------------------------------------------
function keyOf(row, names) {
    return names.map(name => String(row[name] ?? '').trimEnd().toLowerCase()).join('|');
}

function dedupe(rows, definition) {
    if (!definition.key) return rows;

    const byKey = new Map();
    rows.forEach(row => {
        const key = keyOf(row, definition.key);
        const existing = byKey.get(key);
        if (existing && definition.mergeQuantities) {
            existing.quantity = Number(existing.quantity) + Number(row.quantity);
        } else {
            // A fresh copy, so combining never changes the caller's own rows.
            byKey.set(key, { ...row });
        }
    });
    return [...byKey.values()];
}

// For prices: two new rows for the same product and store in the same
// millisecond would clash on the key, so the second one is moved on
// by 1 ms. (Only ever happens within one batch, e.g. the morning
// watch list check saving several prices at once.)
function spreadTimes(rows, definition) {
    if (!definition.uniqueTime) return rows;
    const { key, time } = definition.uniqueTime;
    const used = new Set();
    return rows.map(row => {
        const copy = { ...row };
        let when = Date.parse(copy[time]);
        if (Number.isNaN(when)) return copy;
        while (used.has(keyOf(copy, key) + '|' + when)) when += 1;
        used.add(keyOf(copy, key) + '|' + when);
        copy[time] = new Date(when).toISOString();
        return copy;
    });
}

// -------------------------------------------------------------
// The connection. One shared "pool" of connections, opened the
// first time something's needed (NOT when the server starts).
// -------------------------------------------------------------
let poolPromise = null;

function getPool() {
    if (!poolPromise) {
        const pool = new sql.ConnectionPool({
            server: config.server,
            database: config.database,
            user: config.user,
            password: config.password,
            port: 1433,
            options: {
                encrypt: true,                  // Azure SQL requires an encrypted connection
                trustServerCertificate: false
            },
            // Waking a paused database can take up to a minute, so be
            // patient connecting. Each query itself should be quick.
            connectionTimeout: 60000,
            requestTimeout: 30000,
            pool: {
                max: 5,
                min: 0,
                // Close idle connections after 30 seconds, so the
                // database is free to pause (and stop using up the
                // free allowance) when nobody's using the site.
                idleTimeoutMillis: 30000
            }
        });

        // Without this, a dropped connection would crash the server.
        pool.on('error', err => console.error('Database connection problem:', err.message));

        poolPromise = pool.connect().catch(err => {
            // Forget the failed attempt, so the next request tries again.
            poolPromise = null;
            explainConnectionError(err);
            err.isConnectionError = true;
            throw err;
        });
    }
    return poolPromise;
}

// The most likely reasons the database can't be reached, written
// plainly in the server's output.
function explainConnectionError(err) {
    const message = String(err && err.message);
    if (/Client with IP address/i.test(message)) {
        console.error('Database: Azure blocked this IP address. The garage\'s internet address has probably changed - ' +
            'add the new one in the Azure portal (SQL server -> Security -> Networking -> firewall rules).');
    } else if (/Login failed/i.test(message)) {
        console.error('Database: the username or password in database-config.js was refused.');
    } else {
        console.error('Database: could not connect -', message);
    }
}

// -------------------------------------------------------------
// Runs one SQL batch, trying again if the database is just waking up
// or briefly unavailable. Only errors that mean "the database never
// ran it" are retried, so a save is never accidentally done twice.
// -------------------------------------------------------------
const WAKING_UP_ERRORS = new Set([
    40613,  // database is not currently available (e.g. resuming from pause)
    40197,  // the service had an error processing the request - try again
    40501,  // the service is currently busy
    49918, 49919, 49920,  // not enough resources right now - try again
    4060    // cannot open database (can briefly happen while it resumes)
]);

const RETRY_DELAYS_MS = [3000, 7000, 15000, 30000];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBatch(buildRequest) {
    for (let attempt = 0; ; attempt++) {
        try {
            const pool = await getPool();
            const request = pool.request();
            const sqlText = buildRequest(request);
            return await request.query(sqlText);
        } catch (err) {
            const retryable = err.isConnectionError || WAKING_UP_ERRORS.has(err.number);
            if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
            console.log(`Database not ready (${err.number || err.code || 'connecting'}) - trying again in ${RETRY_DELAYS_MS[attempt] / 1000}s...`);
            await sleep(RETRY_DELAYS_MS[attempt]);
        }
    }
}

// "location_code = @where_0_location_code AND ..." for a table's fixed
// columns (e.g. the pantry is location_code = 'pantry').
function whereClause(request, definition, prefix, tableAlias) {
    return Object.entries(definition.where || {}).map(([name, value]) => {
        request.input(`${prefix}_${name}`, sql.NVarChar(100), value);
        return `${tableAlias ? tableAlias + '.' : ''}${name} = @${prefix}_${name}`;
    });
}

// -------------------------------------------------------------
// READING - e.g. readRows('pantry.csv') gives back the pantry's
// rows, laid out exactly like parseCSV() would have.
// -------------------------------------------------------------
async function readRowsAsync(file) {
    const definition = tableFor(file);

    const result = await runBatch(request => {
        const selects = definition.columns.map(col => {
            const name = columnName(col);
            if (col.readSql) return `${col.readSql} AS [${col.csv}]`;
            if (col.lookup) {
                // Show the name, not the key, e.g. person_id 2 -> "Todd".
                return `(SELECT TOP 1 lk.${col.lookup.label} FROM ${col.lookup.table} AS lk WHERE lk.${col.lookup.key} = t.${name}) AS [${col.csv}]`;
            }
            return `t.${name} AS [${col.csv}]`;
        });
        const conditions = whereClause(request, definition, 'where', 't');
        // (UPDATE, phase 5) e.g. only ingredients that have a minimum.
        if (definition.readWhere) conditions.push(definition.readWhere);
        return `SELECT ${selects.join(', ')} FROM ${definition.table} AS t` +
            (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') +
            ` ORDER BY ${definition.orderBy.split(',').map(part => 't.' + part.trim()).join(', ')};`;
    });

    return result.recordset.map(record => {
        const row = {};
        definition.columns.forEach(col => {
            row[col.csv] = fromDatabaseValue(record[col.csv], col);
        });
        if (definition.deriveId) row.id = definition.deriveId(row);
        return row;
    });
}

// Same as readRowsAsync, but with a callback(err, rows) like the CSV
// functions in server.js use.
function readRows(file, callback) {
    readRowsAsync(file).then(rows => callback(null, rows), err => {
        console.error(`Database: could not read ${file}:`, err.message);
        callback(err, null);
    });
}

// -------------------------------------------------------------
// How saving works
// -------------------------------------------------------------
// Instead of one INSERT per row (each one a round trip to Australia),
// the whole list is sent as ONE JSON text parameter, and OPENJSON
// unpacks it into rows inside the database:
//
//   INSERT INTO dbo.inventory (location_code, name, quantity, unit, track, low)
//   SELECT @where_0_location_code, s.name, s.quantity, ...
//   FROM (SELECT src.name, src.quantity, ...
//         FROM OPENJSON(@rows_0) AS j
//         CROSS APPLY OPENJSON(j.[value]) WITH (name NVARCHAR(200), ...) AS src) AS s;
//
// (The outer OPENJSON gives each row's place in the list as j.[key] -
// 0, 1, 2... - which fills in "position" columns like sort_order.
// Lookup columns are swapped from name to key in that inner SELECT.)
//
// Several saves can go in one batch (e.g. a recipe AND its
// ingredients), all inside one transaction - with XACT_ABORT ON, if
// any part fails the whole lot is rolled back, so you never end up
// with half a save (the database version of writeFileSafely()).
//
// Each save in the batch is { file, rows, mode }:
// - mode 'replace' (the default): this list replaces what was there,
//   exactly like re-writing the whole CSV file used to
// - mode 'append': just adds these rows (prices, activity log) -
//   nothing already there is touched
// -------------------------------------------------------------
function buildSaveSql(request, save, index) {
    const definition = tableFor(save.file);
    const rowsParam = `rows_${index}`;
    const mode = save.mode || 'replace';
    const statements = [];

    // The rows as JSON, using the database's column names.
    let rows = mode === 'replace' ? dedupe(save.rows, definition) : save.rows;
    rows = spreadTimes(rows, definition);
    const sent = sentColumns(definition);
    const json = rows.map(row => {
        const out = {};
        sent.forEach(col => {
            const value = row[col.csv];
            const blank = value === null || value === undefined || String(value).trim() === '';
            out[columnName(col)] = toDatabaseValue(blank && col.orUse ? row[col.orUse] : value, col);
        });
        return out;
    });
    request.input(rowsParam, sql.NVarChar(sql.MAX), JSON.stringify(json));

    // Fixed values like location_code = 'pantry'.
    const whereNames = Object.keys(definition.where || {});
    const whereConditions = whereClause(request, definition, `where_${index}`);

    const unpacked = `OPENJSON(@${rowsParam}) AS j CROSS APPLY OPENJSON(j.[value]) WITH (${sent.map(col => `${columnName(col)} ${col.type}`).join(', ')}) AS src`;

    // Any store name not in the stores table yet gets added (switched
    // off), so the save isn't refused by the foreign key.
    if (definition.addMissingStores) {
        const storeCol = definition.columns.find(col => col.csv === definition.addMissingStores);
        statements.push(`
INSERT INTO dbo.stores (store_name, is_active)
SELECT DISTINCT src.${columnName(storeCol)}, 0 FROM ${unpacked}
WHERE src.${columnName(storeCol)} IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.stores AS st WHERE st.store_name = src.${columnName(storeCol)});`);
    }

    // (UPDATE, phase 3) Any ingredient name not in the ingredients table
    // yet gets added as one of yours, so the save isn't refused by the
    // foreign key.
    if (definition.addMissingIngredients) {
        const ingredientCol = definition.columns.find(col => col.csv === definition.addMissingIngredients);
        const name = columnName(ingredientCol);
        statements.push(`
INSERT INTO dbo.ingredients (ingredient_name, source)
SELECT DISTINCT src.${name}, 'yours' FROM ${unpacked}
WHERE src.${name} IS NOT NULL AND src.${name} <> ''
  AND NOT EXISTS (SELECT 1 FROM dbo.ingredients AS ing WHERE ing.ingredient_name = src.${name});`);
    }

    // The inner SELECT: every stored column, with lookups resolved,
    // positions numbered and "now" filled in.
    const stored = storedColumns(definition);
    if (stored.some(col => col.now)) statements.push(`DECLARE @now_${index} DATETIMEOFFSET(7) = SYSDATETIMEOFFSET();`);
    const sourceSelects = stored.map(col => {
        const name = columnName(col);
        if (col.position) return `CAST(j.[key] AS INT) + 1 AS ${name}`;
        if (col.now) return `ISNULL(src.${name}, @now_${index}) AS ${name}`;
        if (col.lookup) {
            const match = col.lookup.match.map(m => `lk.${m} = src.${name}`).join(' OR ');
            return `(SELECT TOP 1 lk.${col.lookup.key} FROM ${col.lookup.table} AS lk WHERE ${match}) AS ${name}`;
        }
        return `src.${name} AS ${name}`;
    });
    const source = `SELECT ${sourceSelects.join(', ')} FROM ${unpacked}`;
    const columns = stored.map(columnName);

    // Rows that can't be saved are left out rather than refusing the
    // whole save: a recipe that no longer exists, or a required lookup
    // (e.g. a vote's person) that isn't in its table.
    const filters = [];
    if (definition.recipeChild) filters.push('s.recipe_id IN (SELECT recipe_id FROM dbo.recipes)');
    stored.filter(col => col.lookup && col.required).forEach(col => filters.push(`s.${columnName(col)} IS NOT NULL`));
    const filterSql = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

    if (definition.mergeSave) {
        const keyColumns = definition.key.map(csvName => columnName(definition.columns.find(col => col.csv === csvName)));
        const keyMatch = keyColumns.map(name => `target.${name} = s.${name}`).join(' AND ');
        const others = columns.filter(name => !keyColumns.includes(name));
        statements.push(`
MERGE ${definition.table} AS target
USING (${source}) AS s
ON ${keyMatch}
WHEN MATCHED THEN UPDATE SET ${others.map(name => `${name} = s.${name}`).join(', ')}
WHEN NOT MATCHED BY TARGET THEN INSERT (${columns.join(', ')}) VALUES (${columns.map(name => `s.${name}`).join(', ')})${definition.keepMissing ? ';' : `
WHEN NOT MATCHED BY SOURCE THEN DELETE;`}`);
        return statements.join('\n');
    }

    // (UPDATE, phase 5) Just some columns of existing rows, e.g. the
    // minimums on the ingredients table: empty them everywhere, then
    // fill them in for the rows in the list. (Any ingredient that
    // wasn't there yet was already added by addMissingIngredients above.)
    if (definition.setColumns) {
        const keyColumns = definition.key.map(csvName => columnName(definition.columns.find(col => col.csv === csvName)));
        const valueColumns = columns.filter(name => !keyColumns.includes(name));
        statements.push(`
UPDATE ${definition.table} SET ${valueColumns.map(name => `${name} = NULL`).join(', ')};
UPDATE target SET ${valueColumns.map(name => `${name} = s.${name}`).join(', ')}
FROM ${definition.table} AS target
JOIN (${source}) AS s ON ${keyColumns.map(name => `target.${name} = s.${name}`).join(' AND ')};`);
        return statements.join('\n');
    }

    if (mode === 'replace') {
        statements.push(`DELETE FROM ${definition.table}${whereConditions.length ? ` WHERE ${whereConditions.join(' AND ')}` : ''};`);
    }

    const insertColumns = whereNames.concat(columns);
    const selectValues = whereNames.map(name => `@where_${index}_${name}`).concat(columns.map(name => `s.${name}`));
    statements.push(`
INSERT INTO ${definition.table} (${insertColumns.join(', ')})
SELECT ${selectValues.join(', ')} FROM (${source}) AS s${filterSql};`);

    return statements.join('\n');
}

async function saveManyAsync(saves) {
    await runBatch(request => {
        const statements = saves.map((save, index) => buildSaveSql(request, save, index));
        return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
${statements.join('\n')}
COMMIT TRANSACTION;`;
    });
}

// The callback versions server.js uses: callback(err).
function saveMany(saves, callback) {
    saveManyAsync(saves).then(() => callback(null), err => {
        console.error(`Database: could not save ${saves.map(s => s.file).join(' + ')}:`, err.message);
        callback(err);
    });
}

// Replaces everything in one old "file" with this list.
function replaceRows(file, rows, callback) {
    saveMany([{ file, rows, mode: 'replace' }], callback);
}

// Adds these rows to one old "file", leaving what's there alone.
function appendRows(file, rows, callback) {
    if (rows.length === 0) return callback(null);
    saveMany([{ file, rows, mode: 'append' }], callback);
}

// (countRows() and close() were only used by the one-off CSV migration
// script, and were taken out with it.)

// -------------------------------------------------------------
// SAVING PRICES (UPDATE, phase 7)
// -------------------------------------------------------------
// (This replaces phase 5's linkStoreProducts(): the barcode is now just
// a column on the product, and every price points at a product.)
//
// rows: prices laid out like a 'prices.csv' row, plus brand and
// barcode if the supermarket sent them. In one transaction:
// 1. any store not in the stores table yet is added (switched off)
// 2. each price's "code": the supermarket's product code, or for a
//    store with none (Trents) "name:" + its saved name
// 3. a code not linked to a product yet, sent WITH a barcode we already
//    know, is linked to that barcode's product
// 3b. (UPDATE) a real code not linked yet, for a name that WAS saved
//    by name before (e.g. Trents prices from before Trents' SKU was
//    read - "name:Gilmours Tomato Sauce"), is linked to that same
//    product - so its price history carries straight on
// 4. any code still unknown gets a new product (named from the price,
//    source 'price check') and is linked to it. MERGE rather than
//    INSERT, so OUTPUT can hand back each new product_id next to the
//    code it was made for.
// 4b. (UPDATE) a Trents price's Gilmours code (the data-fan number -
//    Foodstuffs North Island's code for the same product) is linked to
//    the same product under the chain 'Gilmours'. Trents is due to
//    become Gilmours, so when the search starts sending Gilmours codes,
//    they're already linked to the right products.
// 5. the prices are added, each with its product_id
// The chain comes from the stores table; a store with no chain uses
// its own name as the chain.
// -------------------------------------------------------------
async function savePricesAsync(rows) {
    if (rows.length === 0) return;
    const definition = tableFor('prices.csv');
    const prepared = spreadTimes(rows, definition).map(row => ({
        store: String(row.store || ''),
        item_name: String(row.item_name || ''),
        date_checked: row.date_checked,
        price: toDatabaseValue(row.price, { kind: 'number' }),
        cup_price: toDatabaseValue(row.cup_price, { kind: 'number' }),
        cup_measure: toDatabaseValue(row.cup_measure, { kind: 'text' }),
        package_size: toDatabaseValue(row.package_size, { kind: 'text' }),
        original_name: toDatabaseValue(row.original_name, { kind: 'text' }),
        product_code: toDatabaseValue(row.product_code, { kind: 'text' }),
        barcode: toDatabaseValue(row.barcode, { kind: 'text' }),
        brand: toDatabaseValue(row.brand, { kind: 'text' }),
        is_special: toDatabaseValue(row.is_special, { kind: 'yesno' }),
        was_price: toDatabaseValue(row.was_price, { kind: 'number' }),
        special_type: toDatabaseValue(row.special_type, { kind: 'text' }),
        special_note: toDatabaseValue(row.special_note, { kind: 'text' }),
        gilmours_code: toDatabaseValue(row.gilmours_code, { kind: 'text' })
    }));

    await runBatch(request => {
        request.input('rows', sql.NVarChar(sql.MAX), JSON.stringify(prepared));
        return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE);

DECLARE @new TABLE (
    store NVARCHAR(100), item_name NVARCHAR(300), date_checked DATETIMEOFFSET(3),
    price DECIMAL(10,2), cup_price DECIMAL(10,2), cup_measure NVARCHAR(50), package_size NVARCHAR(50),
    original_name NVARCHAR(300), product_code NVARCHAR(50), barcode NVARCHAR(50), brand NVARCHAR(100),
    is_special BIT, was_price DECIMAL(10,2), special_type NVARCHAR(20), special_note NVARCHAR(100),
    gilmours_code NVARCHAR(50), chain NVARCHAR(50), code_key NVARCHAR(320)
);
INSERT INTO @new (store, item_name, date_checked, price, cup_price, cup_measure, package_size, original_name,
                  product_code, barcode, brand, is_special, was_price, special_type, special_note, gilmours_code)
SELECT store, item_name, date_checked, price, cup_price, cup_measure, package_size, original_name,
       NULLIF(product_code, ''), NULLIF(barcode, ''), brand, ISNULL(is_special, 0), was_price, special_type, special_note,
       NULLIF(gilmours_code, '')
FROM OPENJSON(@rows) WITH (
    store NVARCHAR(100), item_name NVARCHAR(300), date_checked DATETIMEOFFSET(3),
    price DECIMAL(10,2), cup_price DECIMAL(10,2), cup_measure NVARCHAR(50), package_size NVARCHAR(50),
    original_name NVARCHAR(300), product_code NVARCHAR(50), barcode NVARCHAR(50), brand NVARCHAR(100),
    is_special BIT, was_price DECIMAL(10,2), special_type NVARCHAR(20), special_note NVARCHAR(100),
    gilmours_code NVARCHAR(50)
);

INSERT INTO dbo.stores (store_name, is_active)
SELECT DISTINCT n.store, 0 FROM @new AS n
WHERE NOT EXISTS (SELECT 1 FROM dbo.stores AS st WHERE st.store_name = n.store);

UPDATE n
SET chain = ISNULL(st.chain, st.store_name),
    code_key = ISNULL(n.product_code, N'name:' + n.item_name)
FROM @new AS n
JOIN dbo.stores AS st ON st.store_name = n.store;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT n.chain, n.code_key, MAX(p.product_id), @today
FROM @new AS n
JOIN dbo.products AS p ON p.barcode = n.barcode
WHERE NOT EXISTS (SELECT 1 FROM dbo.store_products AS sp WHERE sp.chain = n.chain AND sp.product_code = n.code_key)
GROUP BY n.chain, n.code_key;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT n.chain, n.code_key, MAX(byname.product_id), @today
FROM @new AS n
JOIN dbo.store_products AS byname ON byname.chain = n.chain AND byname.product_code = N'name:' + n.item_name
WHERE n.product_code IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.store_products AS sp WHERE sp.chain = n.chain AND sp.product_code = n.code_key)
GROUP BY n.chain, n.code_key;

DECLARE @made TABLE (product_id INT, chain NVARCHAR(50), product_code NVARCHAR(320));
MERGE dbo.products AS t
USING (
    SELECT g.chain, g.code_key, g.brand, g.product_name, g.package_size,
           CASE WHEN g.barcode IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.products AS p WHERE p.barcode = g.barcode)
                THEN g.barcode END AS barcode
    FROM (
        SELECT n.chain, n.code_key, MAX(n.brand) AS brand, MAX(n.original_name) AS product_name,
               MAX(n.package_size) AS package_size, MAX(n.barcode) AS barcode
        FROM @new AS n
        WHERE NOT EXISTS (SELECT 1 FROM dbo.store_products AS sp WHERE sp.chain = n.chain AND sp.product_code = n.code_key)
        GROUP BY n.chain, n.code_key
    ) AS g
) AS s ON 1 = 0
WHEN NOT MATCHED THEN
    INSERT (barcode, brand, product_name, package_size, source, date_added)
    VALUES (s.barcode, s.brand, s.product_name, s.package_size, 'price check', @today)
OUTPUT inserted.product_id, s.chain, s.code_key INTO @made;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT chain, product_code, product_id, @today FROM @made;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT 'Gilmours', n.gilmours_code, MAX(sp.product_id), @today
FROM @new AS n
JOIN dbo.store_products AS sp ON sp.chain = n.chain AND sp.product_code = n.code_key
WHERE n.gilmours_code IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.store_products AS g WHERE g.chain = 'Gilmours' AND g.product_code = n.gilmours_code)
GROUP BY n.gilmours_code;

INSERT INTO dbo.prices (store_name, product_id, date_checked, item_name, price, cup_price, cup_measure, package_size,
                        original_name, product_code, is_special, was_price, special_type, special_note)
SELECT n.store, sp.product_id, n.date_checked, n.item_name, n.price, n.cup_price, n.cup_measure, n.package_size,
       n.original_name, n.product_code, n.is_special, n.was_price, n.special_type, n.special_note
FROM @new AS n
JOIN dbo.store_products AS sp ON sp.chain = n.chain AND sp.product_code = n.code_key;
COMMIT TRANSACTION;`;
    });
}

// The callback version: callback(err).
function savePrices(rows, callback) {
    savePricesAsync(rows).then(() => callback(null), err => {
        console.error('Database: could not save prices:', err.message);
        callback(err);
    });
}

// -------------------------------------------------------------
// LINKING A BARCODE (UPDATE, phase 7)
// -------------------------------------------------------------
// Links a barcode to a store's product code, through
// dbo.usp_link_barcode (see database/product-ids-upgrade.sql): if the
// barcode's product and the code's product turn out to be two
// different rows, they're merged into one, so that product's prices
// from every supermarket end up together. store is a store name - its
// chain is looked up here (a store with no chain uses its own name).
// (Nothing calls this yet - it's for linking PAK'nSAVE codes when a
// product is scanned at home, which comes next.)
// -------------------------------------------------------------
async function linkBarcodeAsync(store, productCode, barcode) {
    await runBatch(request => {
        request.input('store', sql.NVarChar(100), String(store));
        request.input('product_code', sql.NVarChar(320), String(productCode));
        request.input('barcode', sql.NVarChar(50), String(barcode));
        return `DECLARE @chain NVARCHAR(50) = (SELECT ISNULL(chain, store_name) FROM dbo.stores WHERE store_name = @store);
IF @chain IS NULL THROW 50010, 'Unknown store', 1;
EXEC dbo.usp_link_barcode @chain = @chain, @product_code = @product_code, @barcode = @barcode;`;
    });
}

function linkBarcode(store, productCode, barcode, callback) {
    linkBarcodeAsync(store, productCode, barcode).then(() => callback(null), err => {
        console.error('Database: could not link barcode:', err.message);
        callback(err);
    });
}

// -------------------------------------------------------------
// THE WAREHOUSE (UPDATE, phase 6 - database/warehouse.sql)
// -------------------------------------------------------------
// Runs dw.usp_load_warehouse, which copies the website's tables into
// the galaxy schema used for reports (Power BI). It only reads the
// website's tables, so nothing the site shows changes. server.js runs
// it once a day, after the morning watch list check - the database is
// awake then anyway, so it costs almost nothing extra.
// -------------------------------------------------------------
async function refreshWarehouseAsync() {
    await runBatch(() => 'EXEC dw.usp_load_warehouse;');
}

function refreshWarehouse(callback) {
    refreshWarehouseAsync().then(() => callback(null), err => {
        console.error('Database: could not refresh the warehouse (has database/warehouse.sql been run?):', err.message);
        callback(err);
    });
}

module.exports = {
    enabled,
    TABLES,
    watchListId,
    readRows,
    readRowsAsync,
    replaceRows,
    appendRows,
    saveMany,
    saveManyAsync,
    savePrices,
    linkBarcode,
    refreshWarehouse
};
