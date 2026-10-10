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
    resultsContainer.innerHTML = `<p>Searching ${storeName}...</p>`;

    fetch(`${SERVER_URL}/price-search?item=${encodeURIComponent(searchTerm)}&store=${encodeURIComponent(storeName)}`)
        .then(response => {
            if (!response.ok) throw new Error('Search failed');
            return response.json();
        })
        .then(results => renderResults(results))
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

    if (results.length === 0) {
        resultsContainer.innerHTML = "<p>No matches found.</p>";
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
    thead.innerHTML = `
        <tr>
            <th>Item</th>
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

        const saveCell = document.createElement('td');
        saveCell.appendChild(saveBtn);

        row.appendChild(nameCell);
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
    const groups = new Map();
    const groupTitles = new Map();
    sorted.forEach(entry => {
        if (filterText && !entry.item_name.toLowerCase().includes(filterText)) return;
        const key = entry.item_name.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!groups.has(key)) {
            groups.set(key, []);
            groupTitles.set(key, entry.item_name);
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
        const itemName = groupTitles.get(groupKey);
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
            tableHolder.appendChild(buildHistoryTable(entries.filter(e => dayKey(e.date_checked) === day)));
        };
        dateSelect.addEventListener('change', () => showDay(dateSelect.value));
        showDay(days[0]);

        historyContainer.appendChild(box);
    });
}

// -------------------------------------------------------------
// Builds the small table for ONE product on ONE day - one row per
// store. If the same store was saved more than once that day, only
// the latest save is shown (entries are already newest-first).
// -------------------------------------------------------------
function buildHistoryTable(entriesForDay) {
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
        const rowKey = `${entry.store}|${entry.package_size}`;
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