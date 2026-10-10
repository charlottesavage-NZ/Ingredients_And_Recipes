// -------------------------------------------------------------
// This function sets up an inventory list (pantry, fridge, freezer, chest freezer)
// by wiring up its list element and talking to our local server,
// which reads/writes a CSV file for this section.
// I can reuse this function for each storage area instead of writing 4 separate scripts.
// -------------------------------------------------------------
// Base address of our local server. Every section talks to its own
// address on the server, e.g. http://localhost:3000/pantry
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
// Converts a gram amount back into a friendly display format
// (e.g. 10500g becomes 10.5 kg). The server stores everything
// in grams, but we don't want to show Charlotte/Todd/Kayleigh
// a wall of 4-5 digit gram numbers.
// -------------------------------------------------------------
function formatWeight(grams) {
    if (grams >= 1000) {
        return {
            quantity: Math.round((grams / 1000) * 100) / 100,
            unit: "kg"
        };
    }
    return {
        quantity: grams,
        unit: "g"
    };
}

// -------------------------------------------------------------
// Converts a millilitre amount back into a friendly display
// format (e.g. 2500ml becomes 2.5 L). Same idea as formatWeight.
// -------------------------------------------------------------
function formatVolume(milliliters) {
    if (milliliters >= 1000) {
        return {
            quantity: Math.round((milliliters / 1000) * 100) / 100,
            unit: "L"
        };
    }
    return {
        quantity: milliliters,
        unit: "ml"
    };
}

// -------------------------------------------------------------
// Loads every known item name from the server and fills the
// <datalist>, so typing in the Item Name box suggests names
// already used anywhere in the house or in recipes.
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
// Holds whatever's currently typed into the search box. Starts
// empty (no filtering). It's declared out here at the top level
// so every section's renderItems() can read the same value.
// -------------------------------------------------------------
let searchTerm = '';

// -------------------------------------------------------------
// Names (lowercase) of everything that's currently below its stock
// minimum - filled in by loadStockMinimums() further down, and read
// by every section's renderItems() to add the "Low" tag.
// -------------------------------------------------------------
let lowStockNames = new Set();

function setupInventory(sectionName) {

    // Build the list element ID dynamically based on the section name.
    // Example: "pantry" becomes pantry-list.
    const list = document.getElementById(`${sectionName}-list`);

    // Items start empty and get filled in once the server responds.
    let items = [];

    // -------------------------------------------------------------
    // Ask the server for this section's saved items and render them
    // once they arrive.
    // -------------------------------------------------------------
    function loadItems() {
        fetch(`${SERVER_URL}/${sectionName}`)
            .then(response => response.json())
            .then(data => {
                items = data.map(item => ({
                    ...item,
                    quantity: Number(item.quantity)
                }));
                renderItems();
                // Something might have been marked (or un-marked) as
                // running low - see renderRunningLow() further down.
                renderRunningLow();
            })
            .catch(error => {
                console.error(`Could not load ${sectionName} data from server:`, error);
            });
    }

    // Load this section's items as soon as the page opens.
    loadItems();

    // -------------------------------------------------------------
    // Render function
    // This updates the <ul> list to show all items in the array
    // that match the current search box text (matches everything
    // if the search box is empty).
    // -------------------------------------------------------------
    function renderItems() {

        // Clear the current list so I can rebuild it fresh
        list.innerHTML = "";

        // Only keep items whose name contains the search text
        // (case-insensitive, partial match - "mince" matches "Beef Mince").
        const itemsToShow = items.filter(item =>
            item.name.toLowerCase().includes(searchTerm)
        );

        // If there's an active search and nothing matched in this
        // section, say so instead of just leaving it blank - avoids
        // it looking broken when really it just means "none here".
        if (searchTerm && itemsToShow.length === 0) {
            const li = document.createElement('li');
            li.textContent = "No matches in this section";
            li.classList.add('no-matches');
            list.appendChild(li);
            return;
        }

        // Loop through each matching item
        itemsToShow.forEach(item => {

            // Create a new <li> element for each item
            const li = document.createElement('li');

            // If it's stored in grams or millilitres, convert it to a
            // nicer display (e.g. 10500g -> 10.5 kg). Anything else
            // (like "each") is shown exactly as stored.
            let display;
            if (item.unit === 'g') {
                display = formatWeight(item.quantity);
            } else if (item.unit === 'ml') {
                display = formatVolume(item.quantity);
            } else {
                display = { quantity: item.quantity, unit: item.unit };
            }

            // Set the text inside the <li> to show name, quantity, and unit
            li.textContent = `${item.name} — ${display.quantity} ${display.unit}`;

            // Tinned goods also show how many tins that works out to,
            // e.g. "Tinned Tomatoes — 4 kg (10 tins)". The server adds
            // the "tins" count - see addTinCounts() in server.js.
            if (item.tins) {
                li.textContent += ` (${item.tins} ${item.tins === 1 ? 'tin' : 'tins'})`;
            }

            // "Have it" items (sauces etc.) don't show an amount at all -
            // it isn't kept up to date, so it'd only be misleading. See
            // HAVE IT ITEMS in server.js.
            if (item.haveIt) {
                li.textContent = `${item.name} — have it`;
            }

            // A small "Low" tag if it's below the minimum you set for
            // it - see LOW STOCK further down - or someone's pressed L.
            if (lowStockNames.has(item.name.toLowerCase()) || item.low === 'yes') {
                const lowTag = document.createElement('span');
                lowTag.classList.add('low-tag');
                lowTag.textContent = 'Low';
                li.appendChild(lowTag);
            }

            // Two small square buttons at the end of the line:
            // E = edit it (fix the name/amount, or move it somewhere
            // else - see startEditingItem below), D = delete it.
            // (These used to be one wider "Remove" button - shortened to
            // single letters so the list doesn't get cluttered. Hovering
            // shows what each one does, and screen readers read out the
            // full "Edit Rice" / "Delete Rice".)
            // L = mark it as running low (press again to clear it).
            // It then shows in Running Low at the top, and on the Meal
            // Planner's shopping list, until more is added.
            const isMarkedLow = item.low === 'yes';
            const lowButton = document.createElement('button');
            lowButton.type = 'button';
            lowButton.classList.add('item-letter-btn', 'low-item-btn');
            if (isMarkedLow) lowButton.classList.add('is-low');
            lowButton.textContent = 'L';
            lowButton.title = isMarkedLow ? `${item.name} is marked as running low - press to clear` : `Mark ${item.name} as running low`;
            lowButton.setAttribute('aria-label', `Running low: ${item.name}`);
            lowButton.setAttribute('aria-pressed', String(isMarkedLow));
            lowButton.addEventListener('click', () => markRunningLow(item, !isMarkedLow));
            li.appendChild(lowButton);

            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.classList.add('item-letter-btn', 'edit-item-btn');
            editButton.textContent = 'E';
            editButton.title = `Edit ${item.name}`;
            editButton.setAttribute('aria-label', `Edit ${item.name}`);
            editButton.addEventListener('click', () => startEditingItem(li, item, display));
            li.appendChild(editButton);

            // A small "Remove" button to take this one item out
            // completely (with an Undo message straight after, in
            // case it was a mis-tap).
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.classList.add('item-letter-btn', 'remove-item-btn');
            removeButton.textContent = 'D';
            removeButton.title = `Delete ${item.name}`;
            removeButton.setAttribute('aria-label', `Delete ${item.name}`);
            removeButton.addEventListener('click', () => removeItem(item));
            li.appendChild(removeButton);

            // Add the <li> to the list in the HTML
            list.appendChild(li);
        });
    }

    // -------------------------------------------------------------
    // "L" - marks the item as running low, or clears it again.
    // -------------------------------------------------------------
    function markRunningLow(item, low) {
        fetch(`${SERVER_URL}/${sectionName}/low`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: item.name, unit: item.unit, low })
        })
            .then(response => {
                if (!response.ok) throw new Error('Server said ' + response.status);
                loadItems();
            })
            .catch(error => {
                console.error(`Could not mark ${item.name} as running low:`, error);
                alert("Couldn't save that - try again in a moment.");
            });
    }

    // -------------------------------------------------------------
    // "E" - swaps the item's line for a small form: name, amount,
    // unit and which storage area it's in, with Save and Cancel. The
    // amount starts in the same friendly unit it's shown in (e.g.
    // 1.5 kg, not 1500 g). Saving sends it to the server (POST
    // /pantry/edit etc. - see server.js), then shows the Undo message.
    // -------------------------------------------------------------
    function startEditingItem(li, item, display) {
        li.innerHTML = '';
        li.classList.add('editing-item');

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = item.name;
        nameInput.setAttribute('aria-label', 'Item name');
        nameInput.setAttribute('list', 'item-names-list');

        const quantityInput = document.createElement('input');
        quantityInput.type = 'number';
        quantityInput.step = 'any';
        quantityInput.min = '0';
        quantityInput.value = display.quantity;
        quantityInput.setAttribute('aria-label', 'Amount');

        // Same unit choices as the Add Item form at the top.
        const unitSelect = document.createElement('select');
        unitSelect.setAttribute('aria-label', 'Unit');
        unitSelect.innerHTML = document.getElementById('item-unit').innerHTML;
        // display.unit is "kg"/"L"/"g"/"ml"/"each" - the dropdown's values are lowercase.
        unitSelect.value = String(display.unit).toLowerCase();

        const locationSelect = document.createElement('select');
        locationSelect.setAttribute('aria-label', 'Where it is');
        locationSelect.innerHTML = document.getElementById('item-location').innerHTML;
        locationSelect.value = sectionName;

        // "Have it" tick box - see HAVE IT ITEMS in server.js.
        const haveItLabel = document.createElement('label');
        haveItLabel.classList.add('have-it-option');
        const haveItBox = document.createElement('input');
        haveItBox.type = 'checkbox';
        haveItBox.checked = Boolean(item.haveIt);
        haveItLabel.appendChild(haveItBox);
        haveItLabel.appendChild(document.createTextNode(' Just track that we have it (sauces etc. - not the amount)'));

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.textContent = 'Save';

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.classList.add('cancel-edit-btn');
        cancelButton.textContent = 'Cancel';
        // Cancel just re-draws the list - nothing was sent anywhere.
        cancelButton.addEventListener('click', () => renderItems());

        saveButton.addEventListener('click', () => {
            const newName = nameInput.value.trim();
            if (!newName) {
                alert('The item needs a name.');
                return;
            }
            saveButton.disabled = true;

            fetch(`${SERVER_URL}/${sectionName}/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    original: { name: item.name, unit: item.unit },
                    name: newName,
                    quantity: Number(quantityInput.value),
                    unit: unitSelect.value,
                    location: locationSelect.value,
                    track: haveItBox.checked ? 'have' : 'amount'
                })
            })
                .then(response => {
                    if (!response.ok) return response.text().then(message => { throw new Error(message); });
                    return response.json();
                })
                .then(({ undoId, description }) => {
                    // It might have moved to a different area, so reload
                    // all four (and the low stock list) - not just this one.
                    reloadEverything();
                    showUndoToast(description, undoId, reloadEverything);
                })
                .catch(error => {
                    console.error(`Could not edit item in ${sectionName}:`, error);
                    alert(`Couldn't save that change - ${error.message || 'try again in a moment'}.`);
                    saveButton.disabled = false;
                });
        });

        li.appendChild(nameInput);
        li.appendChild(quantityInput);
        li.appendChild(unitSelect);
        li.appendChild(locationSelect);
        li.appendChild(haveItLabel);
        li.appendChild(saveButton);
        li.appendChild(cancelButton);
        nameInput.focus();
    }

    // -------------------------------------------------------------
    // Takes one item out of this section completely, then shows the
    // "Removed Rice from Pantry - Undo" message.
    // -------------------------------------------------------------
    function removeItem(item) {
        fetch(`${SERVER_URL}/${sectionName}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: item.name, unit: item.unit })
        })
            .then(response => {
                if (!response.ok) throw new Error('Server said ' + response.status);
                return response.json();
            })
            .then(({ undoId, description }) => {
                loadItems();
                loadStockMinimums();
                showUndoToast(description, undoId, reloadEverything);
            })
            .catch(error => {
                console.error(`Could not remove item from ${sectionName}:`, error);
                alert("Couldn't remove that - try again in a moment.");
            });
    }

    // Return an object so the main script can update this inventory
    return {
        addItem(name, qtyNumber, unit) {

            // Send the new item to the server. The server merges it
            // with any existing matching item, saves the CSV file,
            // and sends back the updated list.
            fetch(`${SERVER_URL}/${sectionName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, quantity: qtyNumber, unit })
            })
                .then(response => {
                    // The server sends the undo details in two headers
                    // alongside the list - see the POST route in server.js.
                    const undoId = response.headers.get('X-Undo-Id');
                    const description = decodeURIComponent(response.headers.get('X-Undo-Description') || '');
                    return response.json().then(data => {
                        items = data.map(item => ({
                            ...item,
                            quantity: Number(item.quantity)
                        }));
                        renderItems();
                        loadStockMinimums();
                        if (undoId) showUndoToast(description, undoId, reloadEverything);
                    });
                })
                .catch(error => {
                    console.error(`Could not save item to ${sectionName}:`, error);
                });
        },

        // (clearAll() used to be here, clearing one section at a time -
        // "Clear Entire House Inventory" now clears all four in ONE
        // request instead, so it can be undone in one go. See the
        // bottom of this file.)

        // Re-fetches this section from the server - used after an
        // Undo or a clear-out, when the saved list has changed.
        reload() {
            loadItems();
        },

        // Lets code outside this function (the search box listener)
        // trigger a re-render using whatever searchTerm is now set to,
        // without needing to re-fetch anything from the server.
        refresh() {
            renderItems();
        },

        // This section's items, plus which section it is - used by the
        // Running Low list to find anything marked with L.
        getItems() {
            return items.map(item => ({ ...item, section: sectionName }));
        }
    };
}


// -------------------------------------------------------------
// Create inventory managers for each storage area
// -------------------------------------------------------------
const pantryInventory = setupInventory("pantry");
const fridgeInventory = setupInventory("fridge");
const freezerInventory = setupInventory("freezer");
const chestInventory = setupInventory("chest");


// -------------------------------------------------------------
// Handle form submissions (adding an item anywhere in the house)
// -------------------------------------------------------------
const form = document.getElementById("house-form");

form.addEventListener("submit", function(event) {

    // Prevent the page from refreshing (default form behaviour)
    event.preventDefault();

    // Get the values typed into the form
    const name = document.getElementById("item-name").value.trim();
    const quantity = document.getElementById("item-quantity").value.trim();
    const unit = document.getElementById("item-unit").value;
    const location = document.getElementById("item-location").value;

    // Basic validation to ensure all fields are filled
    if (!name || !quantity || !unit || !location) {
        alert("Please enter a name, quantity, unit, and location.");
        return;
    }

    // Convert quantity to a number (so negative values work)
    const qtyNumber = Number(quantity);

    // Add the item to the correct inventory based on the dropdown selection
    if (location === "pantry") pantryInventory.addItem(name, qtyNumber, unit);
    if (location === "fridge") fridgeInventory.addItem(name, qtyNumber, unit);
    if (location === "freezer") freezerInventory.addItem(name, qtyNumber, unit);
    if (location === "chest") chestInventory.addItem(name, qtyNumber, unit);

    // If this item came from scanning a barcode, remember it for
    // next time - see BARCODE SCANNING at the bottom of this file.
    rememberScannedBarcode(name, quantity, unit, location);

    // Clear the form inputs for the next entry
    form.reset();
});


// -------------------------------------------------------------
// Search box - filters all four sections at once (pantry, fridge,
// freezer, chest freezer). Typing "mince" only refreshes what's
// DISPLAYED in each section; it never touches the server or the
// saved CSV data.
// -------------------------------------------------------------
document.getElementById('item-search').addEventListener('input', function(event) {
    searchTerm = event.target.value.trim().toLowerCase();

    pantryInventory.refresh();
    fridgeInventory.refresh();
    freezerInventory.refresh();
    chestInventory.refresh();
});

// -------------------------------------------------------------
// Clear ALL inventories at once
// -------------------------------------------------------------
// UPDATE: all four are now cleared in ONE request (DELETE
// /inventory-all), so the Undo message can put the whole lot back.
document.getElementById("clear-all").addEventListener("click", function() {
    const isSure = confirm("Clear EVERYTHING in the Pantry, Fridge and both Freezers?\n\n(You'll get a few seconds to undo it straight after.)");
    if (!isSure) return;

    fetch(`${SERVER_URL}/inventory-all`, { method: 'DELETE' })
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            return response.json();
        })
        .then(({ undoId, description }) => {
            reloadEverything();
            showUndoToast(description, undoId, reloadEverything);
        })
        .catch(error => {
            console.error('Could not clear the inventory:', error);
            alert("Couldn't clear the inventory - try again in a moment.");
        });
});

// -------------------------------------------------------------
// Re-loads all four sections and the low stock list from the
// server - used after an Undo or a clear-out.
// -------------------------------------------------------------
function reloadEverything() {
    pantryInventory.reload();
    fridgeInventory.reload();
    freezerInventory.reload();
    chestInventory.reload();
    loadStockMinimums();
}

// =============================================================
// LOW STOCK - "always want 2 tins of tomatoes"
// =============================================================
// Minimums are only set for the items you choose (in the "Set stock
// minimums" panel) - nothing else is checked. The server works out
// how much of each is in the whole house (all four areas added
// together) and whether it's below the minimum - see the LOW STOCK
// section in server.js.
// -------------------------------------------------------------
const minimumsPanel = document.getElementById('minimums-panel');
const toggleMinimumsBtn = document.getElementById('toggle-minimums-btn');
const minimumForm = document.getElementById('minimum-form');
const minimumsList = document.getElementById('minimums-list');
const lowStockSection = document.getElementById('low-stock-section');
const lowStockList = document.getElementById('low-stock-list');

// Writes an amount from the server in a friendly way: tinned goods
// in tins ("2 tins"), grams as g/kg, millilitres as ml/L, and
// anything else as just the number ("3").
function describeStockAmount(quantity, unit, tins) {
    if (tins !== undefined) return `${tins} ${tins === 1 ? 'tin' : 'tins'}`;
    if (unit === 'g') {
        const d = formatWeight(quantity);
        return `${d.quantity} ${d.unit}`;
    }
    if (unit === 'ml') {
        const d = formatVolume(quantity);
        return `${d.quantity} ${d.unit}`;
    }
    return String(quantity);
}

// Draws the minimums list (inside the panel) and the "Running Low"
// box (only shown when something's actually low), and updates the
// "Low" tags in the four lists.
function renderStockMinimums(minimums) {
    lowStockNames = new Set(minimums.filter(m => m.low).map(m => m.name.toLowerCase()));

    // ---- The panel's list: every minimum, with a Remove button ----
    minimumsList.innerHTML = '';
    if (minimums.length === 0) {
        minimumsList.innerHTML = '<li class="no-matches">No minimums set yet.</li>';
    }
    minimums.forEach(min => {
        const li = document.createElement('li');
        li.textContent = `${min.name} — at least ${describeStockAmount(min.minimum, min.unit, min.minimumTins)}`
            + ` (have ${describeStockAmount(min.have, min.unit, min.haveTins)})`;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.classList.add('remove-item-btn');
        removeButton.textContent = 'Remove';
        removeButton.setAttribute('aria-label', `Stop checking ${min.name}`);
        removeButton.addEventListener('click', () => saveStockMinimum(min.name, 0, min.unit));
        li.appendChild(removeButton);

        minimumsList.appendChild(li);
    });

    // ---- "Running Low": only the ones below their minimum ----
    // (now drawn by renderRunningLow() below, which also adds anything
    // marked with the L button)
    lastMinimums = minimums;
    renderRunningLow();

    // Re-draw the four lists so their "Low" tags are up to date.
    pantryInventory.refresh();
    fridgeInventory.refresh();
    freezerInventory.refresh();
    chestInventory.refresh();
}

// The minimums as last loaded - kept so renderRunningLow() can
// re-draw the list whenever an L mark changes, without re-fetching.
let lastMinimums = [];

// Friendly name for each storage area, for the Running Low list.
const AREA_NAMES = { pantry: 'Pantry', fridge: 'Fridge', freezer: 'Freezer (Inside)', chest: 'Chest Freezer' };

// -------------------------------------------------------------
// Draws the "Running Low" box: everything below its stock minimum,
// PLUS everything someone's marked with the L button. The box is
// hidden when there's nothing in either.
// -------------------------------------------------------------
function renderRunningLow() {
    // (Only ever runs once the page has finished loading - after a
    // section's items arrive from the server - so the four inventories
    // set up further down always exist by then.)
    lowStockList.innerHTML = '';

    lastMinimums.filter(m => m.low).forEach(min => {
        const li = document.createElement('li');
        li.textContent = `${min.name} — ${describeStockAmount(min.have, min.unit, min.haveTins)} left`
            + ` (want at least ${describeStockAmount(min.minimum, min.unit, min.minimumTins)})`;
        lowStockList.appendChild(li);
    });

    const markedLow = [pantryInventory, fridgeInventory, freezerInventory, chestInventory]
        .flatMap(inventory => inventory.getItems())
        .filter(item => item.low === 'yes');
    markedLow.forEach(item => {
        const li = document.createElement('li');
        li.textContent = `${item.name} — marked as running low (${AREA_NAMES[item.section]})`;
        lowStockList.appendChild(li);
    });

    lowStockSection.hidden = lowStockList.children.length === 0;
}

// Fetches the minimums from the server and draws them. Called when
// the page opens, and again after anything in the house changes.
function loadStockMinimums() {
    fetch(`${SERVER_URL}/stock-minimums`)
        .then(response => response.json())
        .then(renderStockMinimums)
        .catch(error => {
            console.error('Could not load stock minimums:', error);
        });
}

// Saves one minimum (0 = stop checking it).
function saveStockMinimum(name, minimum, unit) {
    fetch(`${SERVER_URL}/stock-minimums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, minimum, unit })
    })
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            return response.json();
        })
        .then(renderStockMinimums)
        .catch(error => {
            console.error('Could not save stock minimum:', error);
            alert("Couldn't save that minimum - try again in a moment.");
        });
}

// The "Set stock minimums" button just shows/hides the panel.
toggleMinimumsBtn.addEventListener('click', () => {
    minimumsPanel.hidden = !minimumsPanel.hidden;
    toggleMinimumsBtn.setAttribute('aria-expanded', String(!minimumsPanel.hidden));
    toggleMinimumsBtn.textContent = minimumsPanel.hidden ? 'Set stock minimums' : 'Hide stock minimums';
});

minimumForm.addEventListener('submit', event => {
    event.preventDefault();
    saveStockMinimum(
        document.getElementById('minimum-name').value.trim(),
        Number(document.getElementById('minimum-amount').value),
        document.getElementById('minimum-unit').value
    );
    minimumForm.reset();
});

loadStockMinimums();

// =============================================================
// BARCODE SCANNING
// =============================================================
// "Scan a barcode" opens the phone's camera. Once it reads a barcode
// it asks the server what the product is (your own saved names
// first, then Open Food Facts - see the BARCODES section in
// server.js), and fills in the Add Item form. You check it, pick
// where it's going, and press Add Item as normal.
//
// Whatever name you add it under is remembered for that barcode, so
// next time you scan the same thing it fills in YOUR name for it.
//
// The camera part uses a free barcode-reading library (html5-qrcode).
// It's only downloaded the first time you press the button, so the
// page itself stays quick to open.
// -------------------------------------------------------------
const BARCODE_LIBRARY_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

const scanBarcodeBtn = document.getElementById('scan-barcode-btn');
const barcodePanel = document.getElementById('barcode-panel');
const barcodeStatus = document.getElementById('barcode-status');
const barcodePhotoInput = document.getElementById('barcode-photo');
const barcodePhotoLabel = document.getElementById('barcode-photo-label');

// The barcode that was just scanned, waiting to be remembered once
// you press Add Item (null when nothing's been scanned).
let pendingBarcode = null;

// The camera scanner, once it's been started.
let barcodeScanner = null;

// Loads the barcode library the first time it's needed (and only
// once - after that it's already there).
function loadBarcodeLibrary() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = BARCODE_LIBRARY_URL;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load the barcode reader'));
        document.head.appendChild(script);
    });
}

// Makes the scanner only look for the barcode types used on food
// (EAN-13 is the normal one in NZ), which makes it faster and
// stops it mis-reading QR codes etc.
function makeBarcodeScanner() {
    return new Html5Qrcode('barcode-reader', {
        formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E
        ],
        verbose: false
    });
}

// Stops the camera (if it's running) and hides the scanning panel.
function stopBarcodeScanner() {
    const stopping = barcodeScanner && barcodeScanner.isScanning
        ? barcodeScanner.stop().catch(() => {})
        : Promise.resolve();
    return stopping.then(() => {
        barcodePanel.hidden = true;
        scanBarcodeBtn.hidden = false;
    });
}

// Asks the server what a barcode is, and fills in the form.
function lookUpBarcode(barcode) {
    barcodeStatus.textContent = `Looking up ${barcode}...`;

    fetch(`${SERVER_URL}/barcode?code=${encodeURIComponent(barcode)}`)
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            return response.json();
        })
        .then(product => {
            pendingBarcode = barcode;
            document.getElementById('item-name').value = product.name || '';

            // Only fill the amount/unit/place if they're known, so
            // nothing you've already picked gets wiped.
            if (product.quantity) document.getElementById('item-quantity').value = product.quantity;
            if (product.unit) document.getElementById('item-unit').value = product.unit;
            if (product.location) document.getElementById('item-location').value = product.location;

            if (product.source === 'saved') {
                barcodeStatus.textContent = `Found: ${product.name} (you've added this before). Check it and press Add Item.`;
            } else if (product.source === 'openfoodfacts') {
                barcodeStatus.textContent = `Found: ${product.name}. Change the name if you like (it'll be remembered next time), then press Add Item.`;
            } else {
                barcodeStatus.textContent = "Not found in the database - type the name in and it'll be remembered next time you scan it.";
                document.getElementById('item-name').focus();
            }
        })
        .catch(error => {
            console.error('Could not look up barcode:', error);
            barcodeStatus.textContent = "Couldn't look that barcode up - type it in instead.";
        });
}

scanBarcodeBtn.addEventListener('click', () => {
    barcodeStatus.textContent = 'Starting the camera...';
    barcodePanel.hidden = false;
    scanBarcodeBtn.hidden = true;
    barcodePhotoLabel.hidden = true;
    barcodePhotoInput.hidden = true;

    loadBarcodeLibrary()
        .then(() => {
            barcodeScanner = barcodeScanner || makeBarcodeScanner();
            return barcodeScanner.start(
                { facingMode: 'environment' },   // the camera on the BACK of the phone
                { fps: 10, qrbox: { width: 260, height: 140 } },   // a wide box, the shape of a barcode
                decodedText => {
                    // Got one - stop the camera and look it up.
                    stopBarcodeScanner().then(() => lookUpBarcode(decodedText));
                },
                () => {}   // called for every frame with no barcode in it - nothing to do
            );
        })
        .then(() => {
            barcodeStatus.textContent = 'Point the camera at the barcode.';
        })
        .catch(error => {
            // Usually: camera permission was refused, or the browser
            // only allows the camera on https:// sites. A photo works
            // either way, so offer that instead.
            console.error('Could not start the camera:', error);
            barcodeStatus.textContent = "Couldn't start the camera - you can take a photo of the barcode instead.";
            barcodePhotoLabel.hidden = false;
            barcodePhotoInput.hidden = false;
        });
});

document.getElementById('barcode-stop-btn').addEventListener('click', () => {
    stopBarcodeScanner();
    barcodeStatus.textContent = '';
});

// The "take a photo instead" option - reads the barcode from the photo.
barcodePhotoInput.addEventListener('change', () => {
    const photo = barcodePhotoInput.files[0];
    if (!photo) return;
    barcodeStatus.textContent = 'Reading the barcode from the photo...';

    loadBarcodeLibrary()
        .then(() => {
            barcodeScanner = barcodeScanner || makeBarcodeScanner();
            return barcodeScanner.scanFile(photo, false);
        })
        .then(decodedText => {
            stopBarcodeScanner();
            lookUpBarcode(decodedText);
        })
        .catch(error => {
            console.error('Could not read barcode from photo:', error);
            barcodeStatus.textContent = "Couldn't find a barcode in that photo - try again, closer up and in good light.";
        })
        .finally(() => { barcodePhotoInput.value = ''; });
});

// When an item is added after a scan, remember the name/amount/place
// used for that barcode. Called from the Add Item code above, just
// before the form is cleared.
function rememberScannedBarcode(name, quantity, unit, location) {
    if (!pendingBarcode) return;
    const barcodeDetails = { barcode: pendingBarcode, name, quantity, unit, location };
    pendingBarcode = null;
    barcodeStatus.textContent = '';

    fetch(`${SERVER_URL}/barcodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(barcodeDetails)
    }).catch(error => console.error('Could not remember barcode:', error));
}
