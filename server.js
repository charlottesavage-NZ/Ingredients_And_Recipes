// -------------------------------------------------------------
// This is our local server. It runs on your laptop and acts like
// a mini version of what AWS will eventually do - it reads and
// writes CSV files ("pretend spreadsheets") for each storage area,
// and the browser talks to it using fetch().
// -------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

// Used to make the random "you're logged in" codes - see the LOGIN
// section further down. Built into Node, nothing to install.
const crypto = require('crypto');

// Trents login details live in their own gitignored file, never
// typed directly into this file - see credentials.js.
const { TRENTS_USERNAME, TRENTS_PASSWORD } = require('./credentials');

// The big built-in ingredient list and US -> NZ name aliases (e.g.
// "Ground Beef" -> "Mince") - see ingredient-data.js for the details.
// (UPDATE, phase 3: the built-in aliases, tin sizes and suggestion
// names moved into the database - the ingredients and
// ingredient_aliases tables - so ingredient-data.js isn't read any
// more. Only the standard tin size stays here, for anything that
// comes in tins but isn't in the ingredients table with its own size.)
const DEFAULT_TIN_SIZE = { quantity: 400, unit: 'g' };

// The Azure SQL database - see database.js. Until the gitignored
// database-config.js file exists, database.enabled is false and
// everything below keeps using the CSV files exactly as before.
// (UPDATE, phase 2: the CSV files are retired - all the household
// data lives in the database now, so without database-config.js the
// server stops straight away with a message saying so. The old CSV
// files are kept on the garage as an archive.)
const database = require('./database');

if (!database.enabled) {
    console.error('database-config.js was not found, so there is no database to use. ' +
        'Create it from database-config.example.js (see the README), then start the server again.');
    process.exit(1);
}

const PORT = 3000;

// -------------------------------------------------------------
// This maps each section name to its own CSV file on disk.
// Each storage area (pantry, fridge, freezer, chest) gets its
// own "table" - just a separate file for now.
// -------------------------------------------------------------
const csvFiles = {
    pantry: 'pantry.csv',
    fridge: 'fridge.csv',
    freezer: 'freezer.csv',
    chest: 'chest.csv'
};

// -------------------------------------------------------------
// Recipes are stored across two linked files:
// - recipes.csv holds the recipe itself (id, name, instructions)
// - recipe_ingredients.csv holds each ingredient, linked back to
//   its recipe via recipe_id
// This is separate from csvFiles because recipes have a different
// shape (a recipe has MANY ingredients) than pantry items.
// -------------------------------------------------------------
const RECIPES_FILE = 'recipes.csv';
const RECIPE_INGREDIENTS_FILE = 'recipe_ingredients.csv';
const RECIPE_VOTES_FILE = 'recipe_votes.csv';

// (UPDATE, phase 2: the household members - who can log in and vote -
// are now the people table in the database, read by readPeople() in
// the LOGIN section, instead of a list typed in here. To add someone,
// add a row to dbo.people.)

// -------------------------------------------------------------
// Every price you save from the Price Checker page goes in here.
// Unlike the other CSVs, this one is pure history - saving the
// same item twice adds a SECOND row rather than overwriting the
// first, so price changes over time are kept rather than lost.
// -------------------------------------------------------------
const PRICES_FILE = 'prices.csv';
// original_name (added last, so the older columns keep their place)
// is the product's name EXACTLY as the supermarket wrote it, e.g.
// "Woolworths Essentials Diced Tomatoes 400g Can" - item_name is the
// tidied-up version used for grouping (see savedPriceName below).
// Older rows saved before this column existed just have it blank.
// (UPDATE, phase 5: there's also product_code now - the supermarket's
// own code for the product - and, when reading, barcode - see
// appendPrices() and database.js. The database keeps the columns now,
// so this list is just a record of the original CSV layout.)
const PRICE_HEADERS = ['id', 'item_name', 'price', 'cup_price', 'cup_measure', 'package_size', 'store', 'date_checked', 'original_name'];

// -------------------------------------------------------------
// Maps alternate ingredient names to one canonical name, so
// "Diced Tomatoes In Juice" and "Tinned Tomatoes" can be
// recognised as the same thing when matching recipes against
// pantry stock. Built up gradually - a new row only gets added
// when a real mismatch actually comes up, not upfront.
// -------------------------------------------------------------
const ALIASES_FILE = 'ingredient_aliases.csv';
const ALIAS_HEADERS = ['alias', 'canonical_name'];

// -------------------------------------------------------------
// Which physical Woolworths store(s) to price things from. A
// fresh, brand-new browser (which is what Playwright uses every
// time) has no idea which store you want, so without this it
// silently defaults to some other store entirely.
//
// To add another store: on woolworths.co.nz, use their normal
// "Change store" option to switch to it, then Firefox DevTools ->
// Storage -> Cookies -> find "cw-lrkswrdjp" and copy its value in
// here under whatever name you want it labelled with on the page.
// -------------------------------------------------------------
// UPDATE, phase 2: the stores now live in the database's stores
// table (with their chain, suburb, cookie value as store_code, and
// main / preferred / active ticks), and these lists are filled in
// from it by loadStores() below. To add a store, add a row to
// dbo.stores with chain 'Woolworths' and the cookie value as its
// store_code - no code change needed.
const WOOLWORTHS_STORES = {};

// Whichever store gets used if none is specifically chosen.
const DEFAULT_WOOLWORTHS_STORE = 'Woolworths Moorhouse';

// -------------------------------------------------------------
// Which physical Pak'nSave store(s) to price things from - same
// idea as WOOLWORTHS_STORES above, but Pak'nSave uses TWO cookies
// together to remember your store rather than one. IDs found via
// the "contentstackStores" data sitting in the page itself.
// -------------------------------------------------------------
// (UPDATE, phase 2: filled in from the stores table too - chain
// "PAK'nSAVE", with the store ID as its store_code.)
const PAKNSAVE_STORES = {};

const DEFAULT_PAKNSAVE_STORE = "PAK'nSAVE Moorhouse";

// -------------------------------------------------------------
// Trents Wholesale - just one store/account, unlike the two above,
// so there's no list of options here, just a single name that
// shows up in the combined dropdown alongside the others.
// -------------------------------------------------------------
const TRENTS_STORE_NAME = 'Trents Wholesale';

// -------------------------------------------------------------
// "OUR 3 STORES" - the stores you actually shop at. Picking
// MAIN_STORES_OPTION in the store dropdown searches all of these at
// once and shows the results together. To change which stores are
// in it, edit MAIN_STORES (the names must match the store lists
// above exactly) - and update the label in MAIN_STORES_OPTION too.
// -------------------------------------------------------------
// UPDATE, phase 2: which stores are in it is now the is_main_store
// tick in the stores table, and the label is made from them by
// loadStores() - e.g. "Our 3 stores (Trents Wholesale, Woolworths
// Ferrymead, PAK'nSAVE Wainoni)". Tick a fourth and it becomes
// "Our 4 stores (...)".
let MAIN_STORES = [];
let MAIN_STORES_OPTION = 'Our stores';

// Every store row from the database, in dropdown order (preferred
// stores first). Read once, the first time a page needs it, and kept
// until the server restarts (the garage restarts it every hour, so a
// change made in SSMS shows up within the hour).
let storeRows = null;

async function loadStores() {
    if (storeRows) return storeRows;
    const rows = (await database.readRowsAsync('stores')).filter(store => store.is_active);

    rows.forEach(store => {
        if (store.chain === 'Woolworths') WOOLWORTHS_STORES[store.store_name] = store.store_code;
        if (store.chain === "PAK'nSAVE") PAKNSAVE_STORES[store.store_name] = store.store_code;
    });
    MAIN_STORES = rows.filter(store => store.is_main_store).map(store => store.store_name);
    MAIN_STORES_OPTION = `Our ${MAIN_STORES.length} stores (${MAIN_STORES.join(', ')})`;

    storeRows = rows;
    return storeRows;
}

// -------------------------------------------------------------
// (UPDATE, phase 5: the supermarkets' own brands - Pams, Woolworths
// Essentials etc. - used to be renamed to one shared "Home Brand"
// name here when a price was saved, so they'd line up across stores.
// It didn't work very well, so it's gone: prices keep their real
// brand ("Pams Diced Tomatoes"), and the upgrade put the real brand
// back on the ones already saved. The same product at different
// supermarkets is lined up by its BARCODE instead, once the
// supermarket's product code has been linked to one - see
// linkStoreProducts() in database.js and appendPrices() below.)
// -------------------------------------------------------------

// -------------------------------------------------------------
// The name a price gets SAVED under (see the POST /prices route):
// - the pack size taken off the end of the name, since it's already
//   saved in its own Size column - Woolworths writes it in the name
//   ("...Diced Tomatoes 400g Can") but Pak'nSave doesn't, so without
//   this the two would never match up.
// Trents names are saved exactly as they are.
// -------------------------------------------------------------
function savedPriceName(name, store) {
    if (!name || store === TRENTS_STORE_NAME) return name;

    let cleaned = name;

    // Cut from the LAST pack size in the name onwards, e.g.
    // "Diced Tomatoes 400g Can" -> "Diced Tomatoes". Same size
    // pattern as sizeFromWoolworthsName().
    const sizePattern = /(\d+\s*x\s*)?\d+(\.\d+)?\s*(kg|g|ml|l|pk|pack|ea|sheets|rolls)\b/gi;
    const matches = [...cleaned.matchAll(sizePattern)];
    if (matches.length > 0) {
        const lastSize = matches[matches.length - 1];
        const trimmed = cleaned.slice(0, lastSize.index).trim();
        // Only if there's still a real name left afterwards.
        if (trimmed.length > 0) cleaned = trimmed;
    }

    return cleaned;
}

// -------------------------------------------------------------
// A curated baseline of common grocery items with CORRECT
// spelling. This exists so the dropdown always has trustworthy
// suggestions available, even before you've typed anything
// yourself - meaning the right spelling shows up as you type,
// rather than only appearing after you've already used it once.
// Feel free to add more items here any time you notice something
// missing.
// -------------------------------------------------------------
const COMMON_GROCERY_ITEMS = [
    'Tinned Tomatoes', 'Pasta Sauce', 'Tomato Paste',
    'Mince', 'Chicken Breast', 'Chicken Thigh', 'Bacon', 'Sausages',
    'Pasta', 'Rice', 'Flour', 'Sugar', 'Salt', 'Pepper',
    'Milk', 'Butter', 'Cheese', 'Eggs', 'Yoghurt', 'Cream',
    'Onion', 'Garlic', 'Potato', 'Carrot', 'Broccoli', 'Capsicum',
    'Olive Oil', 'Vegetable Oil', 'Soy Sauce', 'Stock', 'Baked Beans',
    'Bread', 'Butter Beans', 'Chickpeas', 'Lentils', 'Tuna', 'Salmon',
    'Gluten Free Pasta', 'Gluten Free Bread'
];

// -------------------------------------------------------------
// Weight unit conversion. Everything gets converted to grams
// before it's merged/stored, so the existing merge logic below
// (which matches by unit) doesn't need to change at all.
// -------------------------------------------------------------
const WEIGHT_UNITS_TO_GRAMS = {
    g: 1,
    kg: 1000
};

// Checks if a unit is a weight unit we know how to convert
function isWeightUnit(unit) {
    return unit in WEIGHT_UNITS_TO_GRAMS;
}

// Converts a quantity into grams
function toGrams(quantity, unit) {
    return quantity * WEIGHT_UNITS_TO_GRAMS[unit];
}

// -------------------------------------------------------------
// Volume unit conversion. Same idea as weight - everything gets
// converted to millilitres before it's merged/stored.
// -------------------------------------------------------------
const VOLUME_UNITS_TO_ML = {
    ml: 1,
    l: 1000
};

// Checks if a unit is a volume unit we know how to convert
function isVolumeUnit(unit) {
    return unit in VOLUME_UNITS_TO_ML;
}

// Converts a quantity into millilitres
function toMilliliters(quantity, unit) {
    return quantity * VOLUME_UNITS_TO_ML[unit];
}

// -------------------------------------------------------------
// Trents shows a pack size like "3kg", "500g", or "1kg" instead of
// a ready-made price-per-kg figure like Woolworths/Pak'nSave give
// us. This pulls the number and unit apart (e.g. "3kg" -> 3 and
// "kg"), so we can reuse the SAME toGrams/toMilliliters functions
// above to work out a per-kg/per-L price ourselves.
//
// Things like "6pk" (a pack of 6, not a weight) deliberately don't
// match this pattern - there's no number-then-weight-unit shape to
// find, so callers get back null and know to skip the calculation.
// -------------------------------------------------------------
function parseSizeToBaseUnit(sizeText) {
    if (!sizeText) return null;

    const match = sizeText.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
    if (!match) return null;

    const quantity = Number(match[1]);
    const unit = match[2].toLowerCase();

    if (isWeightUnit(unit)) {
        return { grams: toGrams(quantity, unit) };
    }
    if (isVolumeUnit(unit)) {
        return { milliliters: toMilliliters(quantity, unit) };
    }

    // Recognised as a number+letters shape, but not a unit we know
    // how to convert (e.g. "6pk") - nothing to calculate.
    return null;
}

// -------------------------------------------------------------
// Trents' website shows every price WITHOUT GST - unlike
// Woolworths/Pak'nSave, which both already include it. NZ GST is
// currently 15%, so this turns their $22.11 (before tax) into the
// real $25.43 (what you'd actually pay), so every store in the
// price checker is comparing like-for-like.
// -------------------------------------------------------------
const NZ_GST_RATE = 0.15;

function addGst(exGstPrice) {
    if (typeof exGstPrice !== 'number') return null;
    return Math.round(exGstPrice * (1 + NZ_GST_RATE) * 100) / 100;
}

// -------------------------------------------------------------
// Works out a calculated per-kg or per-L price for one Trents
// product, using its price and pack size. Returns the SAME
// cupPrice/cupMeasure shape the price checker already expects
// from Woolworths/Pak'nSave, just calculated by us instead of
// handed to us ready-made.
//
// If we can't confidently calculate one (no price, no size, or a
// size like "6pk" that isn't a weight/volume at all), cupPrice
// comes back null and cupMeasure falls back to the plain size text
// instead - e.g. "6pk" on its own, with no price attached to it.
// -------------------------------------------------------------
function calculateTrentsUnitPrice(price, sizeText) {
    const parsedSize = parseSizeToBaseUnit(sizeText);

    if (!parsedSize || !price) {
        return { cupPrice: null, cupMeasure: sizeText || null };
    }

    if (parsedSize.grams) {
        const pricePerKg = price / (parsedSize.grams / 1000);
        return {
            cupPrice: Math.round(pricePerKg * 100) / 100,
            cupMeasure: 'kg calc'
        };
    }

    if (parsedSize.milliliters) {
        const pricePerLitre = price / (parsedSize.milliliters / 1000);
        return {
            cupPrice: Math.round(pricePerLitre * 100) / 100,
            cupMeasure: 'L calc'
        };
    }

    return { cupPrice: null, cupMeasure: sizeText || null };
}

// (parseCSVRows() and parseCSV() - turning CSV text into rows - moved
// to csv.js for the one-off database migration, and were taken out
// with it once the CSV files were retired.)
//
// (UPDATE, phase 2: csvField(), stringifyCSV() and stringifyGenericCSV()
// - which turned lists back into CSV text for saving - were taken out
// with the CSV files. Everything is saved to the database now; see
// database.js. writeFileSafely() below stays, for sessions.json and
// watch_check_status.json, which are still files on the garage.)

// -------------------------------------------------------------
// Saves text to a file SAFELY. Instead of writing straight over
// the real file (which empties it first, then fills it back in),
// this writes to a temporary file next to it and then swaps it
// into place in one step. If the server gets stopped half-way
// through a save - e.g. by the hourly update restarting it - the
// real file is left untouched, rather than half-written or empty.
// -------------------------------------------------------------
function writeFileSafely(filePath, text, callback) {
    const tempPath = filePath + '.tmp';
    fs.writeFile(tempPath, text, 'utf8', (err) => {
        if (err) return callback(err);
        fs.rename(tempPath, filePath, callback);
    });
}

// -------------------------------------------------------------
// Makes changes to the CSV files happen ONE AT A TIME. Every save
// works by reading a whole file, changing it, then writing the
// whole thing back - so if two saves overlapped (e.g. two people
// adding pantry items at the same moment), the second one could
// write back an old copy and quietly wipe out the first person's
// change. Each change waits its turn here, and the next one starts
// as soon as the previous one has sent its reply.
// -------------------------------------------------------------
let writeQueue = Promise.resolve();

function runOneAtATime(res, task) {
    writeQueue = writeQueue.then(() => new Promise(resolve => {
        // 'finish' fires once the reply has been sent, 'close' if the
        // browser gave up waiting - either way, let the next one go.
        res.on('finish', resolve);
        res.on('close', resolve);

        try {
            task();
        } catch (err) {
            // Without this, one unexpected error would leave the
            // queue stuck forever and no change could ever be saved
            // again until the server restarted.
            console.error('Unexpected error while saving:', err);
            sendText(res, 500, 'Something went wrong while saving');
        }
    }));
}

// -------------------------------------------------------------
// Small helpers for sending a reply back to the browser, so every
// route below doesn't have to repeat the same two lines each time.
// -------------------------------------------------------------
function sendJson(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendText(res, statusCode, message) {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(message);
}

// -------------------------------------------------------------
// DATABASE OR CSV? - every read and save of the household data now
// goes through readRows() / saveRows() (or one of the functions that
// use them), which pick the right one:
// - database switched on (database-config.js exists - see
//   database.js): the matching Azure SQL table
// - otherwise: the CSV file, exactly as before
// The rows look the same either way, so nothing else has to care.
// -------------------------------------------------------------
// UPDATE, phase 2: always the database now - the CSV side of each of
// these was taken out when the CSV files were retired. The "file"
// names (pantry.csv, recipes.csv...) are kept as the names server.js
// uses for each kind of data; database.js maps each one to its table.

// Reads one "file" and hands back its rows.
function readRows(filePath, callback) {
    database.readRows(filePath, callback);
}

// The same as readRows(), for code that uses await / Promise.all.
function readRowsAsync(filePath) {
    return new Promise((resolve, reject) => {
        readRows(filePath, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

// Saves a whole list in place of what was there before (like
// re-writing the whole CSV file).
// (UPDATE, phase 3: rows that point at an ingredient get linked to it
// first - see linkIngredients() - and the remembered ingredient list
// is forgotten afterwards, in case the save added a new ingredient.)
function saveRows(filePath, rows, callback) {
    const nameField = INGREDIENT_NAME_FIELDS[filePath];
    if (!nameField) return database.replaceRows(filePath, rows, err => callback(err));

    linkIngredients(rows, nameField, err => {
        if (err) return callback(err);
        database.replaceRows(filePath, rows, err => {
            forgetAliases();
            callback(err);
        });
    });
}

// Reads a section's CSV file and hands back the parsed items.
// (UPDATE: its rows of the database's inventory table - see readRows.)
function readItems(section, callback) {
    readRows(csvFiles[section], callback);
}

// Saves an array of items back to a section's CSV file.
// (UPDATE: to the database - see saveRows.)
function saveItems(section, items, callback) {
    saveRows(csvFiles[section], items, callback);
}

// -------------------------------------------------------------
// The column headers for each of the three recipe files, kept in
// one place so every route that saves them uses the same order.
// -------------------------------------------------------------
// servings (added last, so the older columns keep their place) is
// how many people the recipe's amounts are written for - used to
// scale it for 1, 2 or 3 people. Blank on older recipes, which then
// count as DEFAULT_SERVINGS.
const RECIPE_HEADERS = ['id', 'name', 'instructions', 'servings'];

// How many people a recipe serves if it doesn't say (e.g. every
// recipe saved before the servings column existed).
const DEFAULT_SERVINGS = 2;
const RECIPE_INGREDIENT_HEADERS = ['recipe_id', 'ingredient_name', 'quantity', 'unit'];
const RECIPE_VOTE_HEADERS = ['recipe_id', 'person', 'vote'];

// -------------------------------------------------------------
// Reads recipes.csv and recipe_ingredients.csv as two plain lists
// (WITHOUT joining them together like readRecipes() does), ready
// to be changed and saved back. Used by add/edit/delete recipe.
// On a problem it sends the error reply itself, so callers only
// ever get called back when both files were read successfully.
// -------------------------------------------------------------
function readRecipeFilesForEditing(res, callback) {
    readRows(RECIPES_FILE, (err, recipes) => {
        if (err) return sendText(res, 500, 'Could not read recipes');

        readRows(RECIPE_INGREDIENTS_FILE, (err, ingredients) => {
            if (err) return sendText(res, 500, 'Could not read recipe ingredients');
            callback(recipes, ingredients);
        });
    });
}

// -------------------------------------------------------------
// Saves both recipe files, then replies with replyData. This used
// to be written out in full three times (add, edit, delete).
// -------------------------------------------------------------
// UPDATE: with the database switched on, the recipes AND their
// ingredients are saved together in ONE transaction - so it's
// either all saved or none of it, never a recipe with half its
// ingredients. (Deleting a recipe there also removes its votes and
// meal plan entries, thanks to ON DELETE CASCADE.)
// (UPDATE, phase 2: always the database now.)
// (UPDATE, phase 3: each ingredient is linked to the ingredients
// table first - see linkIngredients().)
function saveRecipeFiles(res, recipes, ingredients, replyData) {
    linkIngredients(ingredients, 'ingredient_name', err => {
        if (err) return sendText(res, 500, 'Could not read the ingredients list');
        database.saveMany([
            { file: RECIPES_FILE, rows: recipes },
            { file: RECIPE_INGREDIENTS_FILE, rows: ingredients }
        ], err => {
            forgetAliases();
            if (err) return sendText(res, 500, 'Could not save recipes');
            sendJson(res, replyData);
        });
    });
}

// -------------------------------------------------------------
// Groups a list of rows by their recipe_id, e.g. every ingredient
// row for recipe 123 ends up together under key "123". Lets
// readRecipes() look up each recipe's ingredients in one step,
// instead of searching the WHOLE ingredients list once per recipe.
// -------------------------------------------------------------
function groupByRecipeId(rows) {
    const groups = new Map();
    rows.forEach(row => {
        if (!groups.has(row.recipe_id)) groups.set(row.recipe_id, []);
        groups.get(row.recipe_id).push(row);
    });
    return groups;
}

// -------------------------------------------------------------
// Reads recipes.csv and recipe_ingredients.csv, then combines them
// so each recipe object has its own list of ingredients attached.
// -------------------------------------------------------------
function readRecipes(callback) {
    // All three files are read at the SAME time rather than one
    // after another, since none of them depends on the others.
    // (UPDATE: through readRowsAsync(), so it's the database tables
    // instead when that's switched on.)
    Promise.all([
        readRowsAsync(RECIPES_FILE),
        readRowsAsync(RECIPE_INGREDIENTS_FILE),
        readRowsAsync(RECIPE_VOTES_FILE)
    ]).then(([recipes, ingredients, votes]) => {
        const ingredientsByRecipe = groupByRecipeId(ingredients);
        const votesByRecipe = groupByRecipeId(votes);

        // Attach each recipe's own ingredients AND votes by
        // matching recipe_id, same pattern as before.
        const recipesWithExtras = recipes.map(recipe => ({
            ...recipe,
            ingredients: ingredientsByRecipe.get(recipe.id) || [],
            votes: votesByRecipe.get(recipe.id) || []
        }));

        callback(null, recipesWithExtras);
    }, err => callback(err, null));
}

// -------------------------------------------------------------
// Reads all four inventory sections (pantry, fridge, freezer,
// chest) and combines them into ONE list. This is needed because
// a recipe doesn't care which section an ingredient lives in -
// it just needs to know the total amount you have anywhere in
// the house. Items with the same name+unit across different
// sections get added together.
// -------------------------------------------------------------
// UPDATE: it now reads the files with readEachSection() (further
// down) instead of its own copy of the same file-reading code, then
// combines them with mergeSections() just below.
function readAllInventory(callback) {
    // Only combine everything once ALL four files have
    // finished reading (they're async, so this stops us
    // returning early with only some sections loaded).
    // (readEachSection() now takes care of that - it waits for all
    // four files before calling back.)
    readEachSection((err, itemsBySection) => {
        if (err) return callback(err, null);
        callback(null, mergeSections(itemsBySection));
    });
}

// Combines the four storage areas' lists (from readEachSection) into
// one, adding together items with the same name+unit. Used by
// readAllInventory() above, and by the shopping list, which needs
// BOTH the separate lists and the combined one - so it reads the
// files once and uses this, instead of reading them twice.
function mergeSections(itemsBySection) {
    const merged = {};

    Object.values(itemsBySection).flat().forEach(item => {
        const key = item.name.toLowerCase() + '|' + item.unit;
        if (!merged[key]) {
            merged[key] = { name: item.name, unit: item.unit, quantity: 0 };
        }
        merged[key].quantity += Number(item.quantity);
        // Whether it's a "have it" item / marked running low
        // (see HAVE IT ITEMS) - true if ANY of the merged
        // ones are.
        merged[key].haveIt = merged[key].haveIt || isHaveIt(item);
        merged[key].low = merged[key].low || item.low === 'yes';
    });

    return Object.values(merged);
}

// -------------------------------------------------------------
// Gathers every item name the system should suggest: the curated
// baseline list PLUS every name already used in inventory or
// recipes. Curated names go in first, so the correct spelling of
// a common item is available as a suggestion even if you've never
// typed it before.
// -------------------------------------------------------------
function getAllItemNames(callback) {
    readAllInventory((err, inventoryItems) => {
        if (err) return callback(err, null);

        readRecipes((err, recipes) => {
            if (err) return callback(err, null);

            // Keyed by the LOWERCASE name, so "Tinned Tomatoes" and
            // "tinned tomatoes" count as the same item and only show
            // up once - we keep whichever casing we happen to see first.
            const namesByKey = new Map();

            function addName(name) {
                const key = name.toLowerCase();
                if (!namesByKey.has(key)) {
                    namesByKey.set(key, name);
                }
            }

            // Curated names go first, so they "win" if there's ever
            // a casing clash with something you've typed yourself.
            COMMON_GROCERY_ITEMS.forEach(addName);

            // Then the big built-in list from ingredient-data.js -
            // every name on both sides of the alias list (e.g. both
            // "Cilantro" AND "Coriander"), plus the extra names.
            // (UPDATE, phase 3: from the database now - every alias on
            // both sides, and every name in the ingredients table.)
            readAllAliases((err, aliases) => {
                if (err) return callback(err, null);

                aliases.forEach(a => {
                    addName(a.alias);
                    addName(a.canonical_name);
                });
                ingredientList.forEach(ingredient => addName(ingredient.ingredient_name));

                inventoryItems.forEach(item => addName(item.name));
                recipes.forEach(recipe => {
                    recipe.ingredients.forEach(ing => addName(ing.ingredient_name));
                });

                callback(null, Array.from(namesByKey.values()).sort());
            });
        });
    });
}

// =============================================================
// "I MADE THIS" - taking a recipe's ingredients out of stock
// =============================================================

// -------------------------------------------------------------
// When a recipe is marked as made, ingredients are taken from the
// storage areas in THIS order - the fridge first (most likely to go
// off), the chest freezer last. If one place doesn't have enough,
// the rest comes from the next place in the list.
// -------------------------------------------------------------
const DEDUCT_ORDER = ['fridge', 'pantry', 'freezer', 'chest'];

// -------------------------------------------------------------
// Teaspoon/tablespoon amounts are NEVER taken out of stock - the
// pantry tracks the bottle, not how many spoonfuls are left in it,
// so you remove the bottle yourself once it runs out. Same rule the
// Recipes page uses when checking what's missing.
// -------------------------------------------------------------
const SPOON_UNITS = ['tsp', 'tbsp'];

// Rounds to 2 decimal places, so taking 0.1kg away a few times
// doesn't leave something like 1499.9999999 grams behind.
function roundTo2(number) {
    return Math.round(number * 100) / 100;
}

// -------------------------------------------------------------
// Turns the alias list into a lookup table (lowercase alias ->
// canonical name), then gives back the lowercase canonical form of
// any name. Lets "Beef Mince" in a recipe match "Mince" in the
// fridge - same idea as resolveIngredientName() in recipes.js.
// -------------------------------------------------------------
//
// UPDATE: the lookup table is remembered for each alias list, so it's
// only built once until the list changes (see readAllAliases).
const aliasLookupCache = new WeakMap();

function buildAliasLookup(aliases) {
    if (aliasLookupCache.has(aliases)) return aliasLookupCache.get(aliases);

    const lookup = new Map();
    aliases.forEach(a => {
        const key = normalizeIngredientName(a.alias);
        if (!lookup.has(key)) lookup.set(key, a.canonical_name);
    });
    aliasLookupCache.set(aliases, lookup);
    return lookup;
}

// Follows the alias list as far as it goes, so aliases can build on
// each other: "Gravy Beef" -> "Stewing Beef" -> "Beef" (if you've
// added that second one yourself). Stops after 10 steps, or if it
// ever loops back to a name it's already seen, so a mistake in the
// alias list can never freeze the server.
//
// UPDATE: the same names get looked up over and over (every item in
// the house, for every ingredient of every recipe...), so each answer
// is remembered, per lookup table. A new alias list means a new
// table, so old answers are never used by mistake.
const canonicalKeyCache = new WeakMap();

function canonicalKey(name, aliasLookup) {
    if (!canonicalKeyCache.has(aliasLookup)) canonicalKeyCache.set(aliasLookup, new Map());
    const remembered = canonicalKeyCache.get(aliasLookup);
    if (remembered.has(name)) return remembered.get(name);

    let key = normalizeIngredientName(name);
    const seen = new Set();

    while (aliasLookup.has(key) && !seen.has(key) && seen.size < 10) {
        seen.add(key);
        key = normalizeIngredientName(aliasLookup.get(key));
    }
    remembered.set(name, key);
    return key;
}

// -------------------------------------------------------------
// Tidies up an ingredient name so small differences in how it's
// written don't stop two names matching:
// - capitals don't matter ("Onion" = "onion")
// - apostrophes are ignored ("Confectioners' Sugar")
// - hyphens count as spaces ("All-Purpose" = "All Purpose")
// - a plural LAST word counts as singular ("Onions" = "Onion",
//   "Tomatoes" = "Tomato", "Berries" = "Berry")
// The result is only used behind the scenes for matching - it's
// never shown on the page or saved anywhere.
// Same function as in recipes.js - keep the two the same.
// -------------------------------------------------------------
function normalizeIngredientName(name) {
    const words = String(name)
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ');

    let lastWord = words[words.length - 1];
    if (lastWord.length > 3) {
        if (lastWord.endsWith('oes')) {
            lastWord = lastWord.slice(0, -2);              // tomatoes -> tomato
        } else if (lastWord.endsWith('ies')) {
            lastWord = lastWord.slice(0, -3) + 'y';        // berries -> berry
        } else if (lastWord.endsWith('s') && !lastWord.endsWith('ss')) {
            lastWord = lastWord.slice(0, -1);              // onions -> onion (but not "swiss")
        }
    }
    words[words.length - 1] = lastWord;

    return words.join(' ');
}

// -------------------------------------------------------------
// TINS AS A UNIT. A tin is never stored as "tins" - it's turned
// into its weight/volume (e.g. 1 tin of tomatoes = 400 g) as soon as
// it's entered, using the sizes in TINNED_GOODS (ingredient-data.js).
// Anything not in that list counts as a standard 400 g tin.
// -------------------------------------------------------------
const TIN_UNITS = ['tin', 'tins', 'can', 'cans'];

function isTinUnit(unit) {
    return TIN_UNITS.includes(String(unit).toLowerCase());
}

// Tin sizes looked up by the tidied-up name (see normalizeIngredientName).
// (UPDATE, phase 3: filled in from the ingredients table - its
// tin_quantity / tin_unit columns - each time readAllAliases() reads
// it. Every route that works with tins reads the aliases first, so
// this is always filled in by the time it's needed.)
let TIN_SIZE_BY_KEY = new Map();

// How big one tin of this item is. Goes through the alias list
// first, so "Diced Tomatoes" or "Tin of chickpeas" find the right
// size too.
function tinSizeFor(name, aliasLookup) {
    return TIN_SIZE_BY_KEY.get(canonicalKey(name, aliasLookup)) || DEFAULT_TIN_SIZE;
}

// Whether something counts as a tinned good, for showing a tin count
// on the Inventory page - either it's in the tinned goods list, or
// its name says so ("Tinned...", "Canned...", "Tin of...").
function isTinnedGood(name, aliasLookup) {
    return TIN_SIZE_BY_KEY.has(canonicalKey(name, aliasLookup)) || /\b(tinned|canned|tins? of|cans? of)\b/i.test(name);
}

// -------------------------------------------------------------
// Adds a "tins" count to tinned goods before they're sent to the
// page, e.g. 4000 g of Tinned Tomatoes gets tins: 10, which the
// Inventory page shows as "4 kg (10 tins)". Only added to the copy
// that's SENT - it's never saved into the CSV.
// -------------------------------------------------------------
// =============================================================
// HAVE IT ITEMS - sauces, condiments and so on
// =============================================================
// Nobody logs every squirt of BBQ sauce, so for things like that the
// amount would be wrong within a week. Instead they're "have it"
// items: the app only cares whether there's SOME in the house.
// - they show as "BBQ Sauce - have it" instead of an amount
// - recipes just check they're in the house
// - "I made this" never takes any out (even if a recipe says 50 ml)
// - when one's getting low, someone presses L to mark it (see the
//   POST /pantry/low route), which puts it on the Running Low list
//   and the shopping list until more is added
// Everything else is a "counted" item, which works as before.
//
// Which kind an item is: whatever's been picked in its Edit box
// (the "track" column), or if nothing's been picked, a guess from
// its name using the words below.
// -------------------------------------------------------------
const HAVE_IT_WORDS = /\b(sauces?|syrups?|jams?|mayo|mayonnaise|pickles?|glaze|pastes?|oils?|vinegar|spices?|seasoning|yeast|crushed garlic|crushed ginger|ketchup|mustard|relish|chutney|dressing|honey|marmite|vegemite|peanut butter|sriracha|yoghurt|yogurt)\b/i;

function isHaveIt(item) {
    if (item.track === 'have') return true;
    if (item.track === 'amount') return false;
    return HAVE_IT_WORDS.test(item.name);
}

// Adds haveIt: true/false to each item, for the Inventory page to
// show "have it" instead of an amount.
function addTrackingInfo(items) {
    return items.map(item => ({ ...item, haveIt: isHaveIt(item) }));
}

function addTinCounts(items, aliasLookup) {
    return items.map(item => {
        if (!isTinnedGood(item.name, aliasLookup)) return item;

        const tin = tinSizeFor(item.name, aliasLookup);
        if (item.unit !== tin.unit) return item;

        return { ...item, tins: Math.round((Number(item.quantity) / tin.quantity) * 10) / 10 };
    });
}

// -------------------------------------------------------------
// Reads all four storage areas as SEPARATE lists, e.g.
// { fridge: [...], pantry: [...], ... }. Unlike readAllInventory(),
// nothing is merged together, because we need to know exactly
// which area each item lives in to take stock out of the right one.
// -------------------------------------------------------------
function readEachSection(callback) {
    const sections = Object.keys(csvFiles);

    // (UPDATE: through readRowsAsync(), so it's the database's
    // inventory table instead when that's switched on.)
    Promise.all(sections.map(section => readRowsAsync(csvFiles[section])))
        .then(sectionRows => {
            const itemsBySection = {};
            sections.forEach((section, index) => {
                itemsBySection[section] = sectionRows[index];
            });
            callback(null, itemsBySection);
        }, err => callback(err, null));
}

// -------------------------------------------------------------
// Works out exactly what "I made this" would take out of stock for
// one recipe. This changes the quantities inside itemsBySection
// directly, so the caller can save them straight afterwards - or
// just throw them away, if it's only a preview.
//
// The rules (as agreed):
// - g/kg/ml/L amounts are taken out (500g of a 2kg bag -> 1.5kg)
// - tsp/tbsp amounts are never taken out (see SPOON_UNITS)
// - "each" only takes WHOLE ones: 1.5 onions takes 1, half a
//   lemon takes nothing
// - if there isn't enough, whatever IS there gets used up, and the
//   shortfall is reported back rather than blocking the whole thing
//
// Gives back { deductions, skipped }, which the Recipes page turns
// into the "this will remove..." confirmation message, plus
// usedUpItems - the exact items that hit zero, so ONLY those get
// removed when saving (never anything else already in that list).
// -------------------------------------------------------------
function planRecipeDeduction(recipe, itemsBySection, aliasLookup) {
    const deductions = [];
    const skipped = [];
    const usedUpItems = new Set();

    recipe.ingredients.forEach(ing => {
        let quantity = Number(ing.quantity);
        let unit = ing.unit;

        // Nothing to take (e.g. an amount changed to 0 in the pop-up,
        // or left blank) - just skip it quietly.
        if (!(quantity > 0)) return;

        if (SPOON_UNITS.includes(unit)) {
            skipped.push({ ingredient: ing.ingredient_name, reason: 'spoon' });
            return;
        }

        // "Have it" items (sauces etc. - see HAVE IT ITEMS) are never
        // taken out, whatever the recipe's amount.
        const ingredientKey = canonicalKey(ing.ingredient_name, aliasLookup);
        const isHaveItInHouse = DEDUCT_ORDER.some(section =>
            itemsBySection[section].some(item => isHaveIt(item) && canonicalKey(item.name, aliasLookup) === ingredientKey));
        if (isHaveItInHouse) {
            skipped.push({ ingredient: ing.ingredient_name, reason: 'have-it' });
            return;
        }

        // Convert into the same base units the storage areas use
        // (grams / millilitres), so they can be compared fairly.
        if (isWeightUnit(unit)) {
            quantity = toGrams(quantity, unit);
            unit = 'g';
        } else if (isVolumeUnit(unit)) {
            quantity = toMilliliters(quantity, unit);
            unit = 'ml';
        } else if (isTinUnit(unit)) {
            // "1 tin chickpeas" -> 400 g, using the tin size table.
            const tin = tinSizeFor(ing.ingredient_name, aliasLookup);
            quantity = quantity * tin.quantity;
            unit = tin.unit;
        } else if (unit === 'each') {
            quantity = Math.floor(quantity);
            if (quantity === 0) {
                skipped.push({ ingredient: ing.ingredient_name, reason: 'less-than-one' });
                return;
            }
        }

        // The amount in the recipe's OWN unit (e.g. 1.8 kg rather than
        // 1800 g), which is what the pop-up shows in its edit box.
        // "each" uses the whole-number amount worked out above.
        const recipeQuantity = ing.unit === 'each' ? quantity : Number(ing.quantity);

        const neededKey = canonicalKey(ing.ingredient_name, aliasLookup);
        let stillNeeded = quantity;
        const taken = [];

        // How much of it there is in the WHOLE house before anything
        // is taken - lets the pop-up warn you straight away if you
        // type in more than you've actually got.
        // foundIn lists every place it's stored, in the order stock
        // would be taken, so the pop-up can say where it comes from.
        let available = 0;
        const foundIn = [];
        DEDUCT_ORDER.forEach(section => {
            itemsBySection[section].forEach(item => {
                if (item.unit === unit && canonicalKey(item.name, aliasLookup) === neededKey && Number(item.quantity) > 0) {
                    available += Number(item.quantity);
                    foundIn.push({ section, item: item.name });
                }
            });
        });

        // Go through each storage area in DEDUCT_ORDER, taking from
        // every matching item (same canonical name AND same unit)
        // until the recipe's amount is covered.
        DEDUCT_ORDER.forEach(section => {
            itemsBySection[section].forEach(item => {
                if (stillNeeded <= 0) return;
                if (item.unit !== unit) return;
                if (canonicalKey(item.name, aliasLookup) !== neededKey) return;

                const have = Number(item.quantity);
                if (have <= 0) return;

                const takeAmount = Math.min(have, stillNeeded);
                item.quantity = roundTo2(have - takeAmount);
                if (item.quantity <= 0) usedUpItems.add(item);
                stillNeeded = roundTo2(stillNeeded - takeAmount);
                taken.push({ section, item: item.name, quantity: takeAmount, unit });
            });
        });

        deductions.push({
            ingredient: ing.ingredient_name,
            unit,
            recipeQuantity,
            recipeUnit: ing.unit,
            available: roundTo2(available),
            foundIn,
            taken,
            short: stillNeeded
        });
    });

    return { deductions, skipped, usedUpItems };
}

// -------------------------------------------------------------
// Opens a real browser, searches Woolworths NZ for the given
// term, and returns every matching product with its price.
//
// UPDATED: Woolworths changed how their website fetches search
// results. It used to call /api/v1/products and get back a flat
// list of items. It now sends a GraphQL request to
// /api/graphql?op-name=ProductSearch and gets back a differently
// shaped reply, so this function now (1) listens for that new
// request, and (2) reads the prices out of the new shape.
//
// The browser still runs with headless: false. On the server this
// works because xvfb-run supplies a virtual screen for it.
// -------------------------------------------------------------
async function searchWoolworths(searchTerm, storeName) {
    // Fall back to the default store if none was given, or if
    // someone passes a name that isn't in our list.
    const chosenStore = WOOLWORTHS_STORES[storeName] ? storeName : DEFAULT_WOOLWORTHS_STORE;
    const storeCookie = WOOLWORTHS_STORES[chosenStore];

    // Visible (non-headless) browser - Woolworths' bot protection
    // is more likely to block an invisible one.
    const browser = await chromium.launch({ headless: false });

    // try/finally makes sure the browser ALWAYS gets closed, even if
    // the search times out or throws - otherwise every failed search
    // leaves a whole Chromium window running on the server forever.
    let data;
    try {
        const context = await browser.newContext();

        // Set the store cookie BEFORE the browser ever visits the site,
        // so it behaves like a returning visitor who already picked
        // this specific store - same trick we worked out originally.
        await context.addCookies([
            {
                name: 'cw-lrkswrdjp',
                value: storeCookie,
                domain: 'www.woolworths.co.nz',
                path: '/'
            }
        ]);

        const page = await context.newPage();
        await page.goto('https://www.woolworths.co.nz/');

        // Woolworths' homepage can take several seconds to finish
        // loading, and typing into the search box before it's ready
        // means the search silently never happens (it used to wait a
        // flat 2 seconds, which wasn't always enough). So: wait until
        // the search box has actually appeared, THEN give the page's
        // own code another 4 seconds to finish setting itself up.
        await page.waitForSelector("input[type='search']", { state: 'visible', timeout: 20000 });
        await page.waitForTimeout(4000);

        // Wait specifically for the search response, don't just hope
        // we're fast enough to catch it in the background.
        // The home page ALSO sends a ProductSearch request by itself
        // (it loads a product group, not a keyword search), so matching
        // the address alone would catch the wrong one. Every real search
        // request contains "byKeyword" in its body, so we check for that
        // too, which makes sure we catch the response to OUR search.
        const [response] = await Promise.all([
            page.waitForResponse(
                r => r.url().includes('/api/graphql?op-name=ProductSearch') &&
                     (r.request().postData() || '').includes('"byKeyword"'),
                { timeout: 15000 }
            ),
            (async () => {
                await page.fill("input[type='search']", searchTerm);
                // Give the site's own autocomplete dropdown a moment to
                // finish loading before we press Enter - pressing it too
                // early risks the dropdown's own JS swallowing the
                // keypress before the real search fires.
                await page.waitForTimeout(1500);
                await page.keyboard.press('Enter');
            })()
        ]);

        data = await response.json();
    } finally {
        await browser.close();
    }

    // The list of results now lives at data.My.products.results.
    // The "(x && x.y)" checks stop the code crashing if any part of
    // that path is missing - it falls back to an empty list instead.
    const myData = data.data && data.data.My;
    const results = (myData && myData.products && myData.products.results) || [];

    // This will hold one row per product "variant" (see below).
    const rows = [];

    // The results list mixes real products with adverts and banners.
    // "ProductSummary" is a normal product - skip everything else.
    results
        .filter(item => item.__typename === 'ProductSummary')
        .forEach(item => {

            // Each product has one or more "variants" - different
            // ways to buy it. Most have just one, but loose fruit
            // and veg often have two: "per kg" and "each". Each
            // variant has its own price, so each gets its own row.
            item.variants.forEach(variant => {
                const price = variant.variantPrice;

                // Skip any variant that has no price information.
                if (!price) return;

                rows.push({
                    // Woolworths USUALLY already starts the name with the
                    // brand ("Wattie's Baked Beans 420g Can"), but it also
                    // sends the brand separately - so it's only added on
                    // the front when the name doesn't already start with
                    // it, rather than showing "Wattie's Wattie's...".
                    name: item.brand && !item.productName.toLowerCase().startsWith(item.brand.toLowerCase())
                        ? `${item.brand} ${item.productName}`
                        : item.productName,
                    // What you actually pay for this variant.
                    price: price.sellingPrice,
                    // Woolworths' own comparison price, e.g. 16.45
                    // for "1KG". cupUnit looks like "1KG", "1EA"
                    // or "100G", so it shows as "$16.45 / 1KG".
                    cupPrice: price.cupPrice,
                    cupMeasure: price.cupUnit,
                    // The old reply had a separate pack size field
                    // (e.g. "6 x 60mL"). The new one doesn't - the
                    // size is only written inside the product name
                    // (e.g. "...Cherry 180g Punnet") - so this is
                    // null for now and shows as a dash on the page.
                    // UPDATE: it's now read back OUT of the product name
                    // instead - see sizeFromWoolworthsName() below.
                    packageSize: sizeFromWoolworthsName(item.productName, variant),
                    // The new reply doesn't include the store's
                    // address like the old one did, so we use the
                    // store name that was chosen in the dropdown.
                    store: chosenStore,
                    // (UPDATE, phase 5) Woolworths' own code for the
                    // product, and its barcode, so a saved price can be
                    // linked to the product (see appendPrices()). NOT yet
                    // confirmed against a real reply from the new
                    // GraphQL search - the old API called these "sku" and
                    // "barcode". If a field isn't there it's just left
                    // blank and the price saves the same as before.
                    productCode: String(item.sku || variant.sku || item.productId || '') || null,
                    barcode: item.barcode || variant.barcode || null,
                    brand: item.brand || null
                });
            });
        });

    return rows;
}

// -------------------------------------------------------------
// Woolworths doesn't send the pack size as its own field - it's only
// written inside the product name, e.g. "...Diced Tomatoes 400g Can"
// or "Wattie's Baked Beans 3 x 420g Cans". This finds the LAST size
// written in the name (so a number earlier in the name, like "100%
// Juice", isn't mistaken for it) and hands back just that part:
// "400g", "3 x 420g", "1.5L", "6pk".
//
// Loose fruit/veg sold by weight has no size in its name at all -
// for those, the "per kg" way of buying it is shown instead.
// Anything else with no size found comes back null (a dash).
// -------------------------------------------------------------
function sizeFromWoolworthsName(productName, variant) {
    const sizePattern = /(\d+\s*x\s*)?\d+(\.\d+)?\s*(kg|g|ml|l|pk|pack|ea|sheets|rolls)\b/gi;
    const matches = (productName || '').match(sizePattern);

    if (matches) {
        // Tidy it up: "420 g" -> "420g", "3x420g" -> "3 x 420g",
        // "1.25l" -> "1.25L". Word units like "12 rolls" keep their space.
        return matches[matches.length - 1]
            .replace(/(\d)\s+(kg|g|ml|l|pk)\b/gi, '$1$2')
            .replace(/\s*x\s*/i, ' x ')
            .replace(/(\d)l\b/g, '$1L');
    }

    const unit = (variant && variant.unitOfMeasure || '').toUpperCase();
    if (unit.startsWith('KG')) return 'per kg';

    return null;
}

// -------------------------------------------------------------
// Same idea as searchWoolworths above, but for Pak'nSave. The
// site is protected by Cloudflare (not the same protection as
// Woolworths, but the same underlying reasoning applies) - a real
// browser is needed to naturally pass its checks and generate a
// valid session, which we then read the response from rather
// than trying to fake ourselves.
// -------------------------------------------------------------
async function searchPakNSave(searchTerm, storeName) {
    const chosenStore = PAKNSAVE_STORES[storeName] ? storeName : DEFAULT_PAKNSAVE_STORE;
    const storeId = PAKNSAVE_STORES[chosenStore];

    const browser = await chromium.launch({ headless: false });

    // Always close the browser, even on a timeout/error - see
    // searchWoolworths() above.
    let data;
    try {
        const context = await browser.newContext();

        // Pak'nSave remembers your chosen store across TWO cookies
        // together, rather than Woolworths' single one. Set before the
        // site ever loads, same reasoning as before.
        await context.addCookies([
            {
                name: 'eCom_STORE_ID',
                value: storeId,
                domain: 'www.paknsave.co.nz',
                path: '/'
            },
            {
                name: 'STORE_ID_V2',
                value: `${storeId}|False`,
                domain: 'www.paknsave.co.nz',
                path: '/'
            }
        ]);

        const page = await context.newPage();

        // Pak'nSave's site asks the browser for your location. With a
        // real, visible browser, that shows an actual popup that just
        // sits there waiting for someone to click something - which
        // would stall the whole search. This runs BEFORE any of the
        // site's own code, replacing the location API with a version
        // that immediately says "no" on its own, so the real popup
        // never gets a chance to appear at all.
        await page.addInitScript(() => {
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition = (success, error) => {
                    if (error) error({ code: 1, message: 'User denied Geolocation' });
                };
                navigator.geolocation.watchPosition = (success, error) => {
                    if (error) error({ code: 1, message: 'User denied Geolocation' });
                    return 0;
                };
            }
        });

        // Loading the homepage first lets the site's own JavaScript do
        // two things we can't fake ourselves: solve Cloudflare's bot
        // check (earning a valid cf_clearance cookie) and set up its
        // own short-lived anonymous session token, used to authorize
        // the product-price request below.
        await page.goto('https://www.paknsave.co.nz/');
        await page.waitForTimeout(3000);

        // Found via Inspect Element on the real site - this input has
        // a proper id, so we can target it exactly rather than guessing.
        const [response] = await Promise.all([
            page.waitForResponse(
                r => r.url().includes('/v1/edge/search/paginated/products') && r.request().method() === 'POST',
                { timeout: 20000 }
            ),
            (async () => {
                await page.fill("#search-bar-desktop", searchTerm);
                await page.waitForTimeout(1500);
                await page.keyboard.press('Enter');
            })()
        ]);

        data = await response.json();

        // Reads back which store ID actually went out in the request
        // itself - lets us directly confirm the two cookies above
        // worked, rather than just hoping they did.
        const requestBody = response.request().postDataJSON();
        const storeIdUsed = requestBody ? requestBody.storeId : null;
        console.log(`Pak'nSave store ID used: ${storeIdUsed}`);
    } finally {
        await browser.close();
    }

    const products = data.products || [];

    return products.map(product => {
        const singlePrice = product.singlePrice || {};
        const comparativePrice = singlePrice.comparativePrice || {};

        return {
            // Pak'nSave keeps the brand ("Pams", "Pams Value", "Wattie's")
            // in its OWN field, separate from the product name - so it's
            // added on the front here, otherwise "Pams Baked Beans" just
            // showed up as "Baked Beans In Rich Tomato Sauce".
            name: [product.brand, product.name].filter(Boolean).join(' '),
            // Pak'nSave gives prices in CENTS (1849 = $18.49), unlike
            // Woolworths' plain decimal dollars - divide by 100.
            price: typeof singlePrice.price === 'number' ? singlePrice.price / 100 : null,
            cupPrice: typeof comparativePrice.pricePerUnit === 'number' ? comparativePrice.pricePerUnit / 100 : null,
            cupMeasure: comparativePrice.measureDescription || null,
            // e.g. "60g" - confirmed via a raw response dump. Note
            // this is a straightforward pack size for most products,
            // but Pak'nSave's cents-based pricing/comparative-price
            // fields above are the more precise numbers to trust for
            // any actual calculations.
            packageSize: product.displayName || null,
            store: chosenStore,
            // (UPDATE, phase 5) Pak'nSave's own code for the product,
            // e.g. "5001949-EA-000" (confirmed via a raw response dump).
            // The same code is used at every Pak'nSave and New World.
            // No barcode comes back with a search - that has to be
            // linked separately (see linkStoreProducts() in database.js).
            productCode: product.productId || null,
            brand: product.brand || null
        };
    });
}


// -------------------------------------------------------------
// Searches Trents Wholesale for the given term. Unlike Woolworths/
// Pak'nSave, this needs a real login every time rather than just a
// store cookie - proven separately first via trents-login-check.js
// and trents-next-test.js before being folded in here. Trents also
// doesn't hand back a clean JSON API response like the other two,
// so results are read straight out of the rendered results page
// instead of intercepted from a background request.
// -------------------------------------------------------------
async function searchTrents(searchTerm) {
    const browser = await chromium.launch({ headless: false });

    // Always close the browser, even on a timeout/error - see
    // searchWoolworths() above.
    let rawProducts;
    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto('https://online.trents.co.nz/');
        await page.waitForTimeout(2000);

        // Target by "name" rather than "id" - the real ids have colons
        // in them (tcc_sitelogin:loginForm:username), which CSS
        // selectors treat as special characters.
        await page.fill('input[name="tcc_sitelogin:loginForm:username"]', TRENTS_USERNAME);
        await page.fill('input[name="tcc_sitelogin:loginForm:password"]', TRENTS_PASSWORD);
        await page.keyboard.press('Enter');

        // Login goes through a Salesforce handoff page (frontdoor.jsp)
        // that redirects itself on to the real homepage - wait
        // specifically for that, rather than guessing how long it takes.
        await page.waitForURL('**/ccrz__HomePage**', { timeout: 15000 });
        await page.waitForLoadState('networkidle');

        await page.fill('#searchText', searchTerm);
        await page.click('#doSearch');

        await page.waitForURL('**/ccrz__ProductList**', { timeout: 15000 });
        await page.waitForLoadState('networkidle');

        // Runs INSIDE the browser page itself, against every product
        // tile on the results page - reads name, price, and pack size
        // straight out of the rendered HTML.
        rawProducts = await page.$$eval('.cc_product_item', items => {
            return items.map(item => {
                const name = item.querySelector('.cc_product_name')?.textContent.trim() || null;
                const size = item.querySelector('.cc_product_uom')?.textContent.trim() || null;

                // The price element's text includes the "/ Carton" or
                // "/ Each" span text glued on the end (e.g. "$22.11/
                // Carton"), so pull just the $ amount out with a pattern
                // match rather than trying to separate the text nodes.
                const priceBlock = item.querySelector('.product-list-price')?.textContent || '';
                const priceMatch = priceBlock.match(/\$([\d.]+)/);
                const price = priceMatch ? Number(priceMatch[1]) : null;

                return { name, size, price };
            });
        });
    } finally {
        await browser.close();
    }

    // Reshape into the SAME shape searchWoolworths()/searchPakNSave()
    // return, so the price checker page doesn't need to know or care
    // which retailer a result came from. cupPrice/cupMeasure here
    // are OUR OWN calculation, not one Trents publishes themselves.
    return rawProducts.map(product => {
        // Trents shows prices excluding GST - add it BEFORE
        // calculating a per-kg price, so that figure is GST-inclusive
        // too, not just the headline price.
        const priceIncludingGst = addGst(product.price);

        const { cupPrice, cupMeasure } = calculateTrentsUnitPrice(priceIncludingGst, product.size);
        return {
            name: product.name,
            price: priceIncludingGst,
            cupPrice,
            cupMeasure,
            // The plain pack size (e.g. "3kg", "6pk") - same value
            // used to calculate cupPrice above where possible, but
            // shown as its own column regardless, since it's useful
            // to see even when a $/kg figure couldn't be calculated.
            packageSize: product.size,
            store: TRENTS_STORE_NAME
        };
    });
}


// -------------------------------------------------------------
// Runs a price search at ONE store, using whichever retailer's
// scraper that store belongs to. Used for normal single-store
// searches, and once per store for "Our 3 stores".
// -------------------------------------------------------------
// (UPDATE, phase 2: waits for the store lists to be read from the
// database first - see loadStores().)
async function searchOneStore(searchTerm, storeName) {
    await loadStores();

    // The dropdown is one combined list, but each store name
    // still tells us which retailer's scraper to actually run.
    const isPakNSaveStore = Object.prototype.hasOwnProperty.call(PAKNSAVE_STORES, storeName);
    const isTrentsStore = storeName === TRENTS_STORE_NAME;

    if (isTrentsStore) {
        return searchTrents(searchTerm);
    } else if (isPakNSaveStore) {
        return searchPakNSave(searchTerm, storeName);
    }
    return searchWoolworths(searchTerm, storeName);
}

// Reads prices.csv. If the file doesn't exist yet (nobody has
// saved a price yet), that's not an error - it just means an
// empty history so far.
// (UPDATE: now just uses readOptionalCsv() - see LOW STOCK - which
// does exactly this for any file.)
function readPrices(callback) {
    readOptionalCsv(PRICES_FILE, callback);
}

// -------------------------------------------------------------
// Adds NEW prices to the history (every way of saving a price goes
// through here). It just INSERTs the new rows - the rest of the
// history is never touched.
// (UPDATE, phase 2: the CSV version - read the whole file, add them
// on the end, save it all back - was taken out with the CSV files.
// Prices also no longer have an id: each one is known by its store,
// product name and the exact time it was saved.)
//
// UPDATE, phase 5: each price can also carry
// - product_code: the supermarket's own code for it (saved with it)
// - barcode, brand: only if the supermarket sent them with the result
//   (Woolworths' results can include the barcode). Those aren't saved
//   on the price itself - instead, once the prices are in, the
//   product code is linked to that barcode (see linkStoreProducts()
//   in database.js), so from then on EVERY price with that code - old
//   ones too - knows its barcode. If the linking goes wrong, the
//   prices are still saved; it's just tried again next time.
// -------------------------------------------------------------
function appendPrices(newPrices, callback) {
    database.appendRows(PRICES_FILE, newPrices, err => {
        if (err) return callback(err);

        const links = newPrices
            .filter(p => p.product_code && p.barcode)
            .map(p => ({ store: p.store, product_code: p.product_code, barcode: p.barcode, brand: p.brand, product_name: p.original_name }));
        if (links.length === 0) return callback(null);

        database.linkStoreProducts(links, () => callback(null));
    });
}

// -------------------------------------------------------------
// Tidies a barcode from a supermarket so it matches one scanned at
// home (UPDATE, phase 5): digits only, and the extra zeros on the
// front of a 14-digit "GTIN-14" taken off, down to the usual 13
// digits - e.g. "09415221000123" -> "9415221000123". Anything too
// short to be a real barcode (under 8 digits) gives ''.
// -------------------------------------------------------------
function tidyBarcode(value) {
    let digits = String(value || '').replace(/\D/g, '');
    while (digits.length > 13 && digits.startsWith('0')) digits = digits.slice(1);
    return digits.length >= 8 ? digits : '';
}

// -------------------------------------------------------------
// The phase 5 fields every way of saving a price passes on from a
// search result (see appendPrices() above): the supermarket's product
// code, plus the barcode and brand if it sent them.
// -------------------------------------------------------------
function productFieldsFrom(result) {
    return {
        product_code: result.productCode || result.product_code || '',
        barcode: tidyBarcode(result.barcode),
        brand: result.brand || ''
    };
}

// Reads ingredient_aliases.csv. If it doesn't exist yet (no
// aliases added so far), that's not an error - just no aliases.
// (UPDATE: now just uses readOptionalCsv(), same as readPrices.)
function readAliases(callback) {
    readOptionalCsv(ALIASES_FILE, callback);
}

// -------------------------------------------------------------
// YOUR aliases (ingredient_aliases.csv) plus the built-in ones from
// ingredient-data.js, as one list. Yours come FIRST, so if the same
// name is in both, yours wins (buildAliasLookup keeps the first).
// Only used for reading - saving a new alias still only ever writes
// your own ones to the CSV, never the built-in list.
// -------------------------------------------------------------
//
// UPDATE: this is used by almost every request (opening the Inventory
// page alone asks four times), so instead of re-reading your file and
// rebuilding the ~500 built-in aliases every time:
// - the built-in list is made ONCE, when the server starts
// - the combined list is kept, and only rebuilt when your
//   ingredient_aliases.csv has actually changed since last time
//   (checked by the file's "last modified" time - so even editing
//   the file by hand on the garage is picked up straight away)
// Nothing that uses the list changes it, so it's safe to share.
// (UPDATE, phase 3: the built-in aliases are rows in the database
// now, so there's no separate built-in list to add on.)
let aliasListCache = { modified: null, list: null };

// Every ingredient in the ingredients table, e.g. { ingredient_name:
// "Tinned Tomatoes", tin_quantity: "400", tin_unit: "g", source:
// "built_in" } - read along with the aliases, and kept with them.
let ingredientList = [];

// UPDATE: with the database switched on there's no file to check the
// time of - instead the list is kept until saveAliases() (the only
// thing that changes it) throws it away. An alias added straight
// into the table in SSMS is picked up at the next restart (the
// garage restarts the server every hour anyway).
// (UPDATE, phase 2: the file-time check for the CSV was taken out.)
// (UPDATE, phase 3: also reads the ingredients table - for the tin
// sizes and for linking names to ingredients, see linkIngredients().)
function readAllAliases(callback) {
    if (aliasListCache.list) return callback(null, aliasListCache.list);
    readAliases((err, aliases) => {
        if (err) return callback(err, null);
        readOptionalCsv('ingredients', (err, ingredients) => {
            if (err) return callback(err, null);
            ingredientList = ingredients;
            TIN_SIZE_BY_KEY = new Map(ingredients
                .filter(ingredient => ingredient.tin_quantity !== '')
                .map(ingredient => [normalizeIngredientName(ingredient.ingredient_name),
                    { quantity: Number(ingredient.tin_quantity), unit: ingredient.tin_unit }]));
            aliasListCache = { modified: 'database', list: aliases };
            callback(null, aliasListCache.list);
        });
    });
}

// Forgets the remembered aliases and ingredients, so the next
// readAllAliases() reads them fresh - after anything that might have
// added an ingredient.
function forgetAliases() {
    aliasListCache = { modified: null, list: null };
}

// -------------------------------------------------------------
// LINKING NAMES TO INGREDIENTS (UPDATE, phase 3)
// -------------------------------------------------------------
// Stock, recipe ingredients, minimums and barcodes keep the name as
// typed, plus "ingredient" - the ingredient in the ingredients table
// it counts as. That's worked out the same way the rest of this file
// matches names (canonicalKey(): capitals, plurals, hyphens don't
// matter, aliases are followed), then the ingredient with that key is
// used, e.g. "Ground beef" -> "Mince". A name that matches nothing is
// its own ingredient, added to the table when it's saved (see
// addMissingIngredients in database.js).
//
// Which field holds the name as typed, for each kind of data:
const INGREDIENT_NAME_FIELDS = {
    'pantry.csv': 'name',
    'fridge.csv': 'name',
    'freezer.csv': 'name',
    'chest.csv': 'name',
    'recipe_ingredients.csv': 'ingredient_name',
    'stock_minimums.csv': 'name',
    // (UPDATE, phase 5: was 'barcodes.csv' - see the BARCODES section)
    'products': 'name'
};

function linkIngredients(rows, nameField, callback) {
    readAllAliases((err, aliases) => {
        if (err) return callback(err);
        const aliasLookup = buildAliasLookup(aliases);

        const ingredientByKey = new Map();
        ingredientList.forEach(ingredient => {
            const key = normalizeIngredientName(ingredient.ingredient_name);
            if (!ingredientByKey.has(key)) ingredientByKey.set(key, ingredient.ingredient_name);
        });

        rows.forEach(row => {
            const typed = String(row[nameField] || '').trim();
            row.ingredient = ingredientByKey.get(canonicalKey(typed, aliasLookup)) || typed;
        });
        callback(null);
    });
}

// Saves the FULL alias list back to ingredient_aliases.csv.
// (UPDATE: or the database - see saveRows. Either way the remembered
// combined list is thrown away, so the next readAllAliases() re-reads it.)
function saveAliases(aliases, callback) {
    forgetAliases();
    saveRows(ALIASES_FILE, aliases, callback);
}

// -------------------------------------------------------------
// Reads JSON out of a request body. If the body isn't valid JSON,
// this sends back a 400 error itself and returns null - without
// this, one bad request would throw inside the 'end' handler and
// crash (and stop) the whole server.
// -------------------------------------------------------------
function parseJsonBody(body, res) {
    try {
        return JSON.parse(body);
    } catch (err) {
        sendText(res, 400, 'Invalid JSON in request body');
        return null;
    }
}

// -------------------------------------------------------------
// Collects the whole request body (it arrives in chunks), turns it
// into an object with parseJsonBody() above, then hands it to
// onData. If the JSON is bad, a 400 reply has already been sent
// and onData never runs.
// -------------------------------------------------------------
function readJsonBody(req, res, onData) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        const data = parseJsonBody(body, res);
        if (data) onData(data);
    });
}

// =============================================================
// LOGIN - keeps random people out if they ever find the address
// =============================================================

// -------------------------------------------------------------
// How it works:
// 1. A new phone/computer opens any page and gets sent to
//    login.html (see auth.js).
// 2. Logging in as one of HOUSEHOLD_MEMBERS, with their first name
//    as BOTH the username and password (e.g. todd / todd), gets
//    that browser a random "session" code, saved in a cookie.
// 3. Every request after that sends the cookie back automatically,
//    and the server checks the code is one it handed out. No valid
//    code = the server refuses to read or change anything.
//
// It remembers the BROWSER (via the cookie), not the IP address -
// the garage server sits behind a proxy, so nearly every visitor
// looks like the same address to it, and home/phone IPs change all
// the time anyway.
//
// Logged-in browsers are saved in sessions.json so a server restart
// (like the hourly update) doesn't log everyone out. That file is
// in .gitignore, so git never touches or deletes it.
// -------------------------------------------------------------
const SESSIONS_FILE = 'sessions.json';
const SESSION_COOKIE = 'pantry_session';

// How long a browser stays logged in for - one year, in seconds.
const SESSION_LENGTH_SECONDS = 60 * 60 * 24 * 365;

// Every logged-in browser: session code -> { person, created }.
// Read from the file once when the server starts up.
let sessions = {};
try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
} catch (err) {
    // No file yet (nobody's logged in so far) - start with none.
    sessions = {};
}

function saveSessions() {
    writeFileSafely(SESSIONS_FILE, JSON.stringify(sessions, null, 2), err => {
        if (err) console.error('Could not save sessions.json:', err);
    });
}

// Pulls the cookies the browser sent into a simple object, e.g.
// "pantry_session=abc123; other=xyz" -> { pantry_session: 'abc123', other: 'xyz' }
function readCookies(req) {
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(part => {
        const [name, ...rest] = part.trim().split('=');
        if (name) cookies[name] = decodeURIComponent(rest.join('='));
    });
    return cookies;
}

// Who's logged in on this request, e.g. "Todd" - or null if nobody.
function loggedInPerson(req) {
    const code = readCookies(req)[SESSION_COOKIE];
    const session = code && sessions[code];
    return session ? session.person : null;
}

// Checks a login attempt. Username and password are both just the
// person's first name, and capitals don't matter ("Todd" / "todd").
// Gives back the person's name as written in HOUSEHOLD_MEMBERS, or
// null if it's not a match.
// (UPDATE, phase 2: the names come from the people table now - see
// readPeople() - so checkLogin() is handed that list.)
function checkLogin(username, password, householdMembers) {
    const typedName = String(username || '').trim().toLowerCase();
    const typedPassword = String(password || '').trim().toLowerCase();
    const person = householdMembers.find(name => name.toLowerCase() === typedName);
    return person && typedPassword === typedName ? person : null;
}

// Everyone in the people table, e.g. ['Charlotte', 'Todd', 'Kayleigh'],
// in the order they were added. Read once and kept until the server
// restarts (hourly on the garage), so add someone in SSMS and they can
// log in within the hour.
let householdMembers = null;

async function readPeople() {
    if (!householdMembers) {
        householdMembers = (await database.readRowsAsync('people')).map(person => person.name);
    }
    return householdMembers;
}

// =============================================================
// ACTIVITY LOG - "who changed what"
// =============================================================
// Every change to the house stock is written as one line in
// activity_log.csv on the garage, e.g.
//   2026-10-14, 18:05, Todd, Used (I made this), Mince, 500, g, Fridge, Beef Tacos
// It's NOT shown anywhere on the website - it's just a record you
// can open in Excel/Google Sheets on the garage (or copy off it),
// and it's laid out like a spreadsheet so it can go straight into a
// database later. Like the other CSVs it's in .gitignore, so the
// hourly update never touches it.
//
// Lines are only ever ADDED to the end - nothing is rewritten - so
// it's safe even with lots of changes happening at once.
// -------------------------------------------------------------
const ACTIVITY_LOG_FILE = 'activity_log.csv';
const ACTIVITY_LOG_HEADERS = ['date', 'time', 'person', 'action', 'item', 'quantity', 'unit', 'location', 'details'];

// The friendly name of each storage area, for the log.
const SECTION_NAMES = {
    pantry: 'Pantry',
    fridge: 'Fridge',
    freezer: 'Freezer (Inside)',
    chest: 'Chest Freezer'
};

// Today's date and the time right now in NZ, e.g. "2026-10-14" and
// "18:05". NZ time is asked for by name, so it's right even if the
// garage server's own clock is set to a different time zone.
function nzDateAndTime() {
    const now = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });   // en-CA writes dates as YYYY-MM-DD
    const time = now.toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit' });
    return { date, time };
}

// Adds one or more lines to the log. Each row is an object with any
// of: action, item, quantity, unit, location, details. If the log
// can't be written it's only reported in the server's output - a
// logging problem should never stop the actual change from saving.
function logActivity(person, rows) {
    if (rows.length === 0) return;
    const { date, time } = nzDateAndTime();

    // With the database switched on, the lines are INSERTed into the
    // activity_log table instead (still only ever added, never changed).
    // (UPDATE, phase 2: always the database now. The database stamps
    // each change with its exact time and numbers its lines 1, 2, 3 -
    // date and time here are only kept for anything reading the rows.)
    const logRows = rows.map(row => ({ ...row, date, time, person }));
    database.appendRows(ACTIVITY_LOG_FILE, logRows, err => {
        if (err) console.error('Could not write to the activity log:', err.message);
    });
}

// =============================================================
// UNDO - the "Removed Rice - Undo" message
// =============================================================
// Just before any change to the house stock is saved, a copy of the
// storage areas it's about to change is kept here (in memory only).
// Clicking Undo puts those copies back.
//
// Only the MOST RECENT change can be undone, and each change gets its
// own code (undoId). The Undo button sends that code back, and if
// anything else has changed since (e.g. Todd added something in the
// meantime), the codes won't match and it says "too late" instead -
// so an undo can never wipe out someone else's newer change.
//
// It's forgotten when the server restarts (e.g. the hourly update),
// which is fine - the Undo button only shows for a few seconds.
// -------------------------------------------------------------
let lastChange = null;   // { undoId, person, description, savedCopies: { section: items } }

// Takes the copies of the given storage areas, then hands back the
// new undoId. Must be called INSIDE runOneAtATime, before saving.
// (UPDATE: the copies are now the list of items rather than the raw
// CSV text, read through readRowsAsync() - so Undo works the same
// with the database switched on, and puts them back with saveItems().)
function rememberForUndo(sections, person, description, callback) {
    Promise.all(sections.map(section => readRowsAsync(csvFiles[section])))
        .then(copies => {
            const savedCopies = {};
            sections.forEach((section, index) => { savedCopies[section] = copies[index]; });
            const undoId = crypto.randomBytes(8).toString('hex');
            lastChange = { undoId, person, description, savedCopies };
            callback(null, undoId);
        }, err => callback(err, null));
}

// =============================================================
// LOW STOCK - "always want 2 tins of tomatoes"
// =============================================================
// Saved in stock_minimums.csv - only the items you've CHOSEN to set
// a minimum for are in there, everything else is left alone. The
// minimum is stored in the same base unit as the stock itself
// (grams / millilitres / each), so they can be compared directly -
// e.g. "2 tins of tomatoes" is saved as 800 g.
// (UPDATE, phase 5: they're saved ON the ingredients table now -
// minimum_quantity and minimum_unit - so each ingredient has at most
// one minimum, and the name shown is the ingredient's name. Still
// read and saved here as 'stock_minimums.csv' - database.js handles it.)
// -------------------------------------------------------------
const STOCK_MINIMUMS_FILE = 'stock_minimums.csv';
const STOCK_MINIMUM_HEADERS = ['name', 'minimum', 'unit'];

// Reads a CSV file that might not exist yet (like the minimums,
// before you've set any) - a missing file just means "nothing yet".
// (UPDATE: with the database switched on, it reads the matching
// table instead - an empty table is just an empty list.)
// (UPDATE, phase 2: always the database now.)
function readOptionalCsv(filePath, callback) {
    database.readRows(filePath, callback);
}

// Every minimum, with how much is in the whole house right now
// ("have") and whether that's below the minimum ("low"). Names are
// matched the same way "I made this" matches them, so a minimum for
// "Tinned Tomatoes" counts "Chopped Tomatoes" too if they're aliases.
// Tinned goods also get a tin count for each, e.g. 2 tins.
function readStockMinimums(callback) {
    readOptionalCsv(STOCK_MINIMUMS_FILE, (err, minimums) => {
        if (err) return callback(err, null);

        readAllAliases((err, aliases) => {
            if (err) return callback(err, null);
            const aliasLookup = buildAliasLookup(aliases);

            readAllInventory((err, inventoryItems) => {
                if (err) return callback(err, null);

                const results = minimums.map(min => {
                    const key = canonicalKey(min.name, aliasLookup);
                    const have = inventoryItems
                        .filter(item => item.unit === min.unit && canonicalKey(item.name, aliasLookup) === key)
                        .reduce((total, item) => total + Number(item.quantity), 0);

                    const result = {
                        name: min.name,
                        minimum: Number(min.minimum),
                        unit: min.unit,
                        have: roundTo2(have),
                        low: have < Number(min.minimum)
                    };
                    if (isTinnedGood(min.name, aliasLookup)) {
                        const tinSize = tinSizeFor(min.name, aliasLookup).quantity;
                        result.minimumTins = roundTo2(result.minimum / tinSize);
                        result.haveTins = roundTo2(result.have / tinSize);
                    }
                    return result;
                });

                callback(null, results);
            });
        });
    });
}

// =============================================================
// BARCODES - scanning a product with the phone camera
// =============================================================
// The Inventory page reads the barcode with the camera, then asks the
// server what the product is:
// 1. First it checks barcodes.csv - every barcode you've added before
//    is remembered there, with the name YOU used for it. So the
//    second time you scan something it's instant, and it uses your
//    wording ("Tinned Tomatoes", not "Pams Chopped Tomatoes In Juice").
// 2. If it's not in there, it asks Open Food Facts - a free, public
//    database of food products. It's run by volunteers, so NZ-only
//    products (Pams etc.) are often missing - then you just type
//    the name in once, and from then on it's remembered (step 1).
// -------------------------------------------------------------
// (UPDATE, phase 5: the barcodes table is now "products" - one row per
// real product, keyed by barcode - see database.js. A product can also
// be added by a price check, from a supermarket that sent its barcode:
// that one has the supermarket's name for it but no name of yours yet.)
const BARCODES_FILE = 'products';
const BARCODE_HEADERS = ['barcode', 'name', 'quantity', 'unit', 'location'];

// Open Food Facts asks every app to say who it is when it looks
// something up.
const OPEN_FOOD_FACTS_USER_AGENT = 'WhatFoodDoWeHave/1.0 (household pantry app)';

// Turns Open Food Facts' size text into an amount and unit for the
// form, e.g. "410 g" -> { quantity: 410, unit: 'g' }, "1.5 L" ->
// { quantity: 1.5, unit: 'l' }. Anything else (e.g. "6 x 30g") gives
// null and the boxes are just left for you to fill in.
// Anything AFTER the size is ignored - European products often
// have an "e" (the ℮ "estimated" mark) on the end, like "400 g e" -
// and a comma counts as a decimal point ("1,5 l" = 1.5 L).
function sizeFromOpenFoodFacts(sizeText) {
    const match = String(sizeText || '').trim().toLowerCase().replace(',', '.').match(/^(\d*\.?\d+)\s*(g|kg|ml|l)\b/);
    if (!match) return null;
    return { quantity: Number(match[1]), unit: match[2] };
}

// Looks a barcode up on Open Food Facts. Gives back
// { name, quantity, unit } or null if they don't have it.
async function lookUpOpenFoodFacts(barcode) {
    const response = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,quantity`,
        { headers: { 'User-Agent': OPEN_FOOD_FACTS_USER_AGENT }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== 1 || !data.product || !data.product.product_name) return null;

    // e.g. brands "Wattie's,Heinz" + name "Baked Beans" -> "Wattie's Baked Beans"
    // (unless the name already starts with the brand).
    const brand = String(data.product.brands || '').split(',')[0].trim();
    let name = data.product.product_name.trim();
    if (brand && !name.toLowerCase().startsWith(brand.toLowerCase())) name = `${brand} ${name}`;

    const size = sizeFromOpenFoodFacts(data.product.quantity);
    // (UPDATE, phase 2: brand and product_name are passed back too, so
    // they can be saved in the barcodes table - see rememberBarcode().)
    return { name, quantity: size ? size.quantity : '', unit: size ? size.unit : '', brand, product_name: name };
}

// -------------------------------------------------------------
// The brand and full product name Open Food Facts gave for each
// barcode looked up recently, kept until the barcode is saved (the
// page only sends back the name/amount/place you chose, so this is
// where rememberBarcode() finds them). Forgotten on restart, which
// only means a barcode saved after a restart has no brand yet.
// -------------------------------------------------------------
const recentBarcodeLookups = new Map();

// Remembers the name/amount/place you used for a barcode, so next
// time it's filled in straight away (see step 1 above).
// UPDATE, phase 2: also saves, for your own barcode database:
// - brand and product_name (the full name on the pack) - from Open
//   Food Facts if it knew the product, otherwise kept from before
// - source: 'openfoodfacts' (found there) or 'scanned' (you typed the
//   name in after scanning)
// - who first added it, and when
function rememberBarcode(details, person, callback) {
    readOptionalCsv(BARCODES_FILE, (err, barcodes) => {
        if (err) return callback(err);
        const before = barcodes.find(b => b.barcode === details.barcode) || {};
        const looked = recentBarcodeLookups.get(details.barcode) || {};
        recentBarcodeLookups.delete(details.barcode);

        const others = barcodes.filter(b => b.barcode !== details.barcode);
        others.push({
            ...details,
            brand: looked.brand || before.brand || '',
            product_name: looked.product_name || before.product_name || '',
            source: before.source || (looked.product_name ? 'openfoodfacts' : 'scanned'),
            added_by: before.added_by || person,
            date_added: before.date_added || nzDateAndTime().date
        });
        saveRows(BARCODES_FILE, others, callback);
    });
}

// Writes an amount for the log/undo message, e.g. 500 + "g" ->
// "500 g", 2 + "tin" -> "2 tins", 1 + "each" -> "1".
function describeAmount(quantity, unit) {
    if (unit === 'each' || !unit) return String(quantity);
    if (isTinUnit(unit)) return `${quantity} ${Number(quantity) === 1 ? 'tin' : 'tins'}`;
    return `${quantity} ${unit}`;
}

// =============================================================
// IMPORT A RECIPE FROM A LINK
// =============================================================
// Almost every recipe website hides a computer-readable copy of the
// recipe inside its page (it's what Google uses to show recipe cards
// in search results). It looks something like:
//   { "@type": "Recipe", "name": "Beef Tacos", "recipeYield": "4",
//     "recipeIngredient": ["500g beef mince", "1 onion, diced", ...],
//     "recipeInstructions": [{ "text": "Brown the mince." }, ...] }
// So instead of needing an AI to rewrite a recipe into our upload
// file layout, the server reads that hidden copy straight off the
// page, and turns each ingredient line ("1 large onion, diced") into
// our name / quantity / unit format. The Recipes page then fills in
// the Add a Recipe form with it, for you to check before saving.
// -------------------------------------------------------------

// How many grams ONE cup of common dry ingredients weighs, so a
// recipe saying "2 cups plain flour" can be compared with the flour
// in the pantry (which is in grams). Anything not listed here that's
// measured in cups is turned into millilitres instead (1 cup = 250 ml,
// the NZ/Australian metric cup). Matched on the WHOLE name, longest
// first, so "brown sugar" wins over "sugar".
const GRAMS_PER_CUP = [
    ['icing sugar', 125], ['brown sugar', 200], ['caster sugar', 220], ['sugar', 200],
    ['self raising flour', 150], ['self-raising flour', 150], ['flour', 150],
    ['rolled oats', 90], ['oats', 90], ['rice', 185], ['butter', 230],
    ['cocoa', 100], ['grated cheese', 100], ['cheese', 100], ['breadcrumbs', 60],
    ['coconut', 80], ['peas', 140], ['frozen peas', 140], ['corn', 160]
].sort((a, b) => b[0].length - a[0].length);

// Unicode fraction characters some sites use, turned into plain
// "1/2" style so they can be read like any other fraction.
const UNICODE_FRACTIONS = {
    '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
    '⅕': '1/5', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8'
};

// Every way a unit might be written -> what it means. The order
// matters a little: longer words are tried before shorter ones.
const UNIT_WORDS = [
    [/^(kilograms?|kilos?|kgs?)\b/i, 'kg'],
    [/^(grams?|grammes?|gms?|g)\b/i, 'g'],
    [/^(millilit(re|er)s?|mls?)\b/i, 'ml'],
    [/^(lit(re|er)s?|l)\b/i, 'l'],
    [/^(tablespoons?|tbsps?|tbs|tbl)\b/i, 'tbsp'],
    [/^(teaspoons?|tsps?)\b/i, 'tsp'],
    [/^(cups?|c)\b/i, 'cup'],
    [/^(ounces?|oz)\b/i, 'oz'],
    [/^(pounds?|lbs?)\b/i, 'lb'],
    [/^(cans?|tins?)\b/i, 'tin'],
    [/^(pinch(es)?|dash(es)?)\b/i, 'pinch'],
    [/^(cloves?)\b/i, 'clove']
];

// Size/how-to-prepare words at the START of a name that don't change
// what the ingredient IS ("2 large onions" -> "onions").
const NAME_DESCRIPTORS = /^((large|medium|small|heaped|level|packed|rounded|generous|good|big|extra|about|approx\.?|of)\s+)+/i;

// Turns "1 1/2", "1/2", "1.5" or "1,5" into a number.
function readAmount(text) {
    const parts = text.trim().split(/\s+/);
    return parts.reduce((total, part) => {
        if (part.includes('/')) {
            const [top, bottom] = part.split('/').map(Number);
            return total + (bottom ? top / bottom : 0);
        }
        return total + Number(part.replace(',', '.'));
    }, 0);
}

// Takes HTML tags and codes like &amp; out of a bit of text from a
// web page, leaving just the plain words.
function plainText(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#039;|&apos;|&rsquo;|&lsquo;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, ' ')
        .trim();
}

// -------------------------------------------------------------
// Turns ONE ingredient line from a website into our format, e.g.
//   "500g beef mince"                 -> Beef mince, 500, g
//   "1 large onion, finely chopped"   -> Onion, 1, each
//   "2 x 400g cans chopped tomatoes"  -> Chopped tomatoes, 2, tin
//   "1 1/2 cups plain flour"          -> Plain flour, 225, g
//   "2 tbsp olive oil"                -> Olive oil, 2, tbsp
//   "Salt and pepper, to taste"       -> Salt and pepper, 1, tsp
// It won't be perfect for every website's wording - which is why it
// only fills in the form, for you to check before saving.
// -------------------------------------------------------------
function parseIngredientLine(line) {
    let text = plainText(line);
    Object.entries(UNICODE_FRACTIONS).forEach(([symbol, fraction]) => {
        text = text.replace(new RegExp(`(\\d)?${symbol}`, 'g'), (match, digit) => (digit ? `${digit} ` : ' ') + fraction);
    });
    text = text.trim();

    // ---- The amount at the start, e.g. "1 1/2", "2", "2-3" ----
    // (for a range like "2-3", the first number is used)
    let quantity = null;
    const amountMatch = text.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(\s*(?:-|–|to)\s*(\d+\/\d+|\d+(?:[.,]\d+)?))?\s*/);
    if (amountMatch) {
        quantity = readAmount(amountMatch[1]);
        text = text.slice(amountMatch[0].length);
    }

    // ---- "2 x 400g cans ..." or "1 (400g) tin ..." -> 2 tins ----
    const tinPattern = /^(x\s*)?\(?\s*\d+(?:\.\d+)?\s*(g|ml|oz)\s*\)?\s*(cans?|tins?)\b\s*/i;
    if (tinPattern.test(text)) {
        text = text.replace(tinPattern, '');
        return finishIngredient(text, quantity || 1, 'tin');
    }
    text = text.replace(/^x\s+/i, '');   // "2 x eggs" -> "eggs"

    // ---- The unit, e.g. "g", "cups", "tbsp" ----
    let unit = null;
    for (const [pattern, unitName] of UNIT_WORDS) {
        const match = text.match(pattern);
        // (The \b in each pattern means the unit has to be a whole
        // word - so "1 lemon" isn't read as 1 litre of "emon"!)
        if (match) {
            unit = unitName;
            text = text.slice(match[0].length).replace(/^\.?\s*/, '');
            break;
        }
    }

    // "400g can chopped tomatoes" (a size, then the word can/tin) = 1 tin
    if ((unit === 'g' || unit === 'ml') && /^(cans?|tins?)\b/i.test(text)) {
        text = text.replace(/^(cans?|tins?)\b\s*/i, '');
        return finishIngredient(text, 1, 'tin');
    }

    if (quantity === null) {
        // No amount at all ("Salt, to taste", "Fresh coriander to
        // serve") - saved as a teaspoon, which the app treats as
        // "just check there's SOME in the house".
        return finishIngredient(text, unit === 'pinch' ? 0.25 : 1, 'tsp');
    }

    // ---- Convert units we don't use into ones we do ----
    switch (unit) {
        case 'oz':    return finishIngredient(text, Math.round(quantity * 28.35), 'g');
        case 'lb':    return finishIngredient(text, Math.round(quantity * 453.6), 'g');
        case 'pinch': return finishIngredient(text, 0.25 * quantity, 'tsp');
        case 'clove': return finishIngredient(`${cleanIngredientName(text)} cloves`, quantity, 'each');
        case 'cup': {
            // Dry goods by weight, everything else (milk, stock...) by volume.
            const name = cleanIngredientName(text).toLowerCase();
            const dry = GRAMS_PER_CUP.find(([key]) => name.includes(key));
            return dry
                ? finishIngredient(text, Math.round(quantity * dry[1]), 'g')
                : finishIngredient(text, Math.round(quantity * 250), 'ml');
        }
        case null:    return finishIngredient(text, quantity, 'each');
        default:      return finishIngredient(text, quantity, unit);
    }
}

// Tidies up the name part of an ingredient line: drops anything after
// a comma ("onion, finely chopped" -> "onion"), anything in brackets,
// and size words at the start ("large onions" -> "onions").
function cleanIngredientName(text) {
    // Brackets first - over and over, as some sites put brackets
    // inside brackets: "(, or all purpose soy (Note 3))".
    let withoutBrackets = text;
    while (/\([^()]*\)/.test(withoutBrackets)) {
        withoutBrackets = withoutBrackets.replace(/\([^()]*\)/g, ' ');
    }
    let name = withoutBrackets
        .replace(/[()]/g, ' ')          // any stray bracket left over
        .split(',')[0]                  // ", finely chopped"
        .split(' / ')[0]                // "cornflour / corn starch" -> "cornflour"
        .replace(/\s+plus\s.*$/i, '')   // "oil plus a little extra for frying"
        .replace(/\s+(to serve|to taste|for serving|for garnish|optional)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    name = name.replace(NAME_DESCRIPTORS, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function finishIngredient(text, quantity, unit) {
    return {
        ingredient_name: cleanIngredientName(text),
        quantity: Math.round(quantity * 100) / 100,
        unit
    };
}

// Finds the Recipe inside a page's hidden data. Sites wrap it in
// different ways - on its own, in a list, or inside a "@graph" with
// other things about the page - so this looks through all of them.
function findRecipeData(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data)) {
        for (const item of data) {
            const found = findRecipeData(item);
            if (found) return found;
        }
        return null;
    }
    const type = data['@type'];
    if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return data;
    if (data['@graph']) return findRecipeData(data['@graph']);
    if (data.mainEntity) return findRecipeData(data.mainEntity);
    return null;
}

// Turns the recipe's steps into lines of text. They can be one big
// block of text, a list of steps, or a list of SECTIONS that each
// have their own list of steps ("For the sauce: ...").
function instructionLines(instructions) {
    if (!instructions) return [];
    if (typeof instructions === 'string') {
        return plainText(instructions.replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n')).split(/\n+/);
    }
    if (Array.isArray(instructions)) {
        return instructions.flatMap(instructionLines);
    }
    if (instructions.itemListElement) {
        const heading = instructions.name ? [`${plainText(instructions.name)}:`] : [];
        return heading.concat(instructionLines(instructions.itemListElement));
    }
    return [plainText(instructions.text || instructions.name || '')];
}

// "4", "4 servings", "Serves 4-6", ["4", "4 serves"] -> 4
function servingsFromYield(recipeYield) {
    const text = Array.isArray(recipeYield) ? recipeYield.join(' ') : String(recipeYield || '');
    const match = text.match(/\d+/);
    return match ? Number(match[0]) : '';
}

// Pulls the recipe out of a page's HTML, or gives back null if the
// page doesn't have one hidden in it.
function recipeFromHtml(html) {
    const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, json] of scripts) {
        let data;
        try {
            data = JSON.parse(json);
        } catch (err) {
            // Some sites leave raw line breaks inside their text, which
            // isn't strictly allowed - try once more without them.
            try { data = JSON.parse(json.replace(/[\r\n\t]+/g, ' ')); } catch (err2) { continue; }
        }
        const recipe = findRecipeData(data);
        if (!recipe) continue;

        return {
            name: plainText(recipe.name),
            servings: servingsFromYield(recipe.recipeYield),
            ingredients: (recipe.recipeIngredient || recipe.ingredients || []).map(line => ({
                ...parseIngredientLine(line),
                original: plainText(line)   // shown under each row, so you can check it was read right
            })),
            instructions: instructionLines(recipe.recipeInstructions)
                .map(line => line.trim())
                .filter(Boolean)
                .join('\n')
        };
    }
    return null;
}

// Only real websites can be imported from - never this server itself
// or anything else on the home network (a link like
// http://192.168.1.1 would otherwise get the garage to go poking
// around inside your own network).
function isAllowedRecipeLink(link) {
    let url;
    try { url = new URL(link); } catch (err) { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return !(host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') ||
        /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host.startsWith('[') || /^\d+$/.test(host));
}

// Gets the recipe from a link. Tries a plain, quick download of the
// page first. Some sites block that (they only let real browsers in),
// so if no recipe turns up, it opens the page in a real browser - the
// same way the price scrapers do - and tries again.
async function importRecipeFromLink(link) {
    try {
        const response = await fetch(link, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-NZ,en;q=0.9'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        if (response.ok) {
            const recipe = recipeFromHtml(await response.text());
            if (recipe) return recipe;
        }
    } catch (err) {
        console.error('Quick recipe download failed, trying a real browser:', err.message);
    }

    const browser = await chromium.launch({ headless: false });
    try {
        const page = await browser.newPage();
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // A moment for any "checking your browser" screen to finish.
        await page.waitForTimeout(3000);
        return recipeFromHtml(await page.content());
    } finally {
        await browser.close();
    }
}

// =============================================================
// MEAL PLANNER
// =============================================================
// One shared plan for the week, saved in meal_plan.csv - one row per
// recipe planned, with the day and how many people it's for, e.g.
//   monday, 1786093115133, 2
// The Meal Planner page saves the WHOLE plan each time it changes.
// -------------------------------------------------------------
const MEAL_PLAN_FILE = 'meal_plan.csv';
const MEAL_PLAN_HEADERS = ['day', 'recipe_id', 'people'];

// Takes an amount from a recipe and turns it into the base unit the
// house stock is counted in (g / ml / each), same as "I made this"
// does - tins become their weight using the tin size table.
function toStockUnit(quantity, unit, name, aliasLookup) {
    if (isWeightUnit(unit)) return { quantity: toGrams(quantity, unit), unit: 'g' };
    if (isVolumeUnit(unit)) return { quantity: toMilliliters(quantity, unit), unit: 'ml' };
    if (isTinUnit(unit)) {
        const tin = tinSizeFor(name, aliasLookup);
        return { quantity: quantity * tin.quantity, unit: tin.unit };
    }
    return { quantity, unit };
}

// -------------------------------------------------------------
// Works out the combined shopping list for the whole week's plan:
// 1. every planned recipe's ingredients, scaled to how many people
//    it's for (e.g. a recipe for 2, planned for 3 = 1.5 x the amounts)
// 2. the same ingredient across different recipes is added together
//    (matched the same way "I made this" matches names - aliases too)
// 3. whatever's already in the house is taken off
// Gives back one entry per ingredient, with how much is needed in
// total, how much is in the house, and how much to buy (0 = got enough).
// -------------------------------------------------------------
function buildShoppingList(plan, recipes, inventory, aliasLookup) {
    const recipesById = new Map(recipes.map(r => [r.id, r]));
    const needed = new Map();

    plan.forEach(entry => {
        const recipe = recipesById.get(entry.recipe_id);
        if (!recipe) return;
        const scale = (Number(entry.people) || DEFAULT_SERVINGS) / (Number(recipe.servings) || DEFAULT_SERVINGS);

        recipe.ingredients.forEach(ing => {
            const key = canonicalKey(ing.ingredient_name, aliasLookup);

            // tsp/tbsp: just need SOME in the house, not an amount.
            if (SPOON_UNITS.includes(ing.unit)) {
                const spoonKey = key + '|spoon';
                if (!needed.has(spoonKey)) needed.set(spoonKey, { name: ing.ingredient_name, key, unit: 'spoon', quantity: 0, recipes: new Set() });
                needed.get(spoonKey).recipes.add(recipe.name);
                return;
            }

            const amount = toStockUnit(Number(ing.quantity) * scale, ing.unit, ing.ingredient_name, aliasLookup);
            const mapKey = key + '|' + amount.unit;
            if (!needed.has(mapKey)) {
                needed.set(mapKey, { name: ing.ingredient_name, key, unit: amount.unit, quantity: 0, recipes: new Set(), inTins: false });
            }
            const item = needed.get(mapKey);
            item.quantity += amount.quantity;
            item.recipes.add(recipe.name);
            if (isTinUnit(ing.unit)) item.inTins = true;
        });
    });

    return [...needed.values()].map(item => {
        const matching = inventory.filter(stock => canonicalKey(stock.name, aliasLookup) === item.key);

        if (item.unit === 'spoon') {
            const haveSome = matching.some(stock => Number(stock.quantity) > 0);
            return { name: item.name, unit: 'spoon', needed: 0, have: haveSome ? 1 : 0, toBuy: haveSome ? 0 : 1, recipes: [...item.recipes] };
        }

        // A "have it" item in the house (sauces etc.) always counts as
        // enough - its amount isn't tracked. (If it's running low, it
        // gets added to the list separately - see the route.)
        if (matching.some(stock => stock.haveIt && Number(stock.quantity) > 0)) {
            return { name: item.name, unit: item.unit, needed: roundTo2(item.quantity), have: roundTo2(item.quantity), toBuy: 0, recipes: [...item.recipes] };
        }

        const have = matching
            .filter(stock => stock.unit === item.unit)
            .reduce((total, stock) => total + Number(stock.quantity), 0);
        let toBuy = Math.max(0, item.quantity - have);
        // You can't buy half an onion - round "each" up to whole ones.
        if (item.unit === 'each') toBuy = Math.ceil(toBuy - 0.001);

        const result = {
            name: item.name,
            unit: item.unit,
            needed: roundTo2(item.quantity),
            have: roundTo2(have),
            toBuy: roundTo2(toBuy),
            recipes: [...item.recipes]
        };
        // Tinned goods also say how many TINS to buy (rounded up).
        if (item.inTins || isTinnedGood(item.name, aliasLookup)) {
            result.tinsToBuy = Math.ceil(toBuy / tinSizeFor(item.name, aliasLookup).quantity - 0.001);
        }
        return result;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

// -------------------------------------------------------------
// "Where does this usually go?" - the starting choice in the
// shopping list's "Add to" dropdown, for when it's bought:
// 1. wherever it's ALREADY kept in the house (the place with the
//    most of it, if it's in more than one) - matched the same way
//    "I made this" matches names, so aliases count too
// 2. otherwise a guess from its name - anything "frozen" goes in
//    the freezer, meat/dairy/fresh things in the fridge, and
//    everything else in the pantry
// It's only a starting point - the dropdown can be changed.
// -------------------------------------------------------------
const FRIDGE_WORDS = /\b(milk|cream|butter|cheese|yoghurt|yogurt|eggs?|mince|chicken|beef|steak|pork|lamb|bacon|ham|sausages?|salami|fish|salmon|prawns?|tofu|lettuce|spinach|rocket|herbs?|coriander|parsley|basil|mint|celery|cucumber|capsicum|courgette|zucchini|mushrooms?|broccoli|cauliflower|berries|strawberries|grapes|hummus|pesto|sour cream|mayonnaise|juice)\b/i;

function guessStorageLocation(name, itemsBySection, aliasLookup) {
    const key = canonicalKey(name, aliasLookup);
    let bestSection = null;
    let bestAmount = 0;
    Object.keys(csvFiles).forEach(section => {
        const amount = itemsBySection[section]
            .filter(item => canonicalKey(item.name, aliasLookup) === key)
            .reduce((total, item) => total + (Number(item.quantity) || 0), 0);
        if (amount > bestAmount) {
            bestAmount = amount;
            bestSection = section;
        }
    });
    if (bestSection) return bestSection;

    if (/\bfrozen\b/i.test(name)) return 'freezer';
    if (FRIDGE_WORDS.test(name)) return 'fridge';
    return 'pantry';
}

// =============================================================
// WATCH LIST - prices checked automatically every morning
// =============================================================
// Star a product on the Price Checker page and it goes into
// watch_list.csv. Every morning (from WATCH_CHECK_HOUR, NZ time) the
// server searches each watched product's store for it again, all by
// itself, and saves today's price into prices.csv - exactly as if
// you'd clicked Save. Over time that builds up the price history for
// the graphs and the "price drop" badges.
//
// The check runs inside the server, so nothing extra needs setting
// up on the garage. When it last ran is kept in
// watch_check_status.json (in .gitignore), so it only runs once a
// day even though the server restarts every hour.
// -------------------------------------------------------------
const WATCH_LIST_FILE = 'watch_list.csv';
const WATCH_LIST_HEADERS = ['id', 'item_name', 'store', 'package_size', 'search_term', 'added_by', 'date_added'];
const WATCH_STATUS_FILE = 'watch_check_status.json';

// The daily check starts from 7am NZ time (at the next 15-minute
// check after that).
const WATCH_CHECK_HOUR = 7;

// True while a check is running, so two can never run at once.
let watchCheckRunning = false;

function readWatchStatus() {
    try {
        return JSON.parse(fs.readFileSync(WATCH_STATUS_FILE, 'utf8'));
    } catch (err) {
        return {};   // never run yet
    }
}

// Runs a function in the same one-at-a-time queue as every saved
// change (see runOneAtATime), for changes that DON'T come from the
// browser - like the morning check saving prices. task(done) must
// call done() once it's finished.
function runInWriteQueue(task) {
    writeQueue = writeQueue.then(() => new Promise(resolve => {
        try {
            task(resolve);
        } catch (err) {
            console.error('Unexpected error while saving:', err);
            resolve();
        }
    }));
}

// Is this saved price for this watched product? Matched on the store
// and the supermarket's own product name (and the size, if both have
// one), so a different product with a similar name never gets mixed in.
function priceIsForWatchedItem(price, watched) {
    const name = (price.original_name || price.item_name || '').toLowerCase();
    if (price.store !== watched.store || name !== watched.item_name.toLowerCase()) return false;
    return !price.package_size || !watched.package_size || price.package_size === watched.package_size;
}

// -------------------------------------------------------------
// Adds each watched product's price history (one price per day - the
// last one saved that day), plus:
// - priceDrop: today's price is lower than the last time it was checked
// - lowestSeen: it's the cheapest it's been (after at least 3 checks)
// -------------------------------------------------------------
function addWatchHistory(watchList, prices) {
    return watchList.map(watched => {
        const byDay = new Map();
        prices
            .filter(p => priceIsForWatchedItem(p, watched) && p.price !== '')
            .sort((a, b) => new Date(a.date_checked) - new Date(b.date_checked))
            .forEach(p => byDay.set(p.date_checked.slice(0, 10), { date: p.date_checked, price: Number(p.price) }));
        const history = [...byDay.values()];

        const latest = history[history.length - 1] || null;
        const previous = history[history.length - 2] || null;
        const earlierLowest = history.length > 1 ? Math.min(...history.slice(0, -1).map(h => h.price)) : null;

        return {
            ...watched,
            history,
            latest,
            previous,
            priceDrop: Boolean(latest && previous && latest.price < previous.price),
            lowestSeen: Boolean(latest && history.length >= 3 && latest.price < earlierLowest)
        };
    });
}

// -------------------------------------------------------------
// The morning check itself. Goes through the watch list ONE product
// at a time (so the garage isn't running lots of browsers at once),
// searches that product's store, finds the exact same product in the
// results, and saves its price. Anything that can't be found today
// (out of stock, renamed, store site down) is just skipped and noted
// in the status file - it'll be tried again tomorrow.
// -------------------------------------------------------------
function runWatchListCheck() {
    if (watchCheckRunning) return;
    watchCheckRunning = true;
    const { date } = nzDateAndTime();
    console.log('Watch list check starting...');

    readOptionalCsv(WATCH_LIST_FILE, async (err, watchList) => {
        const results = {};
        const newPrices = [];

        if (!err) {
            for (const watched of watchList) {
                try {
                    const found = await searchOneStore(watched.search_term || watched.item_name, watched.store);
                    const match = found.find(r =>
                        (r.name || '').toLowerCase() === watched.item_name.toLowerCase() &&
                        (!watched.package_size || !r.packageSize || r.packageSize === watched.package_size)
                    );
                    if (!match) {
                        results[watched.id] = 'not found';
                        continue;
                    }
                    results[watched.id] = 'found';
                    newPrices.push({
                        // Same layout as the Save button's prices (see the
                        // POST /prices route), with a unique id each.
                        id: (Date.now() + newPrices.length).toString(),
                        item_name: savedPriceName(match.name, match.store),
                        price: match.price,
                        cup_price: match.cupPrice,
                        cup_measure: match.cupMeasure,
                        package_size: match.packageSize,
                        store: match.store,
                        date_checked: new Date().toISOString(),
                        original_name: match.name,
                        // (UPDATE, phase 5) product code, barcode, brand
                        ...productFieldsFrom(match)
                    });
                } catch (searchErr) {
                    console.error(`Watch list: couldn't check ${watched.item_name} at ${watched.store}:`, searchErr.message);
                    results[watched.id] = 'failed';
                }
            }
        }

        // Save all of today's prices in one go, then note that today's
        // check is done.
        // (UPDATE: through appendPrices(), so with the database switched
        // on they're just INSERTed rather than re-saving the whole history.)
        runInWriteQueue(done => {
            const finish = () => {
                writeFileSafely(WATCH_STATUS_FILE, JSON.stringify({ date, finishedAt: new Date().toISOString(), results }, null, 2), () => {
                    watchCheckRunning = false;
                    console.log(`Watch list check finished - ${newPrices.length} price(s) saved.`);
                    done();
                });
            };
            appendPrices(newPrices, saveErr => {
                if (saveErr) console.error('Watch list: could not save prices:', saveErr);
                finish();
            });
        });
    });
}

// Every 15 minutes: if it's past WATCH_CHECK_HOUR and today's check
// hasn't been done yet, start it.
function maybeRunDailyWatchCheck() {
    const { date, time } = nzDateAndTime();
    if (Number(time.slice(0, 2)) < WATCH_CHECK_HOUR) return;
    if (readWatchStatus().date === date) return;
    runWatchListCheck();
}
setInterval(maybeRunDailyWatchCheck, 15 * 60 * 1000);
// Also once, a minute after the server starts, in case it was off
// (or restarting) at the time.
setTimeout(maybeRunDailyWatchCheck, 60 * 1000);

const server = http.createServer((req, res) => {

    // Parsed once here so any route below can read query string
    // values (e.g. ?item=mince) via parsedUrl.searchParams, on top
    // of the existing plain req.url string matching other routes
    // already use.
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

    // Let the browser talk to this server from a file:// page.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Browsers sometimes send a quick permission check ("OPTIONS")
    // before the real request - just say "yes, go ahead."
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ---- LOGIN: check a username/password, remember this browser ----
    // The only route that works WITHOUT being logged in already.
    if (parsedUrl.pathname === '/login' && req.method === 'POST') {
        readJsonBody(req, res, async ({ username, password }) => {
            // (UPDATE, phase 2: who can log in comes from the people table.)
            let members;
            try {
                members = await readPeople();
            } catch (err) {
                return sendText(res, 500, 'Could not check the login - the database did not answer. Try again in a moment.');
            }
            const person = checkLogin(username, password, members);
            if (!person) return sendText(res, 401, 'Wrong username or password');

            // A long random code that's practically impossible to guess.
            const code = crypto.randomBytes(32).toString('hex');
            sessions[code] = { person, created: new Date().toISOString() };
            saveSessions();

            // HttpOnly = the page's own JavaScript can't read the cookie
            // (only the browser sends it back), SameSite=Lax = other
            // websites can't make your browser use it behind your back.
            res.setHeader('Set-Cookie',
                `${SESSION_COOKIE}=${code}; Path=/; Max-Age=${SESSION_LENGTH_SECONDS}; HttpOnly; SameSite=Lax`);
            sendJson(res, { person });
        });
        return;
    }

    // ---- EVERYTHING ELSE needs a logged-in browser ----
    // No valid session cookie = a 401 ("not logged in") reply, and
    // auth.js on the page sends the browser to login.html.
    const loggedInAs = loggedInPerson(req);
    if (!loggedInAs) {
        sendText(res, 401, 'Not logged in');
        return;
    }

    // ---- Who's logged in on this browser (used by auth.js) ----
    if (parsedUrl.pathname === '/whoami' && req.method === 'GET') {
        sendJson(res, { person: loggedInAs });
        return;
    }

    // ---- Combined store list for the dropdown - one list on the ----
    // ---- page, even though Woolworths and Pak'nSave are handled ----
    // ---- completely separately behind the scenes. ----
    // (UPDATE, phase 2: the list comes from the stores table - every
    // active store, preferred ones first - see loadStores().)
    if (parsedUrl.pathname === '/stores' && req.method === 'GET') {
        loadStores().then(stores => {
            const allStoreNames = [
                // "Our 3 stores" goes FIRST, so it's what's picked by
                // default when the page opens - see MAIN_STORES.
                MAIN_STORES_OPTION,
                ...stores.map(store => store.store_name)
            ];
            sendJson(res, allStoreNames);
        }, () => sendText(res, 500, 'Could not read the store list'));
        return;
    }

    // ---- PRICE CHECKER: live search, routed to whichever ----
    // ---- retailer the chosen store actually belongs to ----
    // Has to be checked BEFORE the pantry/fridge/freezer/chest
    // routing below, same reasoning as the recipes routes.
    if (parsedUrl.pathname === '/price-search' && req.method === 'GET') {
        const searchTerm = parsedUrl.searchParams.get('item');
        const storeName = parsedUrl.searchParams.get('store');

        if (!searchTerm) {
            sendText(res, 400, 'Missing ?item= search term');
            return;
        }

        // "Our 3 stores" picked in the dropdown - search ALL of them at
        // the same time and send back one combined list. If one store
        // fails (slow, changed site...), the other two still come back,
        // and failedStores tells the page which one didn't.
        // Single-store searches below are unchanged - they still reply
        // with a plain list, so nothing else needs to know about this.
        // (UPDATE, phase 2: the store list is read from the database
        // first, so MAIN_STORES_OPTION is filled in - see loadStores().)
        loadStores().then(() => {
            if (storeName === MAIN_STORES_OPTION) {
                Promise.allSettled(MAIN_STORES.map(store => searchOneStore(searchTerm, store)))
                    .then(outcomes => {
                        const results = [];
                        const failedStores = [];
                        outcomes.forEach((outcome, index) => {
                            if (outcome.status === 'fulfilled') {
                                results.push(...outcome.value);
                            } else {
                                console.error(`Price search failed for ${MAIN_STORES[index]}:`, outcome.reason);
                                failedStores.push(MAIN_STORES[index]);
                            }
                        });
                        sendJson(res, { combined: true, results, failedStores });
                    });
                return;
            }

            searchOneStore(searchTerm, storeName)
                .then(results => sendJson(res, results))
                .catch(err => {
                    console.error('Price search failed:', err);
                    sendText(res, 500, `Could not complete the price search - ${storeName || 'the store'} may be slow to respond, or their site has changed. Try again in a moment.`);
                });
        }, () => sendText(res, 500, 'Could not read the store list'));
        return;
    }

    // ---- Every price ever saved, for the history list on the page ----
    if (parsedUrl.pathname === '/prices' && req.method === 'GET') {
        readPrices((err, prices) => {
            if (err) return sendText(res, 500, 'Could not read price history');
            sendJson(res, prices);
        });
        return;
    }

    // ---- Save ONE specific search result into the price history ----
    if (parsedUrl.pathname === '/prices' && req.method === 'POST') {
        readJsonBody(req, res, newPrice => runOneAtATime(res, () => {
            // (UPDATE: no need to read the whole history first any more -
            // appendPrices() below does whatever's needed to add one row.)
            // Every save is a NEW row - we're keeping full
            // history, not overwriting a previous check of the
            // same item.
            // (UPDATE, phase 2: no id any more - a saved price is known
            // by its store, name and the exact time it was saved.)
            const entry = {
                // Pack size taken off the name, so it lines up across
                // stores - see savedPriceName() near the top of this
                // file. (UPDATE, phase 5: home brands aren't renamed
                // any more.)
                item_name: savedPriceName(newPrice.item_name, newPrice.store),
                price: newPrice.price,
                cup_price: newPrice.cup_price,
                cup_measure: newPrice.cup_measure,
                package_size: newPrice.package_size,
                store: newPrice.store,
                date_checked: new Date().toISOString(),
                // The name exactly as the supermarket wrote it, pack
                // size and all.
                original_name: newPrice.item_name,
                // (UPDATE, phase 5) product code, barcode, brand - the
                // page passes them on from the search result.
                ...productFieldsFrom(newPrice)
            };

            appendPrices([entry], (err) => {
                if (err) return sendText(res, 500, 'Could not save price history');
                sendJson(res, entry);
            });
        }));
        return;
    }

    // ---- RECIPES: separate logic since it's two linked files, not one ----
    // This has to be checked BEFORE the pantry/fridge/freezer/chest
    // routing below, since "recipes" isn't in csvFiles and would
    // otherwise get rejected as an unknown section.
    if (req.url === '/recipes' && req.method === 'GET') {
        readRecipes((err, recipes) => {
            if (err) {
                console.error('Error reading recipes:', err);
                return sendText(res, 500, 'Could not read recipes');
            }
            sendJson(res, recipes);
        });
        return;
    }

    if (req.url === '/recipes' && req.method === 'POST') {
        readJsonBody(req, res, newRecipe => runOneAtATime(res, () => {
            // Generate a simple unique ID using the current timestamp.
            // This avoids needing to track "the last ID used" ourselves.
            const newId = Date.now().toString();

            readRecipeFilesForEditing(res, (recipes, ingredients) => {
                recipes.push({
                    id: newId,
                    name: newRecipe.name,
                    instructions: newRecipe.instructions,
                    servings: newRecipe.servings || ''
                });

                // Add one row per ingredient, all linked to this recipe's id
                newRecipe.ingredients.forEach(ing => {
                    ingredients.push({
                        recipe_id: newId,
                        ingredient_name: ing.name,
                        quantity: ing.quantity,
                        unit: ing.unit
                    });
                });

                logActivity(loggedInAs, [{ action: 'Added recipe', item: newRecipe.name }]);
                saveRecipeFiles(res, recipes, ingredients, { id: newId, ...newRecipe });
            });
        }));
        return;
    }

    // ---- PUT: update an existing recipe by id ----
    // Same idea as POST (create), but instead of adding a new row,
    // we replace the existing recipe's data and completely swap out
    // its ingredient rows for the new set.
    if (req.url.startsWith('/recipes/') && req.method === 'PUT') {
        const recipeId = req.url.replace('/recipes/', '');

        readJsonBody(req, res, updatedRecipe => runOneAtATime(res, () => {
            readRecipeFilesForEditing(res, (recipes, ingredients) => {
                // Find the recipe being edited and update its fields
                // in place, keeping the same id.
                const recipe = recipes.find(r => r.id === recipeId);
                if (!recipe) return sendText(res, 404, 'Recipe not found');

                recipe.name = updatedRecipe.name;
                recipe.instructions = updatedRecipe.instructions;
                recipe.servings = updatedRecipe.servings || '';

                // Remove this recipe's OLD ingredient rows, then add
                // the new set. It's simpler and safer than trying to
                // match old ingredients to new ones one-by-one.
                const otherIngredients = ingredients.filter(ing => ing.recipe_id !== recipeId);

                updatedRecipe.ingredients.forEach(ing => {
                    otherIngredients.push({
                        recipe_id: recipeId,
                        ingredient_name: ing.name,
                        quantity: ing.quantity,
                        unit: ing.unit
                    });
                });

                logActivity(loggedInAs, [{ action: 'Edited recipe', item: updatedRecipe.name }]);
                saveRecipeFiles(res, recipes, otherIngredients, { id: recipeId, ...updatedRecipe });
            });
        }));
        return;
    }

    // ---- DELETE a single recipe by id ----
    // URL looks like /recipes/1234567890 - we need to pull the id
    // out of the end of the URL.
    if (req.url.startsWith('/recipes/') && req.method === 'DELETE') {
        const recipeId = req.url.replace('/recipes/', '');

        runOneAtATime(res, () => {
            readRecipeFilesForEditing(res, (recipes, ingredients) => {
                // Keep every recipe EXCEPT the one being deleted
                const remainingRecipes = recipes.filter(r => r.id !== recipeId);

                // Also remove any ingredient rows that belonged to
                // this recipe, otherwise they'd be orphaned - pointing
                // to a recipe_id that no longer exists anywhere.
                const remainingIngredients = ingredients.filter(ing => ing.recipe_id !== recipeId);

                const deletedRecipe = recipes.find(r => r.id === recipeId);
                logActivity(loggedInAs, [{ action: 'Deleted recipe', item: deletedRecipe ? deletedRecipe.name : recipeId }]);
                saveRecipeFiles(res, remainingRecipes, remainingIngredients, { deleted: recipeId });
            });
        });
        return;
    }


    // ---- List the household members who can vote ----
    if (req.url === '/household-members' && req.method === 'GET') {
        // (UPDATE, phase 2: from the people table - see readPeople().)
        readPeople().then(members => sendJson(res, members),
            () => sendText(res, 500, 'Could not read the household members'));
        return;
    }

    // ---- Cast (or change) a vote on a recipe ----
    // URL looks like /recipes/1234567890/votes
    if (req.url.match(/^\/recipes\/[^/]+\/votes$/) && req.method === 'POST') {
        const recipeId = req.url.split('/')[2];

        readJsonBody(req, res, voteBody => runOneAtATime(res, () => {
            const { person, vote } = voteBody;

            // (UPDATE: readRows/saveRows, so it's the recipe_votes table
            // instead when the database is switched on.)
            readRows(RECIPE_VOTES_FILE, (err, votes) => {
                if (err) return sendText(res, 500, 'Could not read recipe votes');

                // If this person already voted on this recipe, update
                // their existing vote rather than adding a duplicate row.
                const existingVote = votes.find(v => v.recipe_id === recipeId && v.person === person);

                if (existingVote) {
                    existingVote.vote = vote;
                } else {
                    votes.push({ recipe_id: recipeId, person, vote });
                }

                saveRows(RECIPE_VOTES_FILE, votes, (err) => {
                    if (err) return sendText(res, 500, 'Could not save recipe votes');
                    sendJson(res, { recipe_id: recipeId, person, vote });
                });
            });
        }));
        return;
    }

    // ---- "I made this" - take a recipe's ingredients out of stock ----
    // URL looks like /recipes/1234567890/made
    // Send { confirm: false } to just PREVIEW what would be taken
    // (nothing is saved), then { confirm: true } to actually do it.
    // Both reply with the same plan - see planRecipeDeduction().
    // The confirm can also send its own "ingredients" list - the
    // amounts as edited in the pop-up (e.g. 6 eggs instead of 5) -
    // which is then used INSTEAD of the recipe's own amounts.
    if (req.url.match(/^\/recipes\/[^/]+\/made$/) && req.method === 'POST') {
        const recipeId = req.url.split('/')[2];

        readJsonBody(req, res, ({ confirm, ingredients }) => runOneAtATime(res, () => {
            readRecipes((err, recipes) => {
                if (err) return sendText(res, 500, 'Could not read recipes');

                const recipe = recipes.find(r => r.id === recipeId);
                if (!recipe) return sendText(res, 404, 'Recipe not found');

                readAllAliases((err, aliases) => {
                    if (err) return sendText(res, 500, 'Could not read ingredient aliases');

                    readEachSection((err, itemsBySection) => {
                        if (err) return sendText(res, 500, 'Could not read inventory');

                        // Edited amounts from the pop-up, if any were sent -
                        // otherwise just the recipe's own ingredient list.
                        const ingredientsToUse = Array.isArray(ingredients) ? ingredients : recipe.ingredients;

                        const { usedUpItems, ...plan } = planRecipeDeduction(
                            { ...recipe, ingredients: ingredientsToUse },
                            itemsBySection,
                            buildAliasLookup(aliases)
                        );

                        // Preview only - reply with the plan, save nothing.
                        if (!confirm) return sendJson(res, { recipe: recipe.name, ...plan, saved: false });

                        // Only re-save the storage areas something was
                        // actually taken from. Anything that's hit zero
                        // is removed, same as adding a negative amount
                        // on the Inventory page does.
                        const changedSections = new Set();
                        plan.deductions.forEach(d => d.taken.forEach(t => changedSections.add(t.section)));

                        // Copies of those areas BEFORE saving, so the whole
                        // "I made this" can be undone in one click.
                        const description = `Took out the ingredients for ${recipe.name}`;
                        rememberForUndo([...changedSections], loggedInAs, description, (err, undoId) => {
                            if (err) return sendText(res, 500, 'Could not read inventory');

                            const saves = [...changedSections].map(section => new Promise((resolve, reject) => {
                                const remaining = itemsBySection[section].filter(item => !usedUpItems.has(item));
                                saveItems(section, remaining, err => err ? reject(err) : resolve());
                            }));

                            Promise.all(saves).then(
                                () => {
                                    // One log line per item actually taken out.
                                    const logRows = [];
                                    plan.deductions.forEach(d => d.taken.forEach(t => logRows.push({
                                        action: 'Used (I made this)', item: t.item, quantity: roundTo2(t.quantity),
                                        unit: t.unit, location: SECTION_NAMES[t.section], details: recipe.name
                                    })));
                                    logActivity(loggedInAs, logRows);
                                    sendJson(res, { recipe: recipe.name, ...plan, saved: true, undoId, description });
                                },
                                () => sendText(res, 500, 'Could not save inventory')
                            );
                        });
                    });
                });
            });
        }));
        return;
    }

    // ---- Combined inventory across all four sections ----
    // Used by the Recipes page to check "do we have enough of
    // this ingredient anywhere in the house?"
    if (req.url === '/inventory-all' && req.method === 'GET') {
        readAllInventory((err, items) => {
            if (err) return sendText(res, 500, 'Could not read inventory');
            sendJson(res, items);
        });
        return;
    }

    // ---- All known item names (for dropdown/autocomplete suggestions) ----
    if (req.url === '/item-names' && req.method === 'GET') {
        getAllItemNames((err, names) => {
            if (err) return sendText(res, 500, 'Could not read item names');
            sendJson(res, names);
        });
        return;
    }

    // ---- Tin sizes, so the Recipes page can work out tins too ----
    // e.g. { defaultSize: {400 g}, goods: [{ key: "baked bean", quantity: 420, unit: "g" }, ...] }
    // (UPDATE, phase 3: from the ingredients table - every ingredient
    // with a tin size.)
    if (req.url === '/tinned-goods' && req.method === 'GET') {
        readAllAliases(err => {
            if (err) return sendText(res, 500, 'Could not read the ingredients list');
            sendJson(res, {
                defaultSize: DEFAULT_TIN_SIZE,
                goods: ingredientList
                    .filter(ingredient => ingredient.tin_quantity !== '')
                    .map(ingredient => ({
                        key: normalizeIngredientName(ingredient.ingredient_name),
                        quantity: Number(ingredient.tin_quantity),
                        unit: ingredient.tin_unit
                    }))
            });
        });
        return;
    }

    // ---- All known ingredient aliases ----
    // (yours AND the built-in ones - see readAllAliases)
    if (req.url === '/ingredient-aliases' && req.method === 'GET') {
        readAllAliases((err, aliases) => {
            if (err) return sendText(res, 500, 'Could not read ingredient aliases');
            sendJson(res, aliases);
        });
        return;
    }

    // ---- Add a new alias ----
    if (req.url === '/ingredient-aliases' && req.method === 'POST') {
        readJsonBody(req, res, ({ alias, canonical_name }) => runOneAtATime(res, () => {
            readAliases((err, aliases) => {
                if (err) return sendText(res, 500, 'Could not read ingredient aliases');

                // If this exact alias already exists, update which
                // canonical name it points to rather than adding a
                // duplicate row.
                const existing = aliases.find(a => a.alias.toLowerCase() === alias.toLowerCase());

                // (UPDATE, phase 3: either way it's now one of YOUR
                // aliases, even if it started as a built-in one.)
                if (existing) {
                    existing.canonical_name = canonical_name;
                    existing.source = 'yours';
                } else {
                    aliases.push({ alias, canonical_name, source: 'yours' });
                }

                saveAliases(aliases, (err) => {
                    if (err) return sendText(res, 500, 'Could not save ingredient aliases');
                    sendJson(res, { alias, canonical_name });
                });
            });
        }));
        return;
    }

    // ---- Import a recipe from a link (see IMPORT A RECIPE above) ----
    // e.g. /recipe-from-link?url=https://www.example.com/beef-tacos
    // Only reads the recipe - nothing is saved until you press Save
    // Recipe on the page.
    if (parsedUrl.pathname === '/recipe-from-link' && req.method === 'GET') {
        const link = String(parsedUrl.searchParams.get('url') || '').trim();
        if (!isAllowedRecipeLink(link)) return sendText(res, 400, "That doesn't look like a website link");

        importRecipeFromLink(link)
            .then(recipe => {
                if (!recipe) return sendText(res, 404, "Couldn't find a recipe on that page");
                sendJson(res, recipe);
            })
            .catch(err => {
                console.error('Recipe import failed:', err);
                sendText(res, 500, "Couldn't open that page");
            });
        return;
    }

    // ---- Meal planner: the saved plan for the week ----
    if (req.url === '/meal-plan' && req.method === 'GET') {
        readOptionalCsv(MEAL_PLAN_FILE, (err, plan) => {
            if (err) return sendText(res, 500, 'Could not read the meal plan');
            sendJson(res, plan);
        });
        return;
    }

    // ---- Meal planner: save the WHOLE plan (replaces the old one) ----
    // Body: { plan: [{ day: "monday", recipe_id: "123", people: 2 }, ...] }
    if (req.url === '/meal-plan' && req.method === 'POST') {
        readJsonBody(req, res, ({ plan }) => runOneAtATime(res, () => {
            const rows = (Array.isArray(plan) ? plan : []).map(entry => ({
                day: String(entry.day || ''),
                recipe_id: String(entry.recipe_id || ''),
                people: Number(entry.people) || DEFAULT_SERVINGS
            })).filter(entry => entry.day && entry.recipe_id);

            saveRows(MEAL_PLAN_FILE, rows, err => {
                if (err) return sendText(res, 500, 'Could not save the meal plan');
                sendJson(res, rows);
            });
        }));
        return;
    }

    // ---- Meal planner: the combined shopping list for the week ----
    // (see buildShoppingList above)
    if (req.url === '/meal-plan/shopping-list' && req.method === 'GET') {
        readOptionalCsv(MEAL_PLAN_FILE, (err, plan) => {
            if (err) return sendText(res, 500, 'Could not read the meal plan');
            readRecipes((err, recipes) => {
                if (err) return sendText(res, 500, 'Could not read recipes');
                readAllAliases((err, aliases) => {
                    if (err) return sendText(res, 500, 'Could not read ingredient aliases');
                    // Each storage area separately (to work out where each
                    // thing usually goes - see guessStorageLocation() above),
                    // AND all of them combined. (UPDATE: read once, then
                    // combined with mergeSections(), instead of reading
                    // all four files twice.)
                    readEachSection((err, itemsBySection) => {
                        if (err) return sendText(res, 500, 'Could not read inventory');
                        const inventory = mergeSections(itemsBySection);
                        const aliasLookup = buildAliasLookup(aliases);
                        const list = buildShoppingList(plan, recipes, inventory, aliasLookup)
                            .map(item => ({ ...item, location: guessStorageLocation(item.name, itemsBySection, aliasLookup) }));

                        // Anything marked as running low (the L button)
                        // goes on the list too, under "top up" - even if
                        // no recipe this week needs it. Its starting
                        // amount is one more of the same size it was
                        // logged as (e.g. another 570 g bottle).
                        Object.keys(csvFiles).forEach(section => {
                            itemsBySection[section].filter(stock => stock.low === 'yes').forEach(stock => {
                                const key = canonicalKey(stock.name, aliasLookup);
                                const already = list.find(entry => canonicalKey(entry.name, aliasLookup) === key && entry.toBuy > 0);
                                if (already) {
                                    already.runningLow = true;
                                    return;
                                }
                                list.push({
                                    name: stock.name, unit: stock.unit, needed: 0, have: 0, toBuy: 1,
                                    recipes: [], location: section, runningLow: true,
                                    topUpQuantity: Number(stock.quantity) || 1
                                });
                            });
                        });
                        sendJson(res, list);
                    });
                });
            });
        });
        return;
    }

    // ---- Meal planner: "Purchased" - add the ticked-off shopping ----
    // ---- list items to the inventory, all in one go ----
    // Body: { items: [{ name, quantity, unit, location }, ...] }
    // Each one is added the same way the Inventory page's Add Item does
    // (tins/kg/L turned into g/ml first). If that storage area already
    // has the same thing under a different name - e.g. the recipe says
    // "Beef mince" but the fridge has "Mince" - it's added to that one
    // instead of making a second, differently-named item.
    // It can all be undone in one click, and it goes in the activity log.
    if (req.url === '/meal-plan/purchased' && req.method === 'POST') {
        readJsonBody(req, res, ({ items }) => runOneAtATime(res, () => {
            const bought = (Array.isArray(items) ? items : []).filter(item =>
                item && item.name && csvFiles[item.location] && Number(item.quantity) > 0);
            if (bought.length === 0) return sendText(res, 400, 'Nothing ticked to add');

            readAllAliases((err, aliases) => {
                if (err) return sendText(res, 500, 'Could not read ingredient aliases');
                const aliasLookup = buildAliasLookup(aliases);

                readEachSection((err, itemsBySection) => {
                    if (err) return sendText(res, 500, 'Could not read inventory');

                    const changedSections = [...new Set(bought.map(item => item.location))];
                    const description = bought.length === 1
                        ? `Added ${bought[0].name} from the shopping list`
                        : `Added ${bought.length} items from the shopping list`;

                    // A copy of those areas BEFORE adding, for Undo.
                    rememberForUndo(changedSections, loggedInAs, description, (err, undoId) => {
                        if (err) return sendText(res, 500, 'Could not read inventory');

                        bought.forEach(item => {
                            const amount = toStockUnit(Number(item.quantity), item.unit, item.name, aliasLookup);
                            const key = canonicalKey(item.name, aliasLookup);
                            const list = itemsBySection[item.location];
                            const existing = list.find(stock => stock.unit === amount.unit && canonicalKey(stock.name, aliasLookup) === key);
                            if (existing) {
                                existing.quantity = roundTo2(Number(existing.quantity) + amount.quantity);
                            } else {
                                list.push({ name: item.name, quantity: roundTo2(amount.quantity), unit: amount.unit });
                            }
                            // Just bought more, so it's not running low any more.
                            list.forEach(stock => {
                                if (canonicalKey(stock.name, aliasLookup) === key) stock.low = '';
                            });
                        });

                        const saves = changedSections.map(section => new Promise((resolve, reject) => {
                            saveItems(section, itemsBySection[section], err => err ? reject(err) : resolve());
                        }));

                        Promise.all(saves).then(() => {
                            logActivity(loggedInAs, bought.map(item => ({
                                action: 'Bought (shopping list)', item: item.name, quantity: item.quantity,
                                unit: item.unit, location: SECTION_NAMES[item.location]
                            })));
                            sendJson(res, { undoId, description, added: bought.length });
                        }, () => sendText(res, 500, 'Could not save inventory'));
                    });
                });
            });
        }));
        return;
    }

    // ---- Watch list: every watched product, with its price history ----
    // Also says when the morning check last ran, and whether one's
    // running right now.
    if (req.url === '/watch-list' && req.method === 'GET') {
        readOptionalCsv(WATCH_LIST_FILE, (err, watchList) => {
            if (err) return sendText(res, 500, 'Could not read the watch list');
            readPrices((err, prices) => {
                if (err) return sendText(res, 500, 'Could not read price history');
                sendJson(res, {
                    items: addWatchHistory(watchList, prices),
                    lastCheck: readWatchStatus(),
                    checking: watchCheckRunning
                });
            });
        });
        return;
    }

    // ---- Watch list: star a product ----
    // Body: the product as shown in the search results, plus what was
    // searched for (so the morning check can search for it again).
    // Its current price is saved too, so the graph has a starting point.
    if (req.url === '/watch-list' && req.method === 'POST') {
        readJsonBody(req, res, product => runOneAtATime(res, () => {
            if (!product.item_name || !product.store) return sendText(res, 400, 'Product name and store are needed');

            readOptionalCsv(WATCH_LIST_FILE, (err, watchList) => {
                if (err) return sendText(res, 500, 'Could not read the watch list');

                // Already watching it? Nothing to add.
                const already = watchList.find(w => priceIsForWatchedItem(
                    { original_name: product.item_name, store: product.store, package_size: product.package_size }, w));
                if (already) return sendJson(res, already);

                const watched = {
                    item_name: product.item_name,
                    store: product.store,
                    package_size: product.package_size || '',
                    search_term: product.search_term || product.item_name,
                    added_by: loggedInAs,
                    date_added: nzDateAndTime().date
                };
                // (UPDATE, phase 2: the watch list has no id column any
                // more - its key is store + product + size. This id is made
                // from that key, the same way database.js makes it when
                // reading, so the page can un-star it straight away.)
                watched.id = database.watchListId(watched);
                watchList.push(watched);

                saveRows(WATCH_LIST_FILE, watchList, err => {
                    if (err) return sendText(res, 500, 'Could not save the watch list');

                    // (UPDATE: through appendPrices() - see there.)
                    if (product.price === undefined) return sendJson(res, watched);
                    appendPrices([{
                        item_name: savedPriceName(product.item_name, product.store),
                        price: product.price,
                        cup_price: product.cup_price,
                        cup_measure: product.cup_measure,
                        package_size: product.package_size,
                        store: product.store,
                        date_checked: new Date().toISOString(),
                        original_name: product.item_name,
                        // (UPDATE, phase 5) product code, barcode, brand
                        ...productFieldsFrom(product)
                    }], () => sendJson(res, watched));
                });
            });
        }));
        return;
    }

    // ---- Watch list: run the price check NOW (rather than waiting ----
    // ---- for the morning). Replies straight away - the check carries
    // ---- on in the background, as it can take a few minutes.
    if (req.url === '/watch-list/check' && req.method === 'POST') {
        const alreadyRunning = watchCheckRunning;
        runWatchListCheck();
        sendJson(res, { started: !alreadyRunning, alreadyRunning });
        return;
    }

    // ---- Watch list: un-star a product ----
    if (req.url.startsWith('/watch-list/') && req.method === 'DELETE') {
        // (UPDATE, phase 2: the id is made from the store and product
        // name, so it can contain spaces and apostrophes - the page sends
        // it encoded for a web address, and this turns it back.)
        const watchId = decodeURIComponent(req.url.replace('/watch-list/', ''));
        runOneAtATime(res, () => {
            readOptionalCsv(WATCH_LIST_FILE, (err, watchList) => {
                if (err) return sendText(res, 500, 'Could not read the watch list');
                saveRows(WATCH_LIST_FILE, watchList.filter(w => w.id !== watchId), err => {
                    if (err) return sendText(res, 500, 'Could not save the watch list');
                    sendJson(res, { removed: watchId });
                });
            });
        });
        return;
    }

    // ---- UNDO the most recent change to the house stock ----
    // Sends back the undoId it was given with that change. Only works
    // if nothing else has changed since - see the UNDO section above.
    if (req.url === '/undo' && req.method === 'POST') {
        readJsonBody(req, res, ({ undoId }) => runOneAtATime(res, () => {
            if (!lastChange || lastChange.undoId !== undoId) {
                return sendText(res, 409, "Too late to undo - something else has changed since");
            }

            const change = lastChange;
            // (UPDATE: the copies are lists of items now - see rememberForUndo.)
            const restores = Object.entries(change.savedCopies).map(([section, items]) => new Promise((resolve, reject) => {
                saveItems(section, items, err => err ? reject(err) : resolve());
            }));

            Promise.all(restores).then(() => {
                lastChange = null;
                logActivity(loggedInAs, [{ action: 'Undo', details: `Undid: ${change.description}` }]);
                sendJson(res, { undone: change.description });
            }, () => sendText(res, 500, 'Could not undo'));
        }));
        return;
    }

    // ---- Clear EVERY storage area at once ("Clear Entire House Inventory") ----
    // One request for all four (rather than one each), so the whole
    // clear-out can be undone in one go.
    if (req.url === '/inventory-all' && req.method === 'DELETE') {
        runOneAtATime(res, () => {
            const sections = Object.keys(csvFiles);
            rememberForUndo(sections, loggedInAs, 'Cleared the entire house inventory', (err, undoId) => {
                if (err) return sendText(res, 500, 'Could not read inventory');

                const clears = sections.map(section => new Promise((resolve, reject) => {
                    saveItems(section, [], err => err ? reject(err) : resolve());
                }));

                Promise.all(clears).then(() => {
                    logActivity(loggedInAs, [{ action: 'Cleared everything', details: 'Cleared the entire house inventory' }]);
                    sendJson(res, { undoId, description: 'Cleared the entire house inventory' });
                }, () => sendText(res, 500, 'Could not clear inventory'));
            });
        });
        return;
    }

    // ---- Low stock: every minimum you've set, and whether it's low ----
    if (req.url === '/stock-minimums' && req.method === 'GET') {
        readStockMinimums((err, minimums) => {
            if (err) return sendText(res, 500, 'Could not read stock minimums');
            sendJson(res, minimums);
        });
        return;
    }

    // ---- Low stock: set (or change, or remove) one item's minimum ----
    // A minimum of 0 or blank removes it. Sends back the full updated
    // list, same as the GET above.
    if (req.url === '/stock-minimums' && req.method === 'POST') {
        readJsonBody(req, res, ({ name, minimum, unit }) => runOneAtATime(res, () => {
            name = String(name || '').trim();
            if (!name) return sendText(res, 400, 'Item name is needed');

            readAllAliases((err, aliases) => {
                if (err) return sendText(res, 500, 'Could not read ingredient aliases');
                const aliasLookup = buildAliasLookup(aliases);

                // Same unit conversions as adding stock, so it can be
                // compared with what's in the house - see the POST
                // section route below.
                let amount = Number(minimum) || 0;
                if (isTinUnit(unit)) {
                    const tin = tinSizeFor(name, aliasLookup);
                    amount = amount * tin.quantity;
                    unit = tin.unit;
                }
                if (isWeightUnit(unit)) { amount = toGrams(amount, unit); unit = 'g'; }
                if (isVolumeUnit(unit)) { amount = toMilliliters(amount, unit); unit = 'ml'; }

                readOptionalCsv(STOCK_MINIMUMS_FILE, (err, minimums) => {
                    if (err) return sendText(res, 500, 'Could not read stock minimums');

                    // Replaces any minimum already set for this item.
                    // (UPDATE, phase 5: minimums are saved on the
                    // ingredient now, so "name" here is the ingredient's
                    // name - matched the same way as everywhere else, so
                    // a minimum set for "Chopped Tomatoes" replaces the
                    // one shown as "Tinned Tomatoes" if they're aliases.)
                    const nameKey = canonicalKey(name, aliasLookup);
                    const others = minimums.filter(m => canonicalKey(m.name, aliasLookup) !== nameKey);
                    if (amount > 0) others.push({ name, minimum: roundTo2(amount), unit });

                    saveRows(STOCK_MINIMUMS_FILE, others, err => {
                        if (err) return sendText(res, 500, 'Could not save stock minimums');
                        logActivity(loggedInAs, [amount > 0
                            ? { action: 'Set minimum', item: name, quantity: roundTo2(amount), unit }
                            : { action: 'Removed minimum', item: name }]);
                        readStockMinimums((err, updated) => {
                            if (err) return sendText(res, 500, 'Could not read stock minimums');
                            sendJson(res, updated);
                        });
                    });
                });
            });
        }));
        return;
    }

    // ---- Barcode lookup: what product is this barcode? ----
    // e.g. /barcode?code=9300657000124 -> { name, quantity, unit, location, source }
    // source is "saved" (you've added it before), "openfoodfacts", or
    // "unknown" (not found anywhere - type the name in yourself).
    if (parsedUrl.pathname === '/barcode' && req.method === 'GET') {
        const barcode = String(parsedUrl.searchParams.get('code') || '').replace(/\D/g, '');
        if (!barcode) return sendText(res, 400, 'No barcode given');

        readOptionalCsv(BARCODES_FILE, async (err, barcodes) => {
            if (err) return sendText(res, 500, 'Could not read barcodes');

            const saved = barcodes.find(b => b.barcode === barcode);
            if (saved && saved.name) return sendJson(res, { ...saved, source: 'saved' });

            // (UPDATE, phase 5) Known from a supermarket's price check
            // but never scanned at home - suggest the supermarket's name
            // for it. Its brand and full name are already saved, so
            // nothing needs remembering for rememberBarcode().
            if (saved && saved.product_name) {
                return sendJson(res, { ...saved, name: saved.product_name, source: 'supermarket' });
            }

            try {
                const found = await lookUpOpenFoodFacts(barcode);
                if (found) {
                    recentBarcodeLookups.set(barcode, { brand: found.brand, product_name: found.product_name });
                    return sendJson(res, { barcode, ...found, location: '', source: 'openfoodfacts' });
                }
            } catch (err) {
                // Open Food Facts didn't answer in time, or is down -
                // treat it the same as "not found".
                console.error('Open Food Facts lookup failed:', err.message);
            }
            sendJson(res, { barcode, name: '', quantity: '', unit: '', location: '', source: 'unknown' });
        });
        return;
    }

    // ---- Barcode: remember the name you used for a scanned product ----
    if (req.url === '/barcodes' && req.method === 'POST') {
        readJsonBody(req, res, ({ barcode, name, quantity, unit, location }) => runOneAtATime(res, () => {
            barcode = String(barcode || '').replace(/\D/g, '');
            if (!barcode || !name) return sendText(res, 400, 'Barcode and name are needed');

            rememberBarcode({ barcode, name, quantity, unit, location }, loggedInAs, err => {
                if (err) return sendText(res, 500, 'Could not save barcode');
                sendJson(res, { barcode, name });
            });
        }));
        return;
    }

    // ---- Mark ONE item as running low (the L button), or clear it ----
    // e.g. POST /fridge/low with { name: "BBQ Sauce", unit: "g", low: true }
    // It then shows on the Running Low list and the Meal Planner's
    // shopping list until more is added (see HAVE IT ITEMS above).
    const lowMatch = req.url.match(/^\/(\w+)\/low$/);
    if (lowMatch && csvFiles[lowMatch[1]] && req.method === 'POST') {
        const lowSection = lowMatch[1];

        readJsonBody(req, res, ({ name, unit, low }) => runOneAtATime(res, () => {
            readItems(lowSection, (err, items) => {
                if (err) return sendText(res, 500, 'Could not read ' + csvFiles[lowSection]);

                const item = items.find(i => i.name.toLowerCase() === String(name).toLowerCase() && i.unit === unit);
                if (!item) return sendText(res, 404, 'Item not found');
                item.low = low ? 'yes' : '';

                saveItems(lowSection, items, err => {
                    if (err) return sendText(res, 500, 'Could not save ' + csvFiles[lowSection]);
                    logActivity(loggedInAs, [{
                        action: low ? 'Marked running low' : 'Cleared running low',
                        item: item.name, location: SECTION_NAMES[lowSection]
                    }]);
                    sendJson(res, { name: item.name, low: Boolean(low) });
                });
            });
        }));
        return;
    }

    // ---- Edit ONE item: fix its name, amount or unit, or move it ----
    // ---- to a different storage area ----
    // e.g. POST /fridge/edit with
    //   { original: { name: "Mlik", unit: "ml" },
    //     name: "Milk", quantity: 2, unit: "l", location: "fridge" }
    // The amount is converted the same way Add Item does (2 L -> 2000 ml,
    // tins -> grams). If the place it ends up in already has the same
    // thing (same name and unit), the two are added together rather
    // than listed twice. An amount of 0 just removes it.
    // Can be undone, and goes in the activity log.
    const editMatch = req.url.match(/^\/(\w+)\/edit$/);
    if (editMatch && csvFiles[editMatch[1]] && req.method === 'POST') {
        const editFrom = editMatch[1];

        readJsonBody(req, res, ({ original, name, quantity, unit, location, track }) => runOneAtATime(res, () => {
            name = String(name || '').trim();
            const editTo = csvFiles[location] ? location : editFrom;
            // The Edit box's "have it" tick box (see HAVE IT ITEMS).
            const chosenTrack = track === 'have' || track === 'amount' ? track : undefined;
            if (!original || !name) return sendText(res, 400, 'Item name is needed');

            readAllAliases((err, aliases) => {
                if (err) return sendText(res, 500, 'Could not read ingredient aliases');
                const aliasLookup = buildAliasLookup(aliases);

                readEachSection((err, itemsBySection) => {
                    if (err) return sendText(res, 500, 'Could not read inventory');

                    const isOriginal = i => i.name.toLowerCase() === String(original.name).toLowerCase() && i.unit === original.unit;
                    const before = itemsBySection[editFrom].find(isOriginal);
                    if (!before) return sendText(res, 404, 'Item not found - it may have just been changed by someone else');

                    const amount = toStockUnit(Number(quantity) || 0, unit, name, aliasLookup);
                    const changedSections = [...new Set([editFrom, editTo])];
                    const description = `Edited ${before.name}` + (editTo !== editFrom ? ` (moved to ${SECTION_NAMES[editTo]})` : '');

                    // Copies of the area(s) BEFORE the change, for Undo.
                    rememberForUndo(changedSections, loggedInAs, description, (err, undoId) => {
                        if (err) return sendText(res, 500, 'Could not read inventory');

                        // Take the old version out...
                        itemsBySection[editFrom] = itemsBySection[editFrom].filter(i => !isOriginal(i));

                        // ...and put the new version in (unless it's now 0).
                        if (amount.quantity > 0) {
                            const target = itemsBySection[editTo];
                            const sameThing = target.find(i => i.name.toLowerCase() === name.toLowerCase() && i.unit === amount.unit);
                            if (sameThing) {
                                sameThing.quantity = roundTo2(Number(sameThing.quantity) + amount.quantity);
                                if (chosenTrack) sameThing.track = chosenTrack;
                            } else {
                                // (keeps its running low mark, if it had one)
                                target.push({ name, quantity: roundTo2(amount.quantity), unit: amount.unit, track: chosenTrack || before.track, low: before.low });
                            }
                        }

                        const saves = changedSections.map(section => new Promise((resolve, reject) => {
                            saveItems(section, itemsBySection[section], err => err ? reject(err) : resolve());
                        }));

                        Promise.all(saves).then(() => {
                            logActivity(loggedInAs, [{
                                action: 'Edited', item: name, quantity: roundTo2(amount.quantity), unit: amount.unit,
                                location: SECTION_NAMES[editTo],
                                details: `Was ${before.name}, ${before.quantity} ${before.unit}, ${SECTION_NAMES[editFrom]}`
                            }]);
                            sendJson(res, { undoId, description });
                        }, () => sendText(res, 500, 'Could not save inventory'));
                    });
                });
            });
        }));
        return;
    }

    // ---- Remove ONE item from a storage area completely ----
    // e.g. POST /pantry/remove with { name: "Rice", unit: "g" }
    const removeMatch = req.url.match(/^\/(\w+)\/remove$/);
    if (removeMatch && csvFiles[removeMatch[1]] && req.method === 'POST') {
        const removeFrom = removeMatch[1];

        readJsonBody(req, res, ({ name, unit }) => runOneAtATime(res, () => {
            readItems(removeFrom, (err, items) => {
                if (err) return sendText(res, 500, 'Could not read ' + csvFiles[removeFrom]);

                const isThisItem = i => i.name.toLowerCase() === String(name).toLowerCase() && i.unit === unit;
                const removed = items.find(isThisItem);
                if (!removed) return sendText(res, 404, 'Item not found');

                const description = `Removed ${removed.name} from ${SECTION_NAMES[removeFrom]}`;
                rememberForUndo([removeFrom], loggedInAs, description, (err, undoId) => {
                    if (err) return sendText(res, 500, 'Could not read ' + csvFiles[removeFrom]);

                    saveItems(removeFrom, items.filter(i => !isThisItem(i)), err => {
                        if (err) return sendText(res, 500, 'Could not save ' + csvFiles[removeFrom]);
                        logActivity(loggedInAs, [{
                            action: 'Removed', item: removed.name, quantity: removed.quantity,
                            unit: removed.unit, location: SECTION_NAMES[removeFrom]
                        }]);
                        sendJson(res, { undoId, description });
                    });
                });
            });
        }));
        return;
    }

    // req.url looks like "/pantry" - strip the leading slash to get
    // just the section name.
    const section = req.url.replace('/', '');

    if (!csvFiles[section]) {
        sendText(res, 404, 'Unknown section: ' + section);
        return;
    }

    // ---- GET: return this section's items ----
    // (with a tin count added to tinned goods - see addTinCounts)
    if (req.method === 'GET') {
        readItems(section, (err, items) => {
            if (err) return sendText(res, 500, 'Could not read ' + csvFiles[section]);

            readAllAliases((err, aliases) => {
                if (err) return sendText(res, 500, 'Could not read ingredient aliases');
                sendJson(res, addTrackingInfo(addTinCounts(items, buildAliasLookup(aliases))));
            });
        });
        return;
    }

    // ---- POST: add/update an item, save, return the updated list ----
    if (req.method === 'POST') {
        readJsonBody(req, res, newItem => runOneAtATime(res, () => readAllAliases((err, aliases) => {
            if (err) return sendText(res, 500, 'Could not read ingredient aliases');
            const aliasLookup = buildAliasLookup(aliases);

            // The amount EXACTLY as typed (e.g. 2 tins), kept before
            // the conversions below - used for the activity log and the
            // "Added 2 tins Tomatoes - Undo" message, since that's what
            // you'd recognise.
            const typedQuantity = Number(newItem.quantity);
            const typedUnit = newItem.unit;

            // If this item was entered in TINS, turn it into its weight
            // (or volume) right away - e.g. 10 tins of tomatoes becomes
            // 4000 g - so it merges with anything already stored in
            // grams. See TINNED_GOODS in ingredient-data.js for sizes.
            // (UPDATE, phase 3: the sizes are in the ingredients table now.)
            if (isTinUnit(newItem.unit)) {
                const tin = tinSizeFor(newItem.name, aliasLookup);
                newItem.quantity = Number(newItem.quantity) * tin.quantity;
                newItem.unit = tin.unit;
            }

            // If this item is weight-based (g or kg), convert it to grams
            // right away. That way everything stored is in one consistent
            // unit, and "10kg" + "500g" merge correctly instead of being
            // treated as two different items.
            if (isWeightUnit(newItem.unit)) {
                newItem.quantity = toGrams(newItem.quantity, newItem.unit);
                newItem.unit = 'g';
            }

            // If this item is volume-based (ml or l), convert it to
            // millilitres right away, same reasoning as the weight
            // conversion above - one consistent unit so merging works.
            if (isVolumeUnit(newItem.unit)) {
                newItem.quantity = toMilliliters(newItem.quantity, newItem.unit);
                newItem.unit = 'ml';
            }

            readItems(section, (err, items) => {
                if (err) return sendText(res, 500, 'Could not read ' + csvFiles[section]);

                // Same merge logic your old addItem() used: find a
                // matching item by name AND unit, adjust its quantity.
                const existingItem = items.find(i =>
                    i.name.toLowerCase() === newItem.name.toLowerCase() &&
                    i.unit === newItem.unit
                );

                if (existingItem) {
                    existingItem.quantity = Number(existingItem.quantity) + Number(newItem.quantity);

                    // Added more of it, so it's not running low any more.
                    if (Number(newItem.quantity) > 0) existingItem.low = '';

                    if (existingItem.quantity <= 0) {
                        items = items.filter(i =>
                            !(i.name.toLowerCase() === newItem.name.toLowerCase() && i.unit === newItem.unit)
                        );
                    }
                } else {
                    items.push(newItem);
                }

                // e.g. "Added 2 tins Tomatoes to Pantry" or, for a
                // negative amount, "Took 500 g Rice out of Pantry".
                const amountText = describeAmount(Math.abs(typedQuantity), typedUnit);
                const description = typedQuantity >= 0
                    ? `Added ${amountText} ${newItem.name} to ${SECTION_NAMES[section]}`
                    : `Took ${amountText} ${newItem.name} out of ${SECTION_NAMES[section]}`;

                // A copy of the section BEFORE this change, for Undo.
                rememberForUndo([section], loggedInAs, description, (err, undoId) => {
                    if (err) return sendText(res, 500, 'Could not read ' + csvFiles[section]);

                    saveItems(section, items, (err) => {
                        if (err) return sendText(res, 500, 'Could not save ' + csvFiles[section]);
                        logActivity(loggedInAs, [{
                            action: typedQuantity >= 0 ? 'Added' : 'Took out',
                            item: newItem.name, quantity: typedQuantity, unit: typedUnit,
                            location: SECTION_NAMES[section]
                        }]);
                        // The list stays the reply (so nothing else that
                        // uses it changes); the undo details ride along
                        // in these two headers instead.
                        res.setHeader('X-Undo-Id', undoId);
                        res.setHeader('X-Undo-Description', encodeURIComponent(description));
                        sendJson(res, addTrackingInfo(addTinCounts(items, aliasLookup)));
                    });
                });
            });
        })));
        return;
    }

    // ---- DELETE: clear this section back to empty ----
    if (req.method === 'DELETE') {
        runOneAtATime(res, () => {
            // (The Inventory page now uses DELETE /inventory-all to
            // clear everything in one go - this one-area clear is still
            // here, and still logged and undo-able, in case it's used.)
            const description = `Cleared ${SECTION_NAMES[section]}`;
            rememberForUndo([section], loggedInAs, description, (err, undoId) => {
                if (err) return sendText(res, 500, 'Could not read ' + csvFiles[section]);

                saveItems(section, [], (err) => {
                    if (err) return sendText(res, 500, 'Could not clear ' + csvFiles[section]);
                    logActivity(loggedInAs, [{ action: 'Cleared', location: SECTION_NAMES[section] }]);
                    res.setHeader('X-Undo-Id', undoId);
                    res.setHeader('X-Undo-Description', encodeURIComponent(description));
                    sendJson(res, []);
                });
            });
        });
        return;
    }

    sendText(res, 405, 'Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});