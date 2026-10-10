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
const { BUILT_IN_ALIASES, EXTRA_INGREDIENT_NAMES, TINNED_GOODS, DEFAULT_TIN_SIZE } = require('./ingredient-data');

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

const HOUSEHOLD_MEMBERS = ['Charlotte', 'Todd', 'Kayleigh'];

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
const WOOLWORTHS_STORES = {
    'Woolworths Moorhouse': 'dm-Pickup,f-9169,a-495,s-10235',
    'Woolworths Northlands': 'dm-Pickup,f-9540,a-480,s-38',
    'Woolworths Ferrymead': 'dm-Pickup,f-9576,a-726,s-10410'
};

// Whichever store gets used if none is specifically chosen.
const DEFAULT_WOOLWORTHS_STORE = 'Woolworths Moorhouse';

// -------------------------------------------------------------
// Which physical Pak'nSave store(s) to price things from - same
// idea as WOOLWORTHS_STORES above, but Pak'nSave uses TWO cookies
// together to remember your store rather than one. IDs found via
// the "contentstackStores" data sitting in the page itself.
// -------------------------------------------------------------
const PAKNSAVE_STORES = {
    "PAK'nSAVE Moorhouse": '61dd754e-8525-4b9e-9e08-173389eea8a8',
    "PAK'nSAVE Papanui": '8cd700ae-d96f-4761-bd7a-805d6b93536d',
    "PAK'nSAVE Riccarton": '4a279605-eaa8-470d-bcd4-0a9e3c9ab43b',
    "PAK'nSAVE Wainoni": 'dbca5e00-f7f9-43ae-91de-031ad16f8a92'
};

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
const MAIN_STORES = [TRENTS_STORE_NAME, 'Woolworths Ferrymead', "PAK'nSAVE Wainoni"];
const MAIN_STORES_OPTION = "Our 3 stores (Trents, Woolworths Ferrymead, PAK'nSAVE Wainoni)";

// -------------------------------------------------------------
// SUPERMARKET HOME BRANDS - when a price is SAVED (not in the live
// search results), the supermarkets' own budget brands are renamed
// to one shared name, so the same product lines up across stores in
// Saved Prices. e.g. both "Pams Diced Tomatoes" (Pak'nSave) and
// "Woolworths Essentials Diced Tomatoes" (Woolworths) are saved as
// "Home Brand Diced Tomatoes". Change HOME_BRAND_NAME to rename it.
// Trents is left alone.
// -------------------------------------------------------------
const HOME_BRAND_NAME = 'Home Brand';

// Matches "Pams", "Pams Value", "Pams Finest" or "Woolworths
// Essentials" at the START of a product name.
// Also plain "Woolworths" - their own-brand range is sometimes just
// called "Woolworths Diced Tomatoes" rather than "Essentials".
const HOME_BRAND_PATTERN = /^(pams(\s+(value|finest))?|woolworths(\s+essentials)?)\b/i;

// -------------------------------------------------------------
// The name a price gets SAVED under (see the POST /prices route):
// - home brands renamed to HOME_BRAND_NAME (see above)
// - the pack size taken off the end of the name, since it's already
//   saved in its own Size column - Woolworths writes it in the name
//   ("...Diced Tomatoes 400g Can") but Pak'nSave doesn't, so without
//   this the two would never match up.
// Trents names are saved exactly as they are.
// -------------------------------------------------------------
function savedPriceName(name, store) {
    if (!name || store === TRENTS_STORE_NAME) return name;

    let cleaned = name.replace(HOME_BRAND_PATTERN, HOME_BRAND_NAME);

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

// -------------------------------------------------------------
// Turns raw CSV text into an array of rows, where each row is
// an array of field values. This reads the WHOLE file as one
// stream of characters (not split into lines first), so a real
// line-break typed inside a quoted field (like pressing Enter
// in the Instructions box) is treated as part of that field's
// text, not as the start of a new row.
// -------------------------------------------------------------
function parseCSVRows(csvText) {
    const rows = [];
    let row = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];

        if (char === '"') {
            if (insideQuotes && csvText[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            row.push(current);
            current = '';
        } else if ((char === '\n' || char === '\r') && !insideQuotes) {
            // Only end the row on a line-break that's OUTSIDE quotes.
            // Windows files use \r\n, so skip a lone \r and act on \n.
            if (char === '\r') continue;
            row.push(current);
            rows.push(row);
            row = [];
            current = '';
        } else {
            current += char;
        }
    }

    // Catch the very last field/row if the file doesn't end with
    // a trailing newline.
    if (current.length > 0 || row.length > 0) {
        row.push(current);
        rows.push(row);
    }

    return rows;
}

// -------------------------------------------------------------
// Turns raw CSV text into an array of objects.
// -------------------------------------------------------------
function parseCSV(csvText) {
    const rows = parseCSVRows(csvText.trim());
    if (rows.length === 0) return [];

    const headers = rows[0];

    return rows.slice(1).map(values => {
        const item = {};
        headers.forEach((header, index) => {
            item[header.trim()] = (values[index] || '').trim();
        });
        return item;
    });
}

// -------------------------------------------------------------
// Wraps a value in quotes if it contains a comma, quote, or line
// break - otherwise commas inside the text would be mistaken for
// column separators when the file is read back later.
// -------------------------------------------------------------
function csvField(value) {
    // A missing value (null/undefined) is saved as a blank field -
    // otherwise it'd be written into the file as the actual WORD
    // "null" or "undefined".
    const str = (value === null || value === undefined) ? '' : String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// -------------------------------------------------------------
// Turns an array of objects back into CSV text, ready to save
// to disk. This is the reverse of parseCSV.
// -------------------------------------------------------------
function stringifyCSV(items) {
    const header = 'name,quantity,unit';
    const rows = items.map(item =>
        [item.name, item.quantity, item.unit].map(csvField).join(',')
    );
    return [header, ...rows].join('\n') + '\n';
}

// -------------------------------------------------------------
// A generic version of stringifyCSV that works for any headers,
// not just name/quantity/unit. We need this because recipes.csv
// and recipe_ingredients.csv have different columns.
// -------------------------------------------------------------
function stringifyGenericCSV(headers, items) {
    const headerRow = headers.join(',');
    const rows = items.map(item =>
        headers.map(header => csvField(item[header])).join(',')
    );
    return [headerRow, ...rows].join('\n') + '\n';
}

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

// Reads a section's CSV file and hands back the parsed items.
function readItems(section, callback) {
    fs.readFile(csvFiles[section], 'utf8', (err, data) => {
        if (err) return callback(err, null);
        callback(null, parseCSV(data));
    });
}

// Saves an array of items back to a section's CSV file.
function saveItems(section, items, callback) {
    writeFileSafely(csvFiles[section], stringifyCSV(items), callback);
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
    fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
        if (err) return sendText(res, 500, 'Could not read recipes');

        fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
            if (err) return sendText(res, 500, 'Could not read recipe ingredients');
            callback(parseCSV(recipesData), parseCSV(ingredientsData));
        });
    });
}

// -------------------------------------------------------------
// Saves both recipe files, then replies with replyData. This used
// to be written out in full three times (add, edit, delete).
// -------------------------------------------------------------
function saveRecipeFiles(res, recipes, ingredients, replyData) {
    writeFileSafely(RECIPES_FILE, stringifyGenericCSV(RECIPE_HEADERS, recipes), (err) => {
        if (err) return sendText(res, 500, 'Could not save recipes');

        writeFileSafely(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(RECIPE_INGREDIENT_HEADERS, ingredients), (err) => {
            if (err) return sendText(res, 500, 'Could not save recipe ingredients');
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
    Promise.all([
        fs.promises.readFile(RECIPES_FILE, 'utf8'),
        fs.promises.readFile(RECIPE_INGREDIENTS_FILE, 'utf8'),
        fs.promises.readFile(RECIPE_VOTES_FILE, 'utf8')
    ]).then(([recipesData, ingredientsData, votesData]) => {
        const recipes = parseCSV(recipesData);
        const ingredientsByRecipe = groupByRecipeId(parseCSV(ingredientsData));
        const votesByRecipe = groupByRecipeId(parseCSV(votesData));

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
function readAllInventory(callback) {
    const sections = Object.keys(csvFiles);
    let combined = [];
    let completed = 0;
    let hadError = false;

    sections.forEach(section => {
        fs.readFile(csvFiles[section], 'utf8', (err, data) => {
            if (hadError) return;
            if (err) {
                hadError = true;
                return callback(err, null);
            }

            combined = combined.concat(parseCSV(data));
            completed++;

            // Only combine everything once ALL four files have
            // finished reading (they're async, so this stops us
            // returning early with only some sections loaded).
            if (completed === sections.length) {
                const merged = {};

                combined.forEach(item => {
                    const key = item.name.toLowerCase() + '|' + item.unit;
                    if (!merged[key]) {
                        merged[key] = { name: item.name, unit: item.unit, quantity: 0 };
                    }
                    merged[key].quantity += Number(item.quantity);
                });

                callback(null, Object.values(merged));
            }
        });
    });
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
            Object.entries(BUILT_IN_ALIASES).forEach(([alias, canonical]) => {
                addName(alias);
                addName(canonical);
            });
            EXTRA_INGREDIENT_NAMES.forEach(addName);

            inventoryItems.forEach(item => addName(item.name));
            recipes.forEach(recipe => {
                recipe.ingredients.forEach(ing => addName(ing.ingredient_name));
            });

            callback(null, Array.from(namesByKey.values()).sort());
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
function buildAliasLookup(aliases) {
    const lookup = new Map();
    aliases.forEach(a => {
        const key = normalizeIngredientName(a.alias);
        if (!lookup.has(key)) lookup.set(key, a.canonical_name);
    });
    return lookup;
}

// Follows the alias list as far as it goes, so aliases can build on
// each other: "Gravy Beef" -> "Stewing Beef" -> "Beef" (if you've
// added that second one yourself). Stops after 10 steps, or if it
// ever loops back to a name it's already seen, so a mistake in the
// alias list can never freeze the server.
function canonicalKey(name, aliasLookup) {
    let key = normalizeIngredientName(name);
    const seen = new Set();

    while (aliasLookup.has(key) && !seen.has(key) && seen.size < 10) {
        seen.add(key);
        key = normalizeIngredientName(aliasLookup.get(key));
    }
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
const TIN_SIZE_BY_KEY = new Map(
    TINNED_GOODS.map(good => [normalizeIngredientName(good.name), { quantity: good.quantity, unit: good.unit }])
);

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

    Promise.all(sections.map(section => fs.promises.readFile(csvFiles[section], 'utf8')))
        .then(fileContents => {
            const itemsBySection = {};
            sections.forEach((section, index) => {
                itemsBySection[section] = parseCSV(fileContents[index]);
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
                    store: chosenStore
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
            store: chosenStore
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
function searchOneStore(searchTerm, storeName) {
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
function readPrices(callback) {
    fs.readFile(PRICES_FILE, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return callback(null, []);
            return callback(err, null);
        }
        callback(null, parseCSV(data));
    });
}

// Saves the FULL price history array back to prices.csv.
function savePrices(prices, callback) {
    writeFileSafely(PRICES_FILE, stringifyGenericCSV(PRICE_HEADERS, prices), callback);
}

// Reads ingredient_aliases.csv. If it doesn't exist yet (no
// aliases added so far), that's not an error - just no aliases.
function readAliases(callback) {
    fs.readFile(ALIASES_FILE, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return callback(null, []);
            return callback(err, null);
        }
        callback(null, parseCSV(data));
    });
}

// -------------------------------------------------------------
// YOUR aliases (ingredient_aliases.csv) plus the built-in ones from
// ingredient-data.js, as one list. Yours come FIRST, so if the same
// name is in both, yours wins (buildAliasLookup keeps the first).
// Only used for reading - saving a new alias still only ever writes
// your own ones to the CSV, never the built-in list.
// -------------------------------------------------------------
function readAllAliases(callback) {
    readAliases((err, aliases) => {
        if (err) return callback(err, null);

        const builtIn = Object.entries(BUILT_IN_ALIASES).map(([alias, canonical_name]) => ({ alias, canonical_name }));
        callback(null, aliases.concat(builtIn));
    });
}

// Saves the FULL alias list back to ingredient_aliases.csv.
function saveAliases(aliases, callback) {
    writeFileSafely(ALIASES_FILE, stringifyGenericCSV(ALIAS_HEADERS, aliases), callback);
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
function checkLogin(username, password) {
    const typedName = String(username || '').trim().toLowerCase();
    const typedPassword = String(password || '').trim().toLowerCase();
    const person = HOUSEHOLD_MEMBERS.find(name => name.toLowerCase() === typedName);
    return person && typedPassword === typedName ? person : null;
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

    const lines = rows.map(row =>
        ACTIVITY_LOG_HEADERS.map(header => {
            if (header === 'date') return csvField(date);
            if (header === 'time') return csvField(time);
            if (header === 'person') return csvField(person);
            return csvField(row[header]);
        }).join(',')
    ).join('\n') + '\n';

    // First ever line? Put the column headings at the top first.
    fs.access(ACTIVITY_LOG_FILE, err => {
        const text = err ? ACTIVITY_LOG_HEADERS.join(',') + '\n' + lines : lines;
        fs.appendFile(ACTIVITY_LOG_FILE, text, 'utf8', err => {
            if (err) console.error('Could not write to the activity log:', err);
        });
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
let lastChange = null;   // { undoId, person, description, savedCopies: { section: csvText } }

// Takes the copies of the given storage areas, then hands back the
// new undoId. Must be called INSIDE runOneAtATime, before saving.
function rememberForUndo(sections, person, description, callback) {
    Promise.all(sections.map(section => fs.promises.readFile(csvFiles[section], 'utf8')))
        .then(texts => {
            const savedCopies = {};
            sections.forEach((section, index) => { savedCopies[section] = texts[index]; });
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
// -------------------------------------------------------------
const STOCK_MINIMUMS_FILE = 'stock_minimums.csv';
const STOCK_MINIMUM_HEADERS = ['name', 'minimum', 'unit'];

// Reads a CSV file that might not exist yet (like the minimums,
// before you've set any) - a missing file just means "nothing yet".
function readOptionalCsv(filePath, callback) {
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err && err.code === 'ENOENT') return callback(null, []);
        if (err) return callback(err, null);
        callback(null, parseCSV(data));
    });
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
const BARCODES_FILE = 'barcodes.csv';
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
    return { name, quantity: size ? size.quantity : '', unit: size ? size.unit : '' };
}

// Remembers the name/amount/place you used for a barcode, so next
// time it's filled in straight away (see step 1 above).
function rememberBarcode(details, callback) {
    readOptionalCsv(BARCODES_FILE, (err, barcodes) => {
        if (err) return callback(err);
        const others = barcodes.filter(b => b.barcode !== details.barcode);
        others.push(details);
        writeFileSafely(BARCODES_FILE, stringifyGenericCSV(BARCODE_HEADERS, others), callback);
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
                        original_name: match.name
                    });
                } catch (searchErr) {
                    console.error(`Watch list: couldn't check ${watched.item_name} at ${watched.store}:`, searchErr.message);
                    results[watched.id] = 'failed';
                }
            }
        }

        // Save all of today's prices in one go, then note that today's
        // check is done.
        runInWriteQueue(done => {
            readPrices((err, prices) => {
                const finish = () => {
                    writeFileSafely(WATCH_STATUS_FILE, JSON.stringify({ date, finishedAt: new Date().toISOString(), results }, null, 2), () => {
                        watchCheckRunning = false;
                        console.log(`Watch list check finished - ${newPrices.length} price(s) saved.`);
                        done();
                    });
                };
                if (err || newPrices.length === 0) return finish();
                savePrices(prices.concat(newPrices), saveErr => {
                    if (saveErr) console.error('Watch list: could not save prices:', saveErr);
                    finish();
                });
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
        readJsonBody(req, res, ({ username, password }) => {
            const person = checkLogin(username, password);
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
    if (parsedUrl.pathname === '/stores' && req.method === 'GET') {
        const allStoreNames = [
            // "Our 3 stores" goes FIRST, so it's what's picked by
            // default when the page opens - see MAIN_STORES.
            MAIN_STORES_OPTION,
            ...Object.keys(WOOLWORTHS_STORES),
            ...Object.keys(PAKNSAVE_STORES),
            TRENTS_STORE_NAME
        ];
        sendJson(res, allStoreNames);
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
            readPrices((err, prices) => {
                if (err) return sendText(res, 500, 'Could not read price history');

                // Every save is a NEW row - we're keeping full
                // history, not overwriting a previous check of the
                // same item.
                const entry = {
                    id: Date.now().toString(),
                    // Home brands renamed + pack size taken off the
                    // name, so it lines up across stores - see
                    // savedPriceName() near the top of this file.
                    item_name: savedPriceName(newPrice.item_name, newPrice.store),
                    price: newPrice.price,
                    cup_price: newPrice.cup_price,
                    cup_measure: newPrice.cup_measure,
                    package_size: newPrice.package_size,
                    store: newPrice.store,
                    date_checked: new Date().toISOString(),
                    // The name exactly as the supermarket wrote it, so
                    // e.g. "Woolworths Essentials..." and "Woolworths..."
                    // can still be told apart once both are "Home Brand".
                    original_name: newPrice.item_name
                };

                prices.push(entry);

                savePrices(prices, (err) => {
                    if (err) return sendText(res, 500, 'Could not save price history');
                    sendJson(res, entry);
                });
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
        sendJson(res, HOUSEHOLD_MEMBERS);
        return;
    }

    // ---- Cast (or change) a vote on a recipe ----
    // URL looks like /recipes/1234567890/votes
    if (req.url.match(/^\/recipes\/[^/]+\/votes$/) && req.method === 'POST') {
        const recipeId = req.url.split('/')[2];

        readJsonBody(req, res, voteBody => runOneAtATime(res, () => {
            const { person, vote } = voteBody;

            fs.readFile(RECIPE_VOTES_FILE, 'utf8', (err, votesData) => {
                if (err) return sendText(res, 500, 'Could not read recipe votes');

                const votes = parseCSV(votesData);

                // If this person already voted on this recipe, update
                // their existing vote rather than adding a duplicate row.
                const existingVote = votes.find(v => v.recipe_id === recipeId && v.person === person);

                if (existingVote) {
                    existingVote.vote = vote;
                } else {
                    votes.push({ recipe_id: recipeId, person, vote });
                }

                writeFileSafely(RECIPE_VOTES_FILE, stringifyGenericCSV(RECIPE_VOTE_HEADERS, votes), (err) => {
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
    if (req.url === '/tinned-goods' && req.method === 'GET') {
        sendJson(res, {
            defaultSize: DEFAULT_TIN_SIZE,
            goods: TINNED_GOODS.map(good => ({
                key: normalizeIngredientName(good.name),
                quantity: good.quantity,
                unit: good.unit
            }))
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

                if (existing) {
                    existing.canonical_name = canonical_name;
                } else {
                    aliases.push({ alias, canonical_name });
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

            writeFileSafely(MEAL_PLAN_FILE, stringifyGenericCSV(MEAL_PLAN_HEADERS, rows), err => {
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
                    readAllInventory((err, inventory) => {
                        if (err) return sendText(res, 500, 'Could not read inventory');
                        // Each storage area separately as well, to work out
                        // where each thing usually goes - see
                        // guessStorageLocation() above.
                        readEachSection((err, itemsBySection) => {
                            if (err) return sendText(res, 500, 'Could not read inventory');
                            const aliasLookup = buildAliasLookup(aliases);
                            const list = buildShoppingList(plan, recipes, inventory, aliasLookup)
                                .map(item => ({ ...item, location: guessStorageLocation(item.name, itemsBySection, aliasLookup) }));
                            sendJson(res, list);
                        });
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
                    id: Date.now().toString(),
                    item_name: product.item_name,
                    store: product.store,
                    package_size: product.package_size || '',
                    search_term: product.search_term || product.item_name,
                    added_by: loggedInAs,
                    date_added: nzDateAndTime().date
                };
                watchList.push(watched);

                writeFileSafely(WATCH_LIST_FILE, stringifyGenericCSV(WATCH_LIST_HEADERS, watchList), err => {
                    if (err) return sendText(res, 500, 'Could not save the watch list');

                    readPrices((err, prices) => {
                        if (err || product.price === undefined) return sendJson(res, watched);
                        prices.push({
                            id: Date.now().toString(),
                            item_name: savedPriceName(product.item_name, product.store),
                            price: product.price,
                            cup_price: product.cup_price,
                            cup_measure: product.cup_measure,
                            package_size: product.package_size,
                            store: product.store,
                            date_checked: new Date().toISOString(),
                            original_name: product.item_name
                        });
                        savePrices(prices, () => sendJson(res, watched));
                    });
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
        const watchId = req.url.replace('/watch-list/', '');
        runOneAtATime(res, () => {
            readOptionalCsv(WATCH_LIST_FILE, (err, watchList) => {
                if (err) return sendText(res, 500, 'Could not read the watch list');
                writeFileSafely(WATCH_LIST_FILE, stringifyGenericCSV(WATCH_LIST_HEADERS, watchList.filter(w => w.id !== watchId)), err => {
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
            const restores = Object.entries(change.savedCopies).map(([section, text]) => new Promise((resolve, reject) => {
                writeFileSafely(csvFiles[section], text, err => err ? reject(err) : resolve());
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
                    const others = minimums.filter(m => m.name.toLowerCase() !== name.toLowerCase());
                    if (amount > 0) others.push({ name, minimum: roundTo2(amount), unit });

                    writeFileSafely(STOCK_MINIMUMS_FILE, stringifyGenericCSV(STOCK_MINIMUM_HEADERS, others), err => {
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
            if (saved) return sendJson(res, { ...saved, source: 'saved' });

            try {
                const found = await lookUpOpenFoodFacts(barcode);
                if (found) return sendJson(res, { barcode, ...found, location: '', source: 'openfoodfacts' });
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

            rememberBarcode({ barcode, name, quantity, unit, location }, err => {
                if (err) return sendText(res, 500, 'Could not save barcode');
                sendJson(res, { barcode, name });
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
                sendJson(res, addTinCounts(items, buildAliasLookup(aliases)));
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
                        sendJson(res, addTinCounts(items, aliasLookup));
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