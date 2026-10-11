// -------------------------------------------------------------
// THE AZURE SQL DATABASE
// -------------------------------------------------------------
// Everything that talks to the database lives in this one file, so
// server.js barely has to know it exists. server.js still thinks in
// terms of its old CSV files ("read pantry.csv", "save this list as
// recipes.csv") - this file turns each of those into the matching
// SQL against the tables made by database/create-tables.sql.
//
// It's only switched on when the gitignored database-config.js file
// exists (on the garage, and on your PC only if you choose to make
// one). Without it, database.enabled is false and server.js carries
// on using the CSV files exactly as before - so this code can be
// pushed safely before the database is ready, and deleting the
// config file is an instant way back to the CSVs.
//
// Every row handed back looks EXACTLY like a row from parseCSV():
// every value is text, a missing value is '' (not null), "running
// low" is 'yes' or '' - so none of the code in server.js that
// already works on CSV rows has to change.
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

// Only load the database driver when it's actually going to be used,
// so the CSV-only setup doesn't depend on it at all.
const sql = enabled ? require('mssql') : null;

// -------------------------------------------------------------
// Which table (and which columns) each old CSV file now lives in.
//
// Each column says:
// - csv:      its name in the CSV file / in server.js
// - column:   its name in the database table (only different for the
//             activity log's date and time - see create-tables.sql)
// - type:     the T-SQL type, used when the rows are unpacked from
//             JSON in the SQL (see "How saving works" further down)
// - kind:     how to turn the text value into a database value and
//             back again: 'text', 'number', 'yesno' ('yes' <-> 1),
//             'datetime' (full ISO date/time text), 'date' (just
//             "2026-10-14") or 'time' (just "18:05")
// - required: the table column is NOT NULL, so a blank becomes ''
//             (text) or 0 (number) instead of NULL
//
// And each table says:
// - where:    extra fixed columns, e.g. pantry.csv is the inventory
//             table's rows WHERE location = 'pantry'
// - key:      what makes a row unique (matched ignoring capitals,
//             same as the database does). Saving a list with two
//             rows that clash on this would be refused by the
//             database, so they're combined first - see dedupe().
// - mergeQuantities: for stock, combining two clashing rows ADDS
//             their quantities together (500 g + 250 g rice = 750 g
//             rice) instead of keeping just the last one
// - recipeChild: rows belong to a recipe (recipe_id). Any row whose
//             recipe no longer exists is quietly left out when
//             saving, the same as the database's ON DELETE CASCADE
//             would have removed it.
// - mergeSave: save with MERGE (update/insert/delete row by row)
//             instead of "delete everything, insert the new list".
//             Needed for recipes: deleting every recipe, even for a
//             moment inside a transaction, would CASCADE and wipe out
//             every recipe's ingredients, votes and meal plan entries.
// - identity: the table numbers its own rows (prices, activity log),
//             so its id column is read back but never written
// - orderBy:  the order rows come back in - the same order they'd
//             have been in the CSV file
// -------------------------------------------------------------
function inventoryTable(location) {
    return {
        table: 'dbo.inventory',
        where: { location },
        key: ['name', 'unit'],
        mergeQuantities: true,
        orderBy: 'id',
        columns: [
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number', required: true },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'track', type: 'NVARCHAR(10)', kind: 'text' },
            { csv: 'low', type: 'BIT', kind: 'yesno', required: true }
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
        orderBy: 'id',
        columns: [
            { csv: 'id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'instructions', type: 'NVARCHAR(MAX)', kind: 'text', required: true },
            { csv: 'servings', type: 'INT', kind: 'number' }
        ]
    },

    'recipe_ingredients.csv': {
        table: 'dbo.recipe_ingredients',
        recipeChild: true,
        orderBy: 'id',
        columns: [
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'ingredient_name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text' }
        ]
    },

    'recipe_votes.csv': {
        table: 'dbo.recipe_votes',
        key: ['recipe_id', 'person'],
        recipeChild: true,
        orderBy: 'recipe_id, person',
        columns: [
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'person', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'vote', type: 'NVARCHAR(10)', kind: 'text', required: true }
        ]
    },

    'ingredient_aliases.csv': {
        table: 'dbo.ingredient_aliases',
        key: ['alias'],
        orderBy: 'alias',
        columns: [
            { csv: 'alias', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'canonical_name', type: 'NVARCHAR(200)', kind: 'text', required: true }
        ]
    },

    'prices.csv': {
        table: 'dbo.prices',
        identity: true,
        orderBy: 'id',
        columns: [
            { csv: 'item_name', type: 'NVARCHAR(300)', kind: 'text', required: true },
            { csv: 'price', type: 'DECIMAL(10,2)', kind: 'number' },
            { csv: 'cup_price', type: 'DECIMAL(10,2)', kind: 'number' },
            { csv: 'cup_measure', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'package_size', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'store', type: 'NVARCHAR(100)', kind: 'text', required: true },
            { csv: 'date_checked', type: 'DATETIMEOFFSET', kind: 'datetime', required: true },
            { csv: 'original_name', type: 'NVARCHAR(300)', kind: 'text' }
        ]
    },

    'activity_log.csv': {
        table: 'dbo.activity_log',
        identity: true,
        orderBy: 'id',
        columns: [
            { csv: 'date', column: 'log_date', type: 'DATE', kind: 'date', required: true },
            { csv: 'time', column: 'log_time', type: 'TIME(0)', kind: 'time', required: true },
            { csv: 'person', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'action', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'item', type: 'NVARCHAR(200)', kind: 'text' },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'location', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'details', type: 'NVARCHAR(MAX)', kind: 'text' }
        ]
    },

    'stock_minimums.csv': {
        table: 'dbo.stock_minimums',
        key: ['name', 'unit'],
        orderBy: 'name',
        columns: [
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'minimum', type: 'DECIMAL(12,3)', kind: 'number', required: true },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text', required: true }
        ]
    },

    'barcodes.csv': {
        table: 'dbo.barcodes',
        key: ['barcode'],
        orderBy: 'barcode',
        columns: [
            { csv: 'barcode', type: 'NVARCHAR(50)', kind: 'text', required: true },
            { csv: 'name', type: 'NVARCHAR(200)', kind: 'text', required: true },
            { csv: 'quantity', type: 'DECIMAL(12,3)', kind: 'number' },
            { csv: 'unit', type: 'NVARCHAR(20)', kind: 'text' },
            { csv: 'location', type: 'NVARCHAR(10)', kind: 'text' }
        ]
    },

    'meal_plan.csv': {
        table: 'dbo.meal_plan',
        recipeChild: true,
        orderBy: 'id',
        columns: [
            { csv: 'day', type: 'NVARCHAR(10)', kind: 'text', required: true },
            { csv: 'recipe_id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'people', type: 'INT', kind: 'number' }
        ]
    },

    'watch_list.csv': {
        table: 'dbo.watch_list',
        key: ['id'],
        orderBy: 'id',
        columns: [
            { csv: 'id', type: 'NVARCHAR(20)', kind: 'text', required: true },
            { csv: 'item_name', type: 'NVARCHAR(300)', kind: 'text', required: true },
            { csv: 'store', type: 'NVARCHAR(100)', kind: 'text', required: true },
            { csv: 'package_size', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'search_term', type: 'NVARCHAR(300)', kind: 'text' },
            { csv: 'added_by', type: 'NVARCHAR(50)', kind: 'text' },
            { csv: 'date_added', type: 'DATETIMEOFFSET', kind: 'date' }
        ]
    }
};

function tableFor(file) {
    const definition = TABLES[file];
    if (!definition) throw new Error(`No database table set up for ${file}`);
    return definition;
}

function columnName(col) {
    return col.column || col.csv;
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
    if (col.kind === 'yesno') {
        return text.toLowerCase() === 'yes' || text === '1' || text.toLowerCase() === 'true' ? 1 : 0;
    }
    if (text === '') return col.required ? '' : null;
    return text;
}

function fromDatabaseValue(value, col) {
    if (value === null || value === undefined) return '';

    if (col.kind === 'yesno') return value ? 'yes' : '';
    if (value instanceof Date) {
        if (col.kind === 'date') return value.toISOString().slice(0, 10);    // "2026-10-14"
        if (col.kind === 'time') return value.toISOString().slice(11, 16);   // "18:05"
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
function dedupe(rows, definition) {
    if (!definition.key) return rows;

    const byKey = new Map();
    rows.forEach(row => {
        const key = definition.key.map(name => String(row[name] ?? '').trimEnd().toLowerCase()).join('|');
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

// -------------------------------------------------------------
// READING - e.g. readRows('pantry.csv') gives back the pantry's
// rows, laid out exactly like parseCSV() would have.
// -------------------------------------------------------------
async function readRowsAsync(file) {
    const definition = tableFor(file);
    const columns = definition.columns.map(columnName);
    if (definition.identity) columns.unshift('id');

    const result = await runBatch(request => {
        const conditions = Object.entries(definition.where || {}).map(([name, value]) => {
            request.input(`where_${name}`, sql.NVarChar(100), value);
            return `${name} = @where_${name}`;
        });
        return `SELECT ${columns.join(', ')} FROM ${definition.table}` +
            (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') +
            ` ORDER BY ${definition.orderBy};`;
    });

    return result.recordset.map(record => {
        const row = {};
        if (definition.identity) row.id = String(record.id);
        definition.columns.forEach(col => {
            row[col.csv] = fromDatabaseValue(record[columnName(col)], col);
        });
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
//   INSERT INTO dbo.inventory (location, name, quantity, unit, track, low)
//   SELECT @where_0_location, name, quantity, unit, track, low
//   FROM OPENJSON(@rows_0) WITH (name NVARCHAR(200), quantity DECIMAL(12,3), ...);
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

    // The rows as JSON, using the database's column names.
    const rows = (mode === 'replace' ? dedupe(save.rows, definition) : save.rows).map(row => {
        const out = {};
        definition.columns.forEach(col => { out[columnName(col)] = toDatabaseValue(row[col.csv], col); });
        return out;
    });
    request.input(rowsParam, sql.NVarChar(sql.MAX), JSON.stringify(rows));

    // Fixed values like location = 'pantry'.
    const whereNames = Object.keys(definition.where || {});
    whereNames.forEach(name => request.input(`where_${index}_${name}`, sql.NVarChar(100), definition.where[name]));
    const whereSql = whereNames.map(name => `${name} = @where_${index}_${name}`).join(' AND ');

    const columns = definition.columns.map(columnName);
    const withClause = definition.columns.map(col => `${columnName(col)} ${col.type}`).join(', ');
    const source = `SELECT ${columns.join(', ')} FROM OPENJSON(@${rowsParam}) WITH (${withClause})`;

    // Rows for a recipe that doesn't exist (any more) are left out.
    const recipeFilter = definition.recipeChild ? ' WHERE src.recipe_id IN (SELECT id FROM dbo.recipes)' : '';

    if (definition.mergeSave) {
        const keyMatch = definition.key.map(name => `target.${name} = src.${name}`).join(' AND ');
        const others = columns.filter(name => !definition.key.includes(name));
        return `
MERGE ${definition.table} AS target
USING (${source}) AS src
ON ${keyMatch}
WHEN MATCHED THEN UPDATE SET ${others.map(name => `${name} = src.${name}`).join(', ')}
WHEN NOT MATCHED BY TARGET THEN INSERT (${columns.join(', ')}) VALUES (${columns.map(name => `src.${name}`).join(', ')})
WHEN NOT MATCHED BY SOURCE THEN DELETE;`;
    }

    const insertColumns = whereNames.concat(columns);
    const selectValues = whereNames.map(name => `@where_${index}_${name}`).concat(columns.map(name => `src.${name}`));
    const insertSql = `
INSERT INTO ${definition.table} (${insertColumns.join(', ')})
${definition.identity ? 'OUTPUT INSERTED.id' : ''}
SELECT ${selectValues.join(', ')} FROM (${source}) AS src${recipeFilter};`;

    if (mode === 'append') return insertSql;

    const deleteSql = `DELETE FROM ${definition.table}${whereSql ? ` WHERE ${whereSql}` : ''};`;
    return deleteSql + insertSql;
}

async function saveManyAsync(saves) {
    const result = await runBatch(request => {
        const statements = saves.map((save, index) => buildSaveSql(request, save, index));
        return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
${statements.join('\n')}
COMMIT TRANSACTION;`;
    });

    // Any new ids the database gave out (from OUTPUT INSERTED.id),
    // e.g. so a newly saved price can be sent back with its real id.
    return (result.recordsets || []).flat().map(record => String(record.id));
}

// The callback versions server.js uses: callback(err, newIds).
function saveMany(saves, callback) {
    saveManyAsync(saves).then(ids => callback(null, ids), err => {
        console.error(`Database: could not save ${saves.map(s => s.file).join(' + ')}:`, err.message);
        callback(err, null);
    });
}

// Replaces everything in one old "file" with this list.
function replaceRows(file, rows, callback) {
    saveMany([{ file, rows, mode: 'replace' }], callback);
}

// Adds these rows to one old "file", leaving what's there alone.
function appendRows(file, rows, callback) {
    if (rows.length === 0) return callback(null, []);
    saveMany([{ file, rows, mode: 'append' }], callback);
}

// For the migration script: how many rows each table has.
async function countRows(file) {
    const definition = tableFor(file);
    const result = await runBatch(request => {
        const conditions = Object.entries(definition.where || {}).map(([name, value]) => {
            request.input(`where_${name}`, sql.NVarChar(100), value);
            return `${name} = @where_${name}`;
        });
        return `SELECT COUNT(*) AS total FROM ${definition.table}` +
            (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') + ';';
    });
    return result.recordset[0].total;
}

// For the migration script: lets the program finish once it's done.
async function close() {
    if (poolPromise) {
        const pool = await poolPromise;
        poolPromise = null;
        await pool.close();
    }
}

module.exports = {
    enabled,
    TABLES,
    readRows,
    readRowsAsync,
    replaceRows,
    appendRows,
    saveMany,
    saveManyAsync,
    countRows,
    close
};
