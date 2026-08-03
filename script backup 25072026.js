// -------------------------------------------------------------
// This function sets up an inventory list (pantry, fridge, freezer, chest freezer)
// by wiring up its list element, localStorage, and rendering logic.
// I can reuse this function for each storage area instead of writing 4 separate scripts.
// -------------------------------------------------------------
function setupInventory(sectionName) {

    const list = document.getElementById(`${sectionName}-list`);

    // "items" starts empty for everyone. For pantry, it gets filled in
    // once the server responds (see the fetch block below).
    // For everyone else, it gets filled in immediately from localStorage.
    let items = [];

    // -------------------------------------------------------------
    // NEW: Branch based on which section this is.
    // Pantry now talks to our local server instead of localStorage.
    // -------------------------------------------------------------
    if (sectionName === "pantry") {

        // Ask the server for the pantry data.
        fetch('http://localhost:3000')
            .then(response => response.json())
            .then(data => {

                // The server gives us quantity as a string (e.g. "2"),
                // so convert it to a real number, same as we used to
                // do for localStorage data.
                items = data.map(item => ({
                    ...item,
                    quantity: Number(item.quantity)
                }));

                // Only render now that the data has actually arrived.
                renderItems();
            })
            .catch(error => {
                console.error("Could not load pantry data from server:", error);
            });

    } else {

        // ---- EXISTING BEHAVIOUR, unchanged, for fridge/freezer/chest ----
        items = JSON.parse(localStorage.getItem(`${sectionName}-items`)) || [];

        items = items.map(item => ({
            ...item,
            quantity: Number(item.quantity)
        }));

        // Render immediately, since localStorage doesn't need waiting for.
        renderItems();
    }

    // -------------------------------------------------------------
    // Render function
    // This updates the <ul> list to show all items in the array
    // -------------------------------------------------------------
   function renderItems() {
        list.innerHTML = "";

        items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = `${item.name} — ${item.quantity} ${item.unit}`;
            list.appendChild(li);
        });
    }

    // Return an object so the main script can update this inventory
    return {
        addItem(name, qtyNumber, unit) {
            // (unchanged for now - we'll update this in the next step,
            // once reading works properly for pantry)

            const existingItem = items.find(i =>
                i.name.toLowerCase() === name.toLowerCase() &&
                i.unit === unit
            );

            if (existingItem) {
                existingItem.quantity += qtyNumber;

                if (existingItem.quantity <= 0) {
                    items = items.filter(i =>
                        !(i.name.toLowerCase() === name.toLowerCase() && i.unit === unit)
                    );
                }

                localStorage.setItem(`${sectionName}-items`, JSON.stringify(items));
                renderItems();
                return;
            }

            const newItem = { name, quantity: qtyNumber, unit };
            items.push(newItem);
            localStorage.setItem(`${sectionName}-items`, JSON.stringify(items));
            renderItems();
        },

        clearAll() {
            items = [];
            localStorage.removeItem(`${sectionName}-items`);
            renderItems();
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

    // confirm() shows a Yes/No style popup in the browser.
    // It returns true if the user clicks "OK", false if they click "Cancel".
    // Nothing below this line runs unless the user confirms.
    const isSure = confirm("Are you sure? This will wipe all the data.");

    if (!isSure) {
        // User clicked "Cancel" - stop here, do nothing.
        return;
    }

    // User clicked "OK" - proceed with clearing everything as before.
    pantryInventory.clearAll();
    fridgeInventory.clearAll();
    freezerInventory.clearAll();
    chestInventory.clearAll();
});