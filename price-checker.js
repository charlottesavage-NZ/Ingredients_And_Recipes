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

    if (!searchTerm) {
        alert("Type something to search for first.");
        return;
    }

    // The real search can take several seconds (a whole browser has
    // to open on the server and load a real page) - show something
    // so it's clear it's working, not stuck.
    resultsContainer.innerHTML = "<p>Searching Woolworths...</p>";

    fetch(`${SERVER_URL}/price-search?item=${encodeURIComponent(searchTerm)}`)
        .then(response => {
            if (!response.ok) throw new Error('Search failed');
            return response.json();
        })
        .then(results => renderResults(results))
        .catch(error => {
            console.error('Price search failed:', error);
            resultsContainer.innerHTML = "<p>Something went wrong searching Woolworths - try again in a moment.</p>";
        });
});

// -------------------------------------------------------------
// Shows every matching product as its own row with a Save button.
// -------------------------------------------------------------
function renderResults(results) {
    resultsContainer.innerHTML = "";

    if (results.length === 0) {
        resultsContainer.innerHTML = "<p>No matches found.</p>";
        return;
    }

    results.forEach(result => {
        const row = document.createElement('div');
        row.classList.add('price-result-row');

        // Some products (ones priced "per each" rather than "per
        // kg") don't have a cup price at all - only show that part
        // when it actually exists.
        const cupInfo = result.cupMeasure
            ? ` ($${result.cupPrice} per ${result.cupMeasure})`
            : "";

        const label = document.createElement('span');
        label.textContent = `${result.name} - $${result.price}${cupInfo} - ${result.store}`;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => savePrice(result));

        row.appendChild(label);
        row.appendChild(saveBtn);
        resultsContainer.appendChild(row);
    });
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
// checked first.
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

            sorted.forEach(entry => {
                const row = document.createElement('div');
                row.classList.add('price-history-row');

                const checkedDate = new Date(entry.date_checked).toLocaleDateString();
                const cupInfo = entry.cup_measure
                    ? ` ($${entry.cup_price} per ${entry.cup_measure})`
                    : "";

                row.textContent = `${entry.item_name} - $${entry.price}${cupInfo} - ${entry.store} - checked ${checkedDate}`;
                historyContainer.appendChild(row);
            });
        })
        .catch(error => {
            console.error('Could not load price history:', error);
        });
}

loadPriceHistory();
