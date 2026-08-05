// -------------------------------------------------------------
// Price Checker page logic. Talks to the server's Woolworths
// price-search route, shows every matching product, and lets you
// save individual results into a running price history CSV.
// -------------------------------------------------------------
const SERVER_URL = 'http://localhost:3000';

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
                .map(name => `<option value="${name}"></option>`)
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

// -------------------------------------------------------------
// Loads and displays every price you've ever saved, most recently
// checked first, as a table matching the search results above.
// -------------------------------------------------------------
function loadPriceHistory() {
    fetch(`${SERVER_URL}/prices`)
        .then(response => response.json())
        .then(prices => {
            historyContainer.innerHTML = "";

            if (prices.length === 0) {
                historyContainer.innerHTML = "<p>No saved prices yet.</p>";
                return;
            }

            // IDs are timestamps, so sorting by id descending puts
            // the most recently saved entries at the top.
            const sorted = [...prices].sort((a, b) => Number(b.id) - Number(a.id));

            // Reuses the same "price-results-table" styling as the
            // live search results, so both tables look consistent.
            const table = document.createElement('table');
            table.classList.add('price-results-table');

            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr>
                    <th>Item</th>
                    <th>Size</th>
                    <th>Price</th>
                    <th>Unit Price</th>
                    <th>Store</th>
                    <th>Checked</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');

            sorted.forEach(entry => {
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
                const checkedDate = new Date(entry.date_checked).toLocaleDateString();

                const nameCell = document.createElement('td');
                nameCell.textContent = entry.item_name;

                const sizeCell = document.createElement('td');
                sizeCell.textContent = entry.package_size || "—";

                const priceCell = document.createElement('td');
                priceCell.textContent = `$${entry.price}`;

                const unitPriceCell = document.createElement('td');
                unitPriceCell.textContent = unitPriceText;

                const storeCell = document.createElement('td');
                storeCell.textContent = entry.store;

                const dateCell = document.createElement('td');
                dateCell.textContent = checkedDate;

                row.appendChild(nameCell);
                row.appendChild(sizeCell);
                row.appendChild(priceCell);
                row.appendChild(unitPriceCell);
                row.appendChild(storeCell);
                row.appendChild(dateCell);
                tbody.appendChild(row);
            });

            table.appendChild(tbody);
            historyContainer.appendChild(table);
        })
        .catch(error => {
            console.error('Could not load price history:', error);
        });
}

loadPriceHistory();