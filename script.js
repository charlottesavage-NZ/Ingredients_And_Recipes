// -------------------------------------------------------------
// This function sets up an inventory list (pantry, fridge, freezer, chest freezer)
// by wiring up its list element and talking to our local server,
// which reads/writes a CSV file for this section.
// I can reuse this function for each storage area instead of writing 4 separate scripts.
// -------------------------------------------------------------
// Base address of our local server. Every section talks to its own
// address on the server, e.g. http://localhost:3000/pantry
const SERVER_URL = 'http://localhost:3000';

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
                .map(name => `<option value="${name}"></option>`)
                .join('');
        })
        .catch(error => {
            console.error('Could not load item name suggestions:', error);
        });
}

loadItemNameSuggestions();

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
    // -------------------------------------------------------------
    function renderItems() {

        // Clear the current list so I can rebuild it fresh
        list.innerHTML = "";

        // Loop through each item in the array
        items.forEach(item => {

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

            // Add the <li> to the list in the HTML
            list.appendChild(li);
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
                .then(response => response.json())
                .then(data => {
                    items = data.map(item => ({
                        ...item,
                        quantity: Number(item.quantity)
                    }));
                    renderItems();
                })
                .catch(error => {
                    console.error(`Could not save item to ${sectionName}:`, error);
                });
        },

        clearAll() {
            fetch(`${SERVER_URL}/${sectionName}`, { method: 'DELETE' })
                .then(response => response.json())
                .then(data => {
                    items = data;
                    renderItems();
                })
                .catch(error => {
                    console.error(`Could not clear ${sectionName}:`, error);
                });
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

    // Clear the form inputs for the next entry
    form.reset();
});


// -------------------------------------------------------------
// Clear ALL inventories at once
// -------------------------------------------------------------
document.getElementById("clear-all").addEventListener("click", function() {
    const isSure = confirm("Are you sure? This will wipe all the data.");
    if (!isSure) return;
    pantryInventory.clearAll();
    fridgeInventory.clearAll();
    freezerInventory.clearAll();
    chestInventory.clearAll();
});