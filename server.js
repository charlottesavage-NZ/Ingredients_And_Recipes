// -------------------------------------------------------------
// This is our local server. It runs on your laptop and acts like
// a mini version of what AWS will eventually do - it reads and
// writes CSV files ("pretend spreadsheets") for each storage area,
// and the browser talks to it using fetch().
// -------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

// Trents login details live in their own gitignored file, never
// typed directly into this file - see credentials.js.
const { TRENTS_USERNAME, TRENTS_PASSWORD } = require('./credentials');

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
const PRICE_HEADERS = ['id', 'item_name', 'price', 'cup_price', 'cup_measure', 'package_size', 'store', 'date_checked'];

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
    const str = String(value);
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

// Reads a section's CSV file and hands back the parsed items.
function readItems(section, callback) {
    fs.readFile(csvFiles[section], 'utf8', (err, data) => {
        if (err) return callback(err, null);
        callback(null, parseCSV(data));
    });
}

// Saves an array of items back to a section's CSV file.
function saveItems(section, items, callback) {
    fs.writeFile(csvFiles[section], stringifyCSV(items), 'utf8', callback);
}

// -------------------------------------------------------------
// Reads recipes.csv and recipe_ingredients.csv, then combines them
// so each recipe object has its own list of ingredients attached.
// -------------------------------------------------------------
function readRecipes(callback) {
    fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
        if (err) return callback(err, null);

        fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
            if (err) return callback(err, null);

            fs.readFile(RECIPE_VOTES_FILE, 'utf8', (err, votesData) => {
                if (err) return callback(err, null);

                const recipes = parseCSV(recipesData);
                const ingredients = parseCSV(ingredientsData);
                const votes = parseCSV(votesData);

                // Attach each recipe's own ingredients AND votes by
                // matching recipe_id, same pattern as before.
                const recipesWithExtras = recipes.map(recipe => ({
                    ...recipe,
                    ingredients: ingredients.filter(ing => ing.recipe_id === recipe.id),
                    votes: votes.filter(v => v.recipe_id === recipe.id)
                }));

                callback(null, recipesWithExtras);
            });
        });
    });
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
            inventoryItems.forEach(item => addName(item.name));
            recipes.forEach(recipe => {
                recipe.ingredients.forEach(ing => addName(ing.ingredient_name));
            });

            callback(null, Array.from(namesByKey.values()).sort());
        });
    });
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
    await page.waitForTimeout(2000);

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

    const data = await response.json();
    await browser.close();

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
                    name: item.productName,
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
                    packageSize: null,
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

    const data = await response.json();

    // Reads back which store ID actually went out in the request
    // itself - lets us directly confirm the two cookies above
    // worked, rather than just hoping they did.
    const requestBody = response.request().postDataJSON();
    const storeIdUsed = requestBody ? requestBody.storeId : null;
    console.log(`Pak'nSave store ID used: ${storeIdUsed}`);

    await browser.close();

    const products = data.products || [];

    return products.map(product => {
        const singlePrice = product.singlePrice || {};
        const comparativePrice = singlePrice.comparativePrice || {};

        return {
            name: product.name,
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
    const rawProducts = await page.$$eval('.cc_product_item', items => {
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

    await browser.close();

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
    fs.writeFile(PRICES_FILE, stringifyGenericCSV(PRICE_HEADERS, prices), 'utf8', callback);
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

// Saves the FULL alias list back to ingredient_aliases.csv.
function saveAliases(aliases, callback) {
    fs.writeFile(ALIASES_FILE, stringifyGenericCSV(ALIAS_HEADERS, aliases), 'utf8', callback);
}

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

    // ---- Combined store list for the dropdown - one list on the ----
    // ---- page, even though Woolworths and Pak'nSave are handled ----
    // ---- completely separately behind the scenes. ----
    if (parsedUrl.pathname === '/stores' && req.method === 'GET') {
        const allStoreNames = [
            ...Object.keys(WOOLWORTHS_STORES),
            ...Object.keys(PAKNSAVE_STORES),
            TRENTS_STORE_NAME
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(allStoreNames));
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
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing ?item= search term');
            return;
        }

        // The dropdown is one combined list, but each store name
        // still tells us which retailer's scraper to actually run.
        const isPakNSaveStore = Object.prototype.hasOwnProperty.call(PAKNSAVE_STORES, storeName);
        const isTrentsStore = storeName === TRENTS_STORE_NAME;

        let searchPromise;
        if (isTrentsStore) {
            searchPromise = searchTrents(searchTerm);
        } else if (isPakNSaveStore) {
            searchPromise = searchPakNSave(searchTerm, storeName);
        } else {
            searchPromise = searchWoolworths(searchTerm, storeName);
        }

        searchPromise
            .then(results => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            })
            .catch(err => {
                console.error('Price search failed:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not complete the price search - Woolworths may be slow to respond, or their site has changed. Try again in a moment.');
            });
        return;
    }

    // ---- Every price ever saved, for the history list on the page ----
    if (parsedUrl.pathname === '/prices' && req.method === 'GET') {
        readPrices((err, prices) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read price history');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(prices));
        });
        return;
    }

    // ---- Save ONE specific search result into the price history ----
    if (parsedUrl.pathname === '/prices' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const newPrice = JSON.parse(body);

            readPrices((err, prices) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read price history');
                    return;
                }

                // Every save is a NEW row - we're keeping full
                // history, not overwriting a previous check of the
                // same item.
                const entry = {
                    id: Date.now().toString(),
                    item_name: newPrice.item_name,
                    price: newPrice.price,
                    cup_price: newPrice.cup_price,
                    cup_measure: newPrice.cup_measure,
                    package_size: newPrice.package_size,
                    store: newPrice.store,
                    date_checked: new Date().toISOString()
                };

                prices.push(entry);

                savePrices(prices, (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save price history');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(entry));
                });
            });
        });
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
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read recipes');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(recipes));
        });
        return;
    }

    if (req.url === '/recipes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const newRecipe = JSON.parse(body);

            // Generate a simple unique ID using the current timestamp.
            // This avoids needing to track "the last ID used" ourselves.
            const newId = Date.now().toString();

            fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipes');
                    return;
                }

                const recipes = parseCSV(recipesData);
                recipes.push({
                    id: newId,
                    name: newRecipe.name,
                    instructions: newRecipe.instructions
                });

                fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not read recipe ingredients');
                        return;
                    }

                    const ingredients = parseCSV(ingredientsData);

                    // Add one row per ingredient, all linked to this recipe's id
                    newRecipe.ingredients.forEach(ing => {
                        ingredients.push({
                            recipe_id: newId,
                            ingredient_name: ing.name,
                            quantity: ing.quantity,
                            unit: ing.unit
                        });
                    });

                    fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], recipes), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipes');
                            return;
                        }

                        fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], ingredients), 'utf8', (err) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Could not save recipe ingredients');
                                return;
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ id: newId, ...newRecipe }));
                        });
                    });
                });
            });
        });
        return;
    }

    // ---- PUT: update an existing recipe by id ----
    // Same idea as POST (create), but instead of adding a new row,
    // we replace the existing recipe's data and completely swap out
    // its ingredient rows for the new set.
    if (req.url.startsWith('/recipes/') && req.method === 'PUT') {
        const recipeId = req.url.replace('/recipes/', '');

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const updatedRecipe = JSON.parse(body);

            fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipes');
                    return;
                }

                const recipes = parseCSV(recipesData);

                // Find the recipe being edited and update its fields
                // in place, keeping the same id.
                const recipe = recipes.find(r => r.id === recipeId);
                if (!recipe) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Recipe not found');
                    return;
                }
                recipe.name = updatedRecipe.name;
                recipe.instructions = updatedRecipe.instructions;

                fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not read recipe ingredients');
                        return;
                    }

                    const ingredients = parseCSV(ingredientsData);

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

                    fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], recipes), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipes');
                            return;
                        }

                        fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], otherIngredients), 'utf8', (err) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Could not save recipe ingredients');
                                return;
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ id: recipeId, ...updatedRecipe }));
                        });
                    });
                });
            });
        });
        return;
    }

    // ---- DELETE a single recipe by id ----
    // URL looks like /recipes/1234567890 - we need to pull the id
    // out of the end of the URL.
    if (req.url.startsWith('/recipes/') && req.method === 'DELETE') {
        const recipeId = req.url.replace('/recipes/', '');

        fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read recipes');
                return;
            }

            const recipes = parseCSV(recipesData);

            // Keep every recipe EXCEPT the one being deleted
            const remainingRecipes = recipes.filter(r => r.id !== recipeId);

            fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipe ingredients');
                    return;
                }

                const ingredients = parseCSV(ingredientsData);

                // Also remove any ingredient rows that belonged to
                // this recipe, otherwise they'd be orphaned - pointing
                // to a recipe_id that no longer exists anywhere.
                const remainingIngredients = ingredients.filter(ing => ing.recipe_id !== recipeId);

                fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], remainingRecipes), 'utf8', (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save recipes');
                        return;
                    }

                    fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], remainingIngredients), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipe ingredients');
                            return;
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ deleted: recipeId }));
                    });
                });
            });
        });
        return;
    }


    // ---- List the household members who can vote ----
    if (req.url === '/household-members' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(HOUSEHOLD_MEMBERS));
        return;
    }

    // ---- Cast (or change) a vote on a recipe ----
    // URL looks like /recipes/1234567890/votes
    if (req.url.match(/^\/recipes\/[^/]+\/votes$/) && req.method === 'POST') {
        const recipeId = req.url.split('/')[2];

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const { person, vote } = JSON.parse(body);

            fs.readFile(RECIPE_VOTES_FILE, 'utf8', (err, votesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipe votes');
                    return;
                }

                const votes = parseCSV(votesData);

                // If this person already voted on this recipe, update
                // their existing vote rather than adding a duplicate row.
                const existingVote = votes.find(v => v.recipe_id === recipeId && v.person === person);

                if (existingVote) {
                    existingVote.vote = vote;
                } else {
                    votes.push({ recipe_id: recipeId, person, vote });
                }

                fs.writeFile(RECIPE_VOTES_FILE, stringifyGenericCSV(['recipe_id', 'person', 'vote'], votes), 'utf8', (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save recipe votes');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ recipe_id: recipeId, person, vote }));
                });
            });
        });
        return;
    }
    
    // ---- Combined inventory across all four sections ----
    // Used by the Recipes page to check "do we have enough of
    // this ingredient anywhere in the house?"
    if (req.url === '/inventory-all' && req.method === 'GET') {
        readAllInventory((err, items) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read inventory');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
        });
        return;
    }

    // ---- All known item names (for dropdown/autocomplete suggestions) ----
    if (req.url === '/item-names' && req.method === 'GET') {
        getAllItemNames((err, names) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read item names');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(names));
        });
        return;
    }

    // ---- All known ingredient aliases ----
    if (req.url === '/ingredient-aliases' && req.method === 'GET') {
        readAliases((err, aliases) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read ingredient aliases');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(aliases));
        });
        return;
    }

    // ---- Add a new alias ----
    if (req.url === '/ingredient-aliases' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let alias, canonical_name;
            try {
                ({ alias, canonical_name } = JSON.parse(body));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON in request body');
                return;
            }

            readAliases((err, aliases) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read ingredient aliases');
                    return;
                }

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
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save ingredient aliases');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ alias, canonical_name }));
                });
            });
        });
        return;
    }

    // req.url looks like "/pantry" - strip the leading slash to get
    // just the section name.
    const section = req.url.replace('/', '');

    if (!csvFiles[section]) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Unknown section: ' + section);
        return;
    }

    // ---- GET: return this section's items ----
    if (req.method === 'GET') {
        readItems(section, (err, items) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read ' + csvFiles[section]);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
        });
        return;
    }

    // ---- POST: add/update an item, save, return the updated list ----
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });

        req.on('end', () => {
            const newItem = JSON.parse(body);
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
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read ' + csvFiles[section]);
                    return;
                }

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

                saveItems(section, items, (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save ' + csvFiles[section]);
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(items));
                });
            });
        });
        return;
    }

    // ---- DELETE: clear this section back to empty ----
    if (req.method === 'DELETE') {
        saveItems(section, [], (err) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not clear ' + csvFiles[section]);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        });
        return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});