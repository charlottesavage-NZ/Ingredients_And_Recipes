// -------------------------------------------------------------
// Price Checker page logic. Talks to the server's Woolworths
// price-search route, shows every matching product, and lets you
// save individual results into a running price history CSV.
// -------------------------------------------------------------
const SERVER_URL = '/recipes';

// -------------------------------------------------------------
// Makes typed text safe to drop into an HTML string, so an item
// name containing a quote mark (e.g. Nana's "Best" Jam) can't cut
// a suggestion off half-way or break the page. Same function as
// in recipes.js - each page has its own script file.
// -------------------------------------------------------------
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------
// Reuses the same known-item-names endpoint as the other pages,
// so the search box suggests names you've already used in
// inventory or recipes.
// -------------------------------------------------------------
function loadItemNameSuggestions() {
    fetch(`${SERVER_URL}/item-names`)
        .then(response => response.json())
        .then(names => {
            const datalist = document.getElementById('item-names-list');
            datalist.innerHTML = names
                .map(name => `<option value="${escapeHtml(name)}"></option>`)
                .join('');
        })
        .catch(error => {
            console.error('Could not load item name suggestions:', error);
        });
}

loadItemNameSuggestions();

// -------------------------------------------------------------
// Fills the store dropdown with every store the server knows
// about, across every retailer (see WOOLWORTHS_STORES and
// PAKNSAVE_STORES in server.js) - one combined list here, even
// though each retailer is handled completely separately behind
// the scenes. Runs once when the page loads.
// -------------------------------------------------------------
function loadStoreOptions() {
    fetch(`${SERVER_URL}/stores`)
        .then(response => response.json())
        .then(storeNames => {
            const select = document.getElementById('store-select');
            select.innerHTML = storeNames
                .map(name => `<option value="${name}">${name}</option>`)
                .join('');
        })
        .catch(error => {
            console.error('Could not load store list:', error);
        });
}

loadStoreOptions();

const searchInput = document.getElementById('price-search-input');
const searchBtn = document.getElementById('price-search-btn');
const resultsContainer = document.getElementById('price-search-results');
const sortSelect = document.getElementById('price-sort');

// The results of the most recent search, in the order the store
// sent them - see sortResults() below.
let lastSearchResults = [];

// Whether the most recent search was "Our 3 stores" (which adds a
// Store column to the results), and any of those stores that didn't
// come back with results this time.
let lastSearchWasCombined = false;
let lastFailedStores = [];

// What was typed in for the most recent search - remembered with
// anything you "Watch", so the morning check can search for it again.
let lastSearchTerm = '';

// -------------------------------------------------------------
// Works out a unit price that can be FAIRLY compared between
// products, because the stores don't all use the same measure -
// Woolworths might say "$0.57 / 100G" while another product says
// "$5.70 / 1KG". Everything is turned into a price per 1 kg (or per
// 1 litre) behind the scenes, purely for sorting - what's shown on
// the page doesn't change.
// Gives back null if it can't be compared (no unit price, or one
// that's per "each"), so those can go to the bottom of the list.
// -------------------------------------------------------------
function comparableUnitPrice(result) {
    const price = Number(result.cupPrice);
    if (!price || !result.cupMeasure) return null;

    // e.g. "100G", "1kg", "100mL", "kg calc" (Trents), "L calc"
    const match = String(result.cupMeasure).toLowerCase().match(/^(\d*\.?\d*)\s*(kg|g|ml|l)\b/);
    if (!match) return null;

    const amount = Number(match[1]) || 1;            // "kg calc" has no number - means 1 kg
    const toKgOrLitre = { kg: 1, g: 1 / 1000, l: 1, ml: 1 / 1000 }[match[2]];

    return price / (amount * toKgOrLitre);
}

// -------------------------------------------------------------
// Puts a list of search results into the order picked in the
// "Sort by" dropdown. "Best match" keeps the store's own order.
// Always sorts a COPY, so the original order is never lost.
// -------------------------------------------------------------
function sortResults(results) {
    const sorted = [...results];
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

    // Anything that can't be compared (no price/unit price) always
    // goes to the BOTTOM, whichever direction you're sorting in.
    const byNumber = (getValue, direction) => (a, b) => {
        const valueA = getValue(a);
        const valueB = getValue(b);
        if (valueA === null && valueB === null) return 0;
        if (valueA === null) return 1;
        if (valueB === null) return -1;
        return (valueA - valueB) * direction;
    };
    const priceOf = r => (typeof r.price === 'number' ? r.price : null);

    switch (sortSelect.value) {
        case 'name-asc':    return sorted.sort(byName);
        case 'name-desc':   return sorted.sort((a, b) => byName(b, a));
        case 'price-asc':   return sorted.sort(byNumber(priceOf, 1));
        case 'price-desc':  return sorted.sort(byNumber(priceOf, -1));
        case 'unit-asc':    return sorted.sort(byNumber(comparableUnitPrice, 1));
        case 'unit-desc':   return sorted.sort(byNumber(comparableUnitPrice, -1));
        default:            return sorted;           // "Best match"
    }
}

// Changing the dropdown re-orders the results already on screen -
// no need to search again.
sortSelect.addEventListener('change', () => {
    if (lastSearchResults.length > 0) renderResults(sortResults(lastSearchResults));
});
const historyContainer = document.getElementById('price-history-list');

// -------------------------------------------------------------
// Runs a live search against Woolworths NZ via the server, then
// renders every matching product with its own Save button.
// -------------------------------------------------------------
searchBtn.addEventListener('click', function() {
    const searchTerm = searchInput.value.trim();
    const storeName = document.getElementById('store-select').value;

    if (!searchTerm) {
        alert("Type something to search for first.");
        return;
    }

    // The real search can take several seconds (a whole browser has
    // to open on the server and load a real page) - show something
    // so it's clear it's working, not stuck.
    lastSearchTerm = searchTerm;

    resultsContainer.innerHTML = storeName.startsWith('Our 3 stores')
        ? `<p>Searching all 3 stores at once - this can take a little longer...</p>`
        : `<p>Searching ${storeName}...</p>`;

    fetch(`${SERVER_URL}/price-search?item=${encodeURIComponent(searchTerm)}&store=${encodeURIComponent(storeName)}`)
        .then(response => {
            if (!response.ok) throw new Error('Search failed');
            return response.json();
        })
        .then(data => {
            // "Our 3 stores" sends back { combined, results, failedStores }
            // instead of a plain list - see the /price-search route in
            // server.js. The Store column only shows for those searches.
            const isCombined = !Array.isArray(data) && data.combined;
            const results = isCombined ? data.results : data;
            lastSearchWasCombined = isCombined;
            lastFailedStores = isCombined ? data.failedStores : [];

            // Kept so the "Sort by" dropdown can re-order them later
            // without searching all over again.
            lastSearchResults = results;
            renderResults(sortResults(results));
        })
        .catch(error => {
            console.error('Price search failed:', error);
            resultsContainer.innerHTML = `<p>Something went wrong searching ${storeName} - try again in a moment.</p>`;
        });
});

// -------------------------------------------------------------
// Shows every matching product as a table row, with its own Save
// button in the last column.
// -------------------------------------------------------------
function renderResults(results) {
    resultsContainer.innerHTML = "";

    // For "Our 3 stores": if any store didn't come back (slow, or
    // their site changed), say so above the results rather than
    // silently showing fewer stores than expected.
    if (lastSearchWasCombined && lastFailedStores.length > 0) {
        const warning = document.createElement('p');
        warning.classList.add('price-search-warning');
        warning.textContent = `Couldn't get results from ${lastFailedStores.join(' or ')} this time - try that store on its own in a moment.`;
        resultsContainer.appendChild(warning);
    }

    if (results.length === 0) {
        const noMatches = document.createElement('p');
        noMatches.textContent = "No matches found.";
        resultsContainer.appendChild(noMatches);
        return;
    }

    const table = document.createElement('table');
    table.classList.add('price-results-table');

    // Header row - labelled "Unit Price" rather than "Price per Kg",
    // since Woolworths doesn't always calculate it in kilograms (a
    // small jar of minced garlic, for example, shows a price per
    // 10g instead) - this shows exactly what they calculated rather
    // than mislabelling it.
    const thead = document.createElement('thead');
    //
    // The Store column is only added for "Our 3 stores" searches -
    // a single-store search already says which store it is.
    thead.innerHTML = `
        <tr>
            <th>Item</th>
            ${lastSearchWasCombined ? '<th>Store</th>' : ''}
            <th>Size</th>
            <th>Price</th>
            <th>Unit Price</th>
            <th></th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    results.forEach(result => {
        const row = document.createElement('tr');

        // Three possible cases here:
        // - A real price-per-unit exists (Woolworths/Pak'nSave's own
        //   figure, or our own calculated Trents "$/kg calc") -> show
        //   it as "$X / measure".
        // - No price, but there's still a plain size worth showing
        //   (e.g. Trents' "6pk", which can't be turned into a $/kg
        //   figure) -> show just the size text on its own.
        // - Neither -> show a dash rather than leaving it blank.
        let unitPriceText;
        if (result.cupPrice && result.cupMeasure) {
            unitPriceText = `$${result.cupPrice} / ${result.cupMeasure}`;
        } else if (result.cupMeasure) {
            unitPriceText = result.cupMeasure;
        } else {
            unitPriceText = "—";
        }

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => savePrice(result));

        const nameCell = document.createElement('td');
        nameCell.textContent = result.name;

        // Shows the pack size on its own (e.g. "200g", "3kg") - this
        // is null for Woolworths/Pak'nSave until we've confirmed the
        // right field to read it from, so falls back to a dash for
        // now, same as any other missing value.
        const sizeCell = document.createElement('td');
        sizeCell.textContent = result.packageSize || "—";

        const priceCell = document.createElement('td');
        priceCell.textContent = `$${result.price}`;

        const unitPriceCell = document.createElement('td');
        unitPriceCell.textContent = unitPriceText;

        // "Watch" adds it to the Watch List, so the garage checks its
        // price every morning - see WATCH LIST further down.
        const watchBtn = document.createElement('button');
        watchBtn.type = 'button';
        watchBtn.classList.add('watch-btn');
        watchBtn.textContent = '☆ Watch';
        watchBtn.addEventListener('click', () => watchProduct(result, watchBtn));

        const saveCell = document.createElement('td');
        saveCell.classList.add('result-buttons');
        saveCell.appendChild(saveBtn);
        saveCell.appendChild(watchBtn);

        row.appendChild(nameCell);

        // Which store this result came from - "Our 3 stores" only.
        if (lastSearchWasCombined) {
            const storeCell = document.createElement('td');
            storeCell.textContent = result.store;
            row.appendChild(storeCell);
        }

        row.appendChild(sizeCell);
        row.appendChild(priceCell);
        row.appendChild(unitPriceCell);
        row.appendChild(saveCell);
        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    resultsContainer.appendChild(table);
}

// -------------------------------------------------------------
// Sends one specific product's price to the server to be added
// as a new row in the ongoing price history CSV.
// -------------------------------------------------------------
function savePrice(result) {
    fetch(`${SERVER_URL}/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            item_name: result.name,
            price: result.price,
            cup_price: result.cupPrice,
            cup_measure: result.cupMeasure,
            package_size: result.packageSize,
            store: result.store
        })
    })
        .then(response => response.json())
        .then(() => {
            // Refresh the history list so the new save shows up
            // straight away.
            loadPriceHistory();
        })
        .catch(error => {
            console.error('Could not save price:', error);
        });
}

// Every saved price, as last loaded from the server - kept here so
// typing in the filter box can re-draw the list without re-fetching.
let allSavedPrices = [];

// How many products the Saved Prices list shows when you're NOT
// searching - change this number to show more or fewer.
const MAX_RECENT_PRODUCTS = 10;

// -------------------------------------------------------------
// Loads and displays every price you've ever saved, most recently
// checked first, as a table matching the search results above.
//
// Rather than one endless list, saves are GROUPED by product: one
// box per product, showing its most recent check by default, with a
// dropdown to look back at any earlier date it was checked. The CSV
// itself is unchanged - still one row per save - this only changes
// how it's shown on the page.
// -------------------------------------------------------------
function loadPriceHistory() {
    fetch(`${SERVER_URL}/prices`)
        .then(response => response.json())
        .then(prices => {
            allSavedPrices = prices;
            renderPriceHistory();
        })
        .catch(error => {
            console.error('Could not load price history:', error);
        });
}

// -------------------------------------------------------------
// FUZZY PRODUCT MATCHING for Saved Prices. The supermarkets word the
// same product differently, e.g.:
//   Pak'nSave:  "Home Brand Sour Cream & Chives Flavour Potato Chips"
//   Woolworths: "Home Brand Chips Sour Cream Chives Crinkle Cut"
// So instead of needing the exact same name, two names count as the
// same product if most of their WORDS match, in any order.
//
// How it decides:
// - the brand has to match ("Home Brand" only joins "Home Brand",
//   "Wattie's" only joins "Wattie's")
// - filler words that don't change what the product IS are ignored
//   (FILLER_WORDS below - "and", "flavour", "can", "crinkle cut"...)
// - plurals count as the same word ("Chips" = "Chip")
// - the score is: words they share / all the words between them.
//   SAME_PRODUCT_THRESHOLD is the cut-off - tested so the chips above
//   (0.8) DO join up, but "Baked Beans" vs "Spaghetti" (0.4), plain
//   vs flavoured chips (0.4) and chicken breast vs thigh (0.33) don't.
// Only affects how Saved Prices is SHOWN - prices.csv isn't changed.
// -------------------------------------------------------------
//
// UPDATE: raised from 0.6 to 0.65 - "Red Bull" vs "Red Bull Sugar
// Free" scored exactly 0.6 and got lumped together. Everything that
// SHOULD join scores 0.75 or more, so 0.65 leaves a safe gap.
const SAME_PRODUCT_THRESHOLD = 0.65;

// "classic", "instant" and "mix" were added after Pak'nSave's "Maggi
// Classic Pub Style Gravy" didn't match Woolworths' "Maggi Instant
// Gravy Mix Pub Style" - marketing words each store uses differently.
const FILLER_WORDS = new Set([
    'and', 'with', 'in', 'of', 'the', 'a', 'flavour', 'flavoured', 'flavor',
    'style', 'crinkle', 'cut', 'can', 'cans', 'bottle', 'tin', 'pack',
    'punnet', 'bag', 'tray', 'box', 'jar', 'classic', 'instant', 'mix'
]);

// Phrases that mean "a healthier version of the SAME product" rather
// than a different one - e.g. Pak'nSave's "Whole Kernel Corn No Added
// Salt" vs plain "Whole Kernel Corn". These are taken out before
// comparing, so both versions share a box (each row still shows its
// full name underneath). Deliberately NOT included: "lite"/"light"
// and "sugar free"/"zero" - Lite Milk or Red Bull Sugar Free really
// are different products.
const HEALTHIER_VERSION_PHRASES = /\b(no added (salt|sugar)|reduced (salt|sugar|fat)|less (added )?(salt|sugar)|\d+% less (added )?(salt|sugar))\b/g;

// Different wordings that mean the SAME thing, swapped to one shared
// wording before comparing. Added after Woolworths' "Corn Sweet
// Kernels" didn't match Pak'nSave's "Whole Kernel Corn" - both are
// just a tin of corn kernels. Each pair is [what to look for, what to
// swap it to].
const SAME_MEANING_PHRASES = [
    [/\b(whole|sweet) kernels?\b/g, 'kernel'],   // "Whole Kernel" / "Sweet Kernels" -> "kernel"
    [/\bsweet ?corn\b/g, 'corn']                 // "Sweetcorn" / "Sweet Corn" -> "corn"
];

// "Chips" -> "chip", "Tomatoes" -> "tomato", "Berries" -> "berry"
function singularWord(word) {
    if (word.length <= 3) return word;
    if (word.endsWith('oes')) return word.slice(0, -2);
    if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

// Breaks a product name down into its brand and its set of
// meaningful words, ready to be compared by nameSimilarity().
function describeProductName(name) {
    const lower = name.toLowerCase();
    const isHomeBrand = lower.startsWith('home brand');
    const rest = isHomeBrand ? lower.slice('home brand'.length) : lower;

    let cleaned = rest
        .replace(/['’]/g, '')          // "Wattie's" -> "watties"
        .replace(/[^a-z0-9%]+/g, ' ')       // "&", "-", "," etc. become spaces
        .replace(HEALTHIER_VERSION_PHRASES, ' ');  // "no added salt" etc. - see above
    // "Sweet Kernels" -> "kernel" etc. - see SAME_MEANING_PHRASES above
    SAME_MEANING_PHRASES.forEach(([pattern, replacement]) => {
        cleaned = cleaned.replace(pattern, replacement);
    });

    const words = cleaned
        .trim()
        .split(' ')
        .filter(Boolean);

    // For anything that isn't Home Brand, the first word is the brand
    // ("Wattie's", "Red", "Mutti"...).
    const brand = isHomeBrand ? 'home brand' : (words[0] || '');
    const descriptionWords = (isHomeBrand ? words : words.slice(1))
        .map(singularWord)
        .filter(word => !FILLER_WORDS.has(word) && !/^\d/.test(word));   // sizes like "150g" are ignored too

    return { brand, words: new Set(descriptionWords) };
}

// Tidies a pack size so the same size written two ways still
// matches: "250mL" = "250ml", "3 x 420g" = "3x420g", "1 L" = "1l".
function normalizeSize(size) {
    return String(size || '').toLowerCase().replace(/\s+/g, '');
}

// How far apart two pack sizes can be and still count as the same
// product - 5%. The stores sell the "same" tin in slightly different
// sizes (Woolworths' corn is 400g or 420g, Pak'nSave's is 410g), so an
// exact size match kept them apart. 5% lets 400g/410g/420g join up,
// but keeps genuinely different packs apart - e.g. Red Bull 250ml vs
// 355ml, or chips 150g vs 170g. The Unit Price column still shows
// which one is actually cheaper.
const SIZE_TOLERANCE = 0.05;

// Turns a tidied size (from normalizeSize) into { count, amount } in
// grams or ml, e.g. "3x420g" -> { count: 3, amount: 420, kind: 'weight' },
// "1.5l" -> { count: 1, amount: 1500, kind: 'volume' }. Anything it
// can't read (e.g. "each") gives null, and then the sizes have to
// match exactly instead.
function readSize(sizeKey) {
    const match = sizeKey.match(/^(?:(\d+)x)?(\d*\.?\d+)(g|kg|ml|l)$/);
    if (!match) return null;
    const count = Number(match[1] || 1);
    let amount = Number(match[2]);
    if (match[3] === 'kg' || match[3] === 'l') amount *= 1000;
    const kind = (match[3] === 'g' || match[3] === 'kg') ? 'weight' : 'volume';
    return { count, amount, kind };
}

// True if two tidied sizes are close enough to be the same product -
// see SIZE_TOLERANCE above. Multipacks have to have the same number
// in the pack (a 6-pack never joins a single).
function sizesCloseEnough(sizeKeyA, sizeKeyB) {
    if (sizeKeyA === sizeKeyB) return true;
    const a = readSize(sizeKeyA);
    const b = readSize(sizeKeyB);
    if (!a || !b || a.kind !== b.kind || a.count !== b.count) return false;
    return Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) <= SIZE_TOLERANCE;
}

// How alike two described names are, from 0 (nothing in common, or
// different brands) to 1 (exactly the same words).
function nameSimilarity(a, b) {
    if (a.brand !== b.brand) return 0;

    const shared = [...a.words].filter(word => b.words.has(word)).length;
    const allWords = new Set([...a.words, ...b.words]).size;
    return allWords === 0 ? 0 : shared / allWords;
}

// Turns a saved date into a plain "which day" key (e.g. "2026-10-10")
// in YOUR time zone, so two saves on the same day group together.
function dayKey(isoDate) {
    const d = new Date(isoDate);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// -------------------------------------------------------------
// Draws the grouped history (see loadPriceHistory above), narrowed
// down to products whose name matches the filter box, if anything's
// typed in it.
// -------------------------------------------------------------
function renderPriceHistory() {
    historyContainer.innerHTML = "";

    if (allSavedPrices.length === 0) {
        historyContainer.innerHTML = "<p>No saved prices yet.</p>";
        return;
    }

    // IDs are timestamps, so sorting by id descending puts
    // the most recently saved entries at the top.
    const sorted = [...allSavedPrices].sort((a, b) => Number(b.id) - Number(a.id));

    const filterText = historyFilterInput.value.trim().toLowerCase();

    // Group every save by product name. Because the list is already
    // newest-first, the most recently checked product ends up first,
    // and each group's own saves are newest-first too.
    //
    // Names are grouped ignoring capitals and extra spaces, so e.g.
    // "Home Brand Diced Tomatoes In Juice" from Pak'nSave and "Home
    // Brand Diced Tomatoes in Juice" from Woolworths end up in the
    // SAME box. The box is titled with the most recent spelling.
    //
    // On top of that, names that are worded DIFFERENTLY but are clearly
    // the same product are grouped together too - e.g. Pak'nSave's
    // "Home Brand Sour Cream & Chives Flavour Potato Chips" and
    // Woolworths' "Home Brand Chips Sour Cream Chives Crinkle Cut".
    // See describeProductName() and nameSimilarity() below.
    const groups = new Map();
    const groupTitles = new Map();
    const groupDescriptions = new Map();
    // The box's name WITHOUT the size added on - see buildHistoryTable().
    const groupBaseNames = new Map();
    //
    // The pack SIZE has to match as well - Red Bull 250ml from two
    // stores share a box, but Red Bull 475ml gets a box of its own.
    sorted.forEach(entry => {
        if (filterText && !entry.item_name.toLowerCase().includes(filterText)) return;
        const sizeKey = normalizeSize(entry.package_size);
        let key = entry.item_name.toLowerCase().replace(/\s+/g, ' ').trim() + '|' + sizeKey;

        // Not an exact match for an existing box? See if it's a close
        // enough match for one (same size only), and if so, join that
        // box instead.
        if (!groups.has(key)) {
            const description = describeProductName(entry.item_name);
            let bestKey = null;
            let bestScore = 0;
            groupDescriptions.forEach((other, otherKey) => {
                // UPDATE: sizes now only need to be CLOSE (within 5%),
                // not exactly the same - see sizesCloseEnough().
                if (!sizesCloseEnough(other.sizeKey, sizeKey)) return;
                let score = nameSimilarity(description, other.description);
                // A tiny nudge so that, if two boxes match equally
                // well, the one with the exact same size wins.
                if (other.sizeKey === sizeKey) score += 0.001;
                if (score > bestScore) {
                    bestScore = score;
                    bestKey = otherKey;
                }
            });

            if (bestScore >= SAME_PRODUCT_THRESHOLD) {
                key = bestKey;
            } else {
                groups.set(key, []);
                // The size goes in the title too, so different sizes of
                // the same product are easy to tell apart at a glance.
                groupTitles.set(key, entry.package_size ? `${entry.item_name} (${entry.package_size})` : entry.item_name);
                groupBaseNames.set(key, entry.item_name);
                groupDescriptions.set(key, { description, sizeKey });
            }
        }
        groups.get(key).push(entry);
    });

    if (groups.size === 0) {
        historyContainer.innerHTML = "<p>No saved prices match that search.</p>";
        return;
    }

    // Unless you're searching, only the 10 most recently checked
    // products are shown, so the page doesn't turn into an endless
    // scroll. Searching looks through EVERYTHING. This only affects
    // what's shown - every save is still kept in prices.csv.
    let groupsToShow = [...groups];
    if (!filterText && groupsToShow.length > MAX_RECENT_PRODUCTS) {
        groupsToShow = groupsToShow.slice(0, MAX_RECENT_PRODUCTS);

        const note = document.createElement('p');
        note.classList.add('price-history-note');
        note.textContent = `Showing the ${MAX_RECENT_PRODUCTS} most recently checked products (out of ${groups.size}) - search above to find older ones.`;
        historyContainer.appendChild(note);
    }

    groupsToShow.forEach(([groupKey, entries]) => {
        // Now that close sizes share a box, a box can hold more than
        // one size - if so, the title lists them all, e.g.
        // "Home Brand Creamed Style Corn (410g / 400g)".
        const sizesInBox = [...new Set(entries.map(e => e.package_size).filter(Boolean))];
        const itemName = sizesInBox.length > 1
            ? `${groupBaseNames.get(groupKey)} (${sizesInBox.join(' / ')})`
            : groupTitles.get(groupKey);
        const box = document.createElement('div');
        box.classList.add('price-group');

        // Every day this product was checked, newest first - these
        // become the options in its date dropdown.
        const days = [...new Set(entries.map(e => dayKey(e.date_checked)))];

        const header = document.createElement('div');
        header.classList.add('price-group-header');

        const title = document.createElement('h3');
        title.textContent = itemName;

        const dateSelect = document.createElement('select');
        dateSelect.setAttribute('aria-label', `Date checked for ${itemName}`);
        days.forEach((day, index) => {
            const option = document.createElement('option');
            option.value = day;
            const firstSaveThatDay = entries.find(e => dayKey(e.date_checked) === day);
            // Written out as e.g. "11 Aug 2026", so there's no mixing up
            // NZ day/month order with American month/day order.
            const label = new Date(firstSaveThatDay.date_checked)
                .toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
            option.textContent = label + (index === 0 ? ' (latest)' : '');
            dateSelect.appendChild(option);
        });

        header.appendChild(title);
        header.appendChild(dateSelect);
        box.appendChild(header);

        const tableHolder = document.createElement('div');
        box.appendChild(tableHolder);

        // Re-draws just this product's table whenever its date changes.
        const showDay = day => {
            tableHolder.innerHTML = '';
            tableHolder.appendChild(buildHistoryTable(entries.filter(e => dayKey(e.date_checked) === day), groupBaseNames.get(groupKey)));
        };
        dateSelect.addEventListener('change', () => showDay(dateSelect.value));
        showDay(days[0]);

        // A "Show price graph" button, once it's been checked on at
        // least two different days (one day isn't much of a graph!).
        if (days.length >= 2) {
            const graphHolder = document.createElement('div');
            graphHolder.hidden = true;
            const graphBtn = document.createElement('button');
            graphBtn.type = 'button';
            graphBtn.classList.add('graph-btn');
            graphBtn.textContent = 'Show price graph';
            graphBtn.addEventListener('click', () => {
                graphHolder.hidden = !graphHolder.hidden;
                graphBtn.textContent = graphHolder.hidden ? 'Show price graph' : 'Hide price graph';
                if (!graphHolder.hidden && !graphHolder.firstChild) {
                    graphHolder.appendChild(drawPriceGraph(seriesFromSavedPrices(entries)));
                }
            });
            box.appendChild(graphBtn);
            box.appendChild(graphHolder);
        }

        historyContainer.appendChild(box);
    });
}

// -------------------------------------------------------------
// Builds the small table for ONE product on ONE day - one row per
// store. If the same store was saved more than once that day, only
// the latest save is shown (entries are already newest-first).
// -------------------------------------------------------------
// groupTitle is the name shown at the top of the box (without its
// size) - used to decide whether each row's own product name needs
// showing underneath.
function buildHistoryTable(entriesForDay, groupTitle) {
    // Reuses the same "price-results-table" styling as the
    // live search results, so both tables look consistent.
    const table = document.createElement('table');
    table.classList.add('price-results-table');

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>Store</th>
            <th>Size</th>
            <th>Price</th>
            <th>Unit Price</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const storesShown = new Set();

    entriesForDay.forEach(entry => {
        // One row per store AND pack size - so a single 420g tin and
        // a 3 x 420g multipack from the same store both show up,
        // rather than the newer one hiding the other.
        // Saves made after the original_name column was added are also
        // told apart by the supermarket's own name - so "Woolworths
        // Essentials Diced Tomatoes" and "Woolworths Diced Tomatoes"
        // (both saved as "Home Brand Diced Tomatoes") both show.
        const rowKey = `${entry.store}|${entry.package_size}|${entry.original_name || ''}`;
        if (storesShown.has(rowKey)) return;
        storesShown.add(rowKey);

        const row = document.createElement('tr');

        // Same three-way logic as the live search results
        // above - a real calculated/official unit price, a
        // plain size with no price, or nothing at all.
        let unitPriceText;
        if (entry.cup_price && entry.cup_measure) {
            unitPriceText = `$${entry.cup_price} / ${entry.cup_measure}`;
        } else if (entry.cup_measure) {
            unitPriceText = entry.cup_measure;
        } else {
            unitPriceText = "—";
        }

        const storeCell = document.createElement('td');
        storeCell.textContent = entry.store;

        // Underneath the store, in small text: the product's name as
        // the supermarket actually wrote it (e.g. "Woolworths
        // Essentials Diced Tomatoes 400g Can"), so you can see which
        // product each "Home Brand" row really is.
        // Shown whenever it's worded differently from the box's title -
        // which now also covers rows that were grouped in by the fuzzy
        // matching (older saves with no original_name use their saved
        // name instead).
        //
        // UPDATE: the supermarket's own name is now shown on EVERY row
        // that has one, even when it's identical to the box title (e.g.
        // Pak'nSave's "Red Bull Energy Drink"), so every store's row
        // looks the same. Older saves with no original_name only show
        // their saved name if it's different from the title.
        const ownName = entry.original_name || (entry.item_name !== groupTitle ? entry.item_name : '');
        if (ownName) {
            const originalName = document.createElement('small');
            originalName.classList.add('price-original-name');
            originalName.textContent = ownName;
            storeCell.appendChild(originalName);
        }

        const sizeCell = document.createElement('td');
        sizeCell.textContent = entry.package_size || "—";

        const priceCell = document.createElement('td');
        priceCell.textContent = `$${entry.price}`;

        const unitPriceCell = document.createElement('td');
        unitPriceCell.textContent = unitPriceText;

        row.appendChild(storeCell);
        row.appendChild(sizeCell);
        row.appendChild(priceCell);
        row.appendChild(unitPriceCell);
        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    return table;
}

// Typing in the "Search saved prices" box narrows the list down
// straight away - no need to ask the server again.
const historyFilterInput = document.getElementById('price-history-filter');
historyFilterInput.addEventListener('input', renderPriceHistory);

loadPriceHistory();

// =============================================================
// OPENED FROM THE MEAL PLANNER
// =============================================================
// The shopping list's "Check price" links open this page as
// price-checker.html?search=Chopped%20tomatoes - type that into the
// search box ready to go (you still pick the store and press Search).
// -------------------------------------------------------------
const searchFromLink = new URLSearchParams(location.search).get('search');
if (searchFromLink) {
    searchInput.value = searchFromLink;
    searchInput.focus();
}

// =============================================================
// PRICE GRAPH
// =============================================================
// Draws a simple line graph of price over time - one line per store -
// as an SVG picture, built by hand here rather than with a charting
// library. Used by the Saved Prices boxes and the Watch List.
// -------------------------------------------------------------

// One colour per line on the graph, in order.
const GRAPH_COLOURS = ['#b4a9ff', '#7ee2a8', '#fbbf5a', '#7fd3ff', '#ff8a80'];

// Turns a product's saved prices into lines for the graph: one line
// per store (and size, if there's more than one), with ONE point per
// day - the last price saved that day.
function seriesFromSavedPrices(entries) {
    const lines = new Map();
    [...entries]
        .sort((a, b) => new Date(a.date_checked) - new Date(b.date_checked))
        .forEach(entry => {
            if (entry.price === '' || isNaN(Number(entry.price))) return;
            const label = entry.package_size ? `${entry.store} (${entry.package_size})` : entry.store;
            if (!lines.has(label)) lines.set(label, new Map());
            lines.get(label).set(dayKey(entry.date_checked), { date: entry.date_checked, price: Number(entry.price) });
        });
    return [...lines].map(([label, byDay]) => ({ label, points: [...byDay.values()] }));
}

// "11 Aug" - short date for under the graph.
function shortDate(isoDate) {
    return new Date(isoDate).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

// -------------------------------------------------------------
// Draws the graph. series = [{ label, points: [{ date, price }] }].
// Dates go along the bottom, prices up the side.
// -------------------------------------------------------------
function drawPriceGraph(series) {
    const holder = document.createElement('div');
    holder.classList.add('price-graph');

    const allPoints = series.flatMap(s => s.points);
    if (allPoints.length < 2) {
        holder.textContent = 'Not enough saved prices for a graph yet.';
        return holder;
    }

    // The drawing area, in the SVG's own units (it stretches to fit
    // the screen - see .price-graph in style.css).
    const width = 600, height = 220;
    const left = 56, right = 16, top = 14, bottom = 30;

    const times = allPoints.map(p => new Date(p.date).getTime());
    const prices = allPoints.map(p => p.price);
    const firstTime = Math.min(...times), lastTime = Math.max(...times);
    // A little room above and below the highest/lowest price, so the
    // lines don't sit right on the edges.
    let lowPrice = Math.min(...prices), highPrice = Math.max(...prices);
    const gap = (highPrice - lowPrice) * 0.15 || highPrice * 0.1 || 1;
    lowPrice = Math.max(0, lowPrice - gap);
    highPrice = highPrice + gap;

    const x = time => left + (lastTime === firstTime ? 0.5 : (time - firstTime) / (lastTime - firstTime)) * (width - left - right);
    const y = price => top + (1 - (price - lowPrice) / (highPrice - lowPrice)) * (height - top - bottom);

    const svgParts = [];

    // Price labels and faint lines across, at the top, middle and bottom.
    [highPrice, (highPrice + lowPrice) / 2, lowPrice].forEach(price => {
        svgParts.push(`<line x1="${left}" x2="${width - right}" y1="${y(price)}" y2="${y(price)}" class="graph-grid"/>`);
        svgParts.push(`<text x="${left - 8}" y="${y(price) + 4}" text-anchor="end" class="graph-label">$${price.toFixed(2)}</text>`);
    });

    // First and last date along the bottom.
    svgParts.push(`<text x="${left}" y="${height - 8}" class="graph-label">${shortDate(firstTime)}</text>`);
    svgParts.push(`<text x="${width - right}" y="${height - 8}" text-anchor="end" class="graph-label">${shortDate(lastTime)}</text>`);

    // One line (plus a dot for each check) per store.
    series.forEach((line, index) => {
        const colour = GRAPH_COLOURS[index % GRAPH_COLOURS.length];
        const coords = line.points.map(p => `${x(new Date(p.date).getTime())},${y(p.price)}`);
        if (coords.length > 1) {
            svgParts.push(`<polyline points="${coords.join(' ')}" fill="none" stroke="${colour}" stroke-width="2"/>`);
        }
        line.points.forEach(p => {
            // Hovering a dot (or tapping on a phone) shows its date and price.
            svgParts.push(`<circle cx="${x(new Date(p.date).getTime())}" cy="${y(p.price)}" r="3.5" fill="${colour}">` +
                `<title>${escapeHtml(line.label)}: $${p.price.toFixed(2)} on ${shortDate(p.date)}</title></circle>`);
        });
    });

    holder.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Price over time">${svgParts.join('')}</svg>`;

    // Which colour is which store.
    const legend = document.createElement('ul');
    legend.classList.add('graph-legend');
    series.forEach((line, index) => {
        const item = document.createElement('li');
        item.innerHTML = `<span class="graph-key" style="background:${GRAPH_COLOURS[index % GRAPH_COLOURS.length]}"></span>${escapeHtml(line.label)}`;
        legend.appendChild(item);
    });
    holder.appendChild(legend);

    return holder;
}

// =============================================================
// WATCH LIST
// =============================================================
// "☆ Watch" on a search result adds that exact product (at that
// store) to the watch list, and saves its price right now too. From
// then on the garage checks its price every morning by itself - see
// WATCH LIST in server.js. Each watched product shows its latest
// price, a "Price drop" badge if it's cheaper than last time, and a
// graph of its price over time.
// -------------------------------------------------------------
const watchListContainer = document.getElementById('watch-list');
const watchListStatus = document.getElementById('watch-list-status');
const watchCheckBtn = document.getElementById('watch-check-btn');

function watchProduct(result, button) {
    button.disabled = true;
    fetch(`${SERVER_URL}/watch-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            item_name: result.name,
            store: result.store,
            package_size: result.packageSize,
            search_term: lastSearchTerm,
            price: result.price,
            cup_price: result.cupPrice,
            cup_measure: result.cupMeasure
        })
    })
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            button.textContent = '★ Watching';
            loadWatchList();
            loadPriceHistory();
        })
        .catch(error => {
            console.error('Could not add to the watch list:', error);
            button.disabled = false;
            alert("Couldn't add that to the watch list - try again in a moment.");
        });
}

// "Last checked 7:02am today" / "...on 12 Oct", or "not checked yet".
function describeLastCheck(lastCheck, checking) {
    if (checking) return 'Checking prices now - this can take a few minutes. Refresh the page to see new prices.';
    if (!lastCheck || !lastCheck.finishedAt) return 'Prices are checked automatically every morning from 7am.';
    const finished = new Date(lastCheck.finishedAt);
    const time = finished.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
    const isToday = dayKey(lastCheck.finishedAt) === dayKey(new Date().toISOString());
    return `Last checked ${time} ${isToday ? 'today' : 'on ' + shortDate(lastCheck.finishedAt)}. Checked automatically every morning from 7am.`;
}

function renderWatchList({ items, lastCheck, checking }) {
    watchListStatus.textContent = describeLastCheck(lastCheck, checking);
    watchListContainer.innerHTML = '';

    if (items.length === 0) {
        watchListContainer.innerHTML = '<p class="no-matches">Nothing watched yet - search for a product above and press "☆ Watch".</p>';
        watchCheckBtn.hidden = true;
        return;
    }
    watchCheckBtn.hidden = false;

    // Price drops first, so they're the first thing you see.
    const sorted = [...items].sort((a, b) => Number(b.priceDrop) - Number(a.priceDrop));

    sorted.forEach(item => {
        const box = document.createElement('div');
        box.classList.add('watch-item');
        if (item.priceDrop) box.classList.add('watch-item-drop');

        const header = document.createElement('div');
        header.classList.add('watch-item-header');

        const title = document.createElement('h3');
        title.textContent = item.item_name;
        const where = document.createElement('small');
        where.textContent = item.package_size ? `${item.store} · ${item.package_size}` : item.store;
        title.appendChild(where);
        header.appendChild(title);

        // Today's/latest price, with what's changed since last time.
        const price = document.createElement('div');
        price.classList.add('watch-price');
        if (item.latest) {
            price.textContent = `$${item.latest.price.toFixed(2)}`;
            if (item.previous && item.latest.price !== item.previous.price) {
                const change = item.latest.price - item.previous.price;
                const arrow = document.createElement('span');
                arrow.classList.add(change < 0 ? 'price-down' : 'price-up');
                arrow.textContent = `${change < 0 ? '▼' : '▲'} $${Math.abs(change).toFixed(2)}`;
                price.appendChild(arrow);
            }
        } else {
            price.textContent = 'No price yet';
        }
        header.appendChild(price);
        box.appendChild(header);

        // ---- Badges ----
        const badges = document.createElement('p');
        badges.classList.add('watch-badges');
        if (item.priceDrop) {
            badges.innerHTML += `<span class="badge badge-drop">Price drop - was $${item.previous.price.toFixed(2)}</span>`;
        }
        if (item.lowestSeen) {
            badges.innerHTML += '<span class="badge badge-lowest">Lowest price we\'ve seen</span>';
        }
        if (item.latest) {
            badges.innerHTML += `<span class="watch-checked">Checked ${shortDate(item.latest.date)}</span>`;
        }
        box.appendChild(badges);

        // ---- Graph (folded away) and Remove ----
        const buttons = document.createElement('div');
        buttons.classList.add('watch-buttons');
        const graphHolder = document.createElement('div');
        graphHolder.hidden = true;

        if (item.history.length >= 2) {
            const graphBtn = document.createElement('button');
            graphBtn.type = 'button';
            graphBtn.classList.add('graph-btn');
            graphBtn.textContent = 'Show price graph';
            graphBtn.addEventListener('click', () => {
                graphHolder.hidden = !graphHolder.hidden;
                graphBtn.textContent = graphHolder.hidden ? 'Show price graph' : 'Hide price graph';
                if (!graphHolder.hidden && !graphHolder.firstChild) {
                    graphHolder.appendChild(drawPriceGraph([{ label: item.store, points: item.history }]));
                }
            });
            buttons.appendChild(graphBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.classList.add('remove-item-btn');
        removeBtn.textContent = 'Stop watching';
        removeBtn.addEventListener('click', () => {
            fetch(`${SERVER_URL}/watch-list/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
                .then(() => loadWatchList())
                .catch(error => console.error('Could not remove from the watch list:', error));
        });
        buttons.appendChild(removeBtn);

        box.appendChild(buttons);
        box.appendChild(graphHolder);
        watchListContainer.appendChild(box);
    });
}

function loadWatchList() {
    fetch(`${SERVER_URL}/watch-list`)
        .then(response => response.json())
        .then(renderWatchList)
        .catch(error => {
            console.error('Could not load the watch list:', error);
        });
}

// "Check prices now" - runs the morning check straight away. It
// carries on in the background on the garage (it can take a few
// minutes), so this just says it's started.
watchCheckBtn.addEventListener('click', () => {
    watchCheckBtn.disabled = true;
    fetch(`${SERVER_URL}/watch-list/check`, { method: 'POST' })
        .then(response => response.json())
        .then(() => {
            watchListStatus.textContent = describeLastCheck(null, true);
        })
        .catch(error => console.error('Could not start the price check:', error))
        .finally(() => { watchCheckBtn.disabled = false; });
});

loadWatchList();
