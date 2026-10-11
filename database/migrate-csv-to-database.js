// -------------------------------------------------------------
// ONE-OFF: copy every CSV file into the Azure SQL database
// -------------------------------------------------------------
// Run this ONCE on the garage, from the project folder, after the
// tables exist (database/create-tables.sql) and database-config.js
// is in place:
//
//     node database/migrate-csv-to-database.js
//
// What it does:
// - reads every CSV file the same way the site always has (csv.js)
// - loads them ALL into the database in ONE transaction - so it
//   either all goes in, or (if anything goes wrong) nothing does
// - prints how many rows each CSV had next to how many ended up in
//   its table, so you can see nothing went missing
// - leaves the CSV files themselves completely untouched, so they're
//   still there as a backup (and as a way back - just remove
//   database-config.js and the site goes back to using them)
//   (UPDATE, phase 2: the site no longer falls back to the CSV files,
//   so they're an archive now rather than a way back.)
//
// It refuses to run if the database already has data in it, so it
// can't accidentally wipe out anything added through the site since.
// If you really do want to throw away what's in the database and
// load the CSVs again (e.g. a first attempt went wrong), add
// --wipe-database-first on the end.
//
// A few things get tidied on the way in:
// - prices.csv: the old ids are left behind (Excel had turned lots
//   of them into things like "1.78597E+12") and the database numbers
//   the rows itself, oldest first. The exact time each price was
//   saved is still kept, in date_checked.
// - a price with a date_checked that isn't a proper date/time is
//   skipped and listed, rather than guessed at
// - ingredients, votes and meal plan entries for a recipe that no
//   longer exists are left out (and counted below)
// - two stock rows for the same thing in the same place (e.g. "Rice"
//   and "rice", both in g) are combined, quantities added together
//
// UPDATE, phase 2: the live database has been moved over already, so
// this is now for filling a NEW database (e.g. a pantry_dev copy for
// testing) from the archived CSV files. Make the tables first with
// database/create-tables.sql - it also adds the people, stores and
// storage areas these rows point at. Activity log lines keep their
// original NZ date and time.
// -------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../csv');
const database = require('../database');

// The CSVs live in the project folder, one up from this script.
const PROJECT_FOLDER = path.join(__dirname, '..');

const wipeFirst = process.argv.includes('--wipe-database-first');

// In this order, so every recipe is in before anything that points at
// one (ingredients, votes, the meal plan).
const FILES = [
    'pantry.csv', 'fridge.csv', 'freezer.csv', 'chest.csv',
    'recipes.csv', 'recipe_ingredients.csv', 'recipe_votes.csv', 'meal_plan.csv',
    'ingredient_aliases.csv', 'prices.csv', 'activity_log.csv',
    'stock_minimums.csv', 'barcodes.csv', 'watch_list.csv'
];

// Reads one CSV - a file that doesn't exist yet just means no rows.
function readCsv(file) {
    const filePath = path.join(PROJECT_FOLDER, file);
    if (!fs.existsSync(filePath)) return null;
    return parseCSV(fs.readFileSync(filePath, 'utf8'));
}

// prices.csv: keep only rows with a real date/time, oldest first, and
// without the old (often Excel-mangled) ids.
function tidyPrices(rows, problems) {
    const good = [];
    rows.forEach((row, index) => {
        const time = Date.parse(row.date_checked);
        if (Number.isNaN(time)) {
            problems.push(`prices.csv line ${index + 2}: skipped "${row.item_name}" - date_checked "${row.date_checked}" isn't a date/time`);
            return;
        }
        const { id, ...rest } = row;
        good.push({ ...rest, date_checked: new Date(time).toISOString() });
    });
    return good.sort((a, b) => a.date_checked.localeCompare(b.date_checked));
}

// activity_log.csv: each line's NZ date + time ("2026-10-14", "18:05")
// turned into one exact moment (logged_at), allowing for daylight
// saving. Works out NZ's offset from UTC at that moment by asking what
// the NZ clock showed then.
function nzToIso(date, time) {
    const guess = Date.parse(`${date}T${time || '00:00'}:00Z`);
    if (Number.isNaN(guess)) return '';
    const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: 'Pacific/Auckland' }).replace(' ', 'T') + 'Z';
    const offset = Date.parse(shown) - guess;
    return new Date(guess - offset).toISOString();
}

function tidyActivityLog(rows) {
    return rows.map(row => ({ ...row, logged_at: nzToIso(row.date, row.time) }));
}

async function main() {
    if (!database.enabled) {
        console.error('database-config.js was not found in the project folder, so there is no database to copy into.');
        console.error('Create it first (see database-config.example.js), then run this again.');
        process.exit(1);
    }

    // ---- 1. Is the database still empty? ----
    console.log('Connecting to the database (this can take up to a minute if it was paused)...');
    const before = {};
    for (const file of FILES) before[file] = await database.countRows(file);
    const alreadyThere = FILES.filter(file => before[file] > 0);

    if (alreadyThere.length > 0 && !wipeFirst) {
        console.error('\nThe database already has data in it, so nothing was copied:');
        alreadyThere.forEach(file => console.error(`  ${database.TABLES[file].table} (from ${file}): ${before[file]} rows`));
        console.error('\nIf you really want to REPLACE all of it with what is in the CSV files, run:');
        console.error('  node database/migrate-csv-to-database.js --wipe-database-first');
        await database.close();
        process.exit(1);
    }

    // ---- 2. Read every CSV ----
    const problems = [];
    const csvCounts = {};
    const saves = FILES.map(file => {
        let rows = readCsv(file);
        csvCounts[file] = rows === null ? 'no file' : rows.length;
        rows = rows || [];
        if (file === 'prices.csv') rows = tidyPrices(rows, problems);
        if (file === 'activity_log.csv') rows = tidyActivityLog(rows);
        // 'replace' empties each table and loads the CSV's rows, all
        // inside the one transaction.
        return { file, rows, mode: 'replace' };
    });

    // ---- 3. Load it all in one go ----
    console.log(wipeFirst && alreadyThere.length > 0
        ? 'Replacing everything in the database with the CSV files...'
        : 'Copying the CSV files into the database...');
    await database.saveManyAsync(saves);

    // ---- 4. Compare ----
    console.log('\nFile                      CSV rows   Database rows');
    console.log('------------------------  ---------  -------------');
    for (const file of FILES) {
        const after = await database.countRows(file);
        const note = typeof csvCounts[file] === 'number' && after < csvCounts[file]
            ? '   <- fewer (combined duplicates / left out rows for deleted recipes / skipped bad dates)'
            : '';
        console.log(`${file.padEnd(24)}  ${String(csvCounts[file]).padStart(9)}  ${String(after).padStart(13)}${note}`);
    }

    if (problems.length > 0) {
        console.log('\nSkipped:');
        problems.forEach(problem => console.log('  ' + problem));
    }

    console.log('\nDone. The CSV files have not been changed.');
    await database.close();
}

main().catch(async err => {
    console.error('\nThe copy FAILED, and nothing was saved (it was all one transaction):');
    console.error(err.message);
    await database.close().catch(() => {});
    process.exit(1);
});
