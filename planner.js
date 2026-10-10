// -------------------------------------------------------------
// The Meal Planner page. Shows the week (Monday to Sunday), lets you
// add recipes to each day with how many people each is for, and
// shows one combined shopping list for the whole week.
//
// The plan is saved on the server (meal_plan.csv) every time it
// changes, so everyone in the house sees the same week. The shopping
// list itself is worked out by the server - see MEAL PLANNER in
// server.js - because it needs the recipes, the house stock and the
// ingredient aliases all at once.
// -------------------------------------------------------------
const SERVER_URL = '/recipes';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// How many people a recipe is for when it's first added to a day.
const DEFAULT_PEOPLE = 2;

const weekDaysContainer = document.getElementById('week-days');
const shoppingListContainer = document.getElementById('shopping-list');

// The current plan - one entry per planned recipe:
// [{ day: 'monday', recipe_id: '123', people: 2 }, ...]
let plan = [];

// Every saved recipe, for the "Add a recipe" dropdowns.
let recipes = [];

// The latest shopping list from the server - kept so "Copy list"
// can turn it into text without asking the server again.
let shoppingList = [];

// Same as in the other pages' scripts - makes text safe to put
// inside HTML.
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// "monday" -> "Monday"
function dayLabel(day) {
    return day.charAt(0).toUpperCase() + day.slice(1);
}

// Which day it is today, e.g. "wednesday" - that day's box gets
// highlighted so it's easy to find.
function todayName() {
    return DAYS[(new Date().getDay() + 6) % 7];   // getDay() starts the week on Sunday
}

// -------------------------------------------------------------
// Ticked-off items on the shopping list. Only remembered in THIS
// browser (so ticking things off on your phone in the supermarket
// doesn't tick them off for everyone else). Wrapped in try/catch
// because some private-browsing modes don't allow saving.
// -------------------------------------------------------------
let tickedItems = new Set();
try {
    tickedItems = new Set(JSON.parse(localStorage.getItem('shoppingTicked') || '[]'));
} catch (err) { /* not allowed - start with nothing ticked */ }

function saveTickedItems() {
    try { localStorage.setItem('shoppingTicked', JSON.stringify([...tickedItems])); } catch (err) { /* fine */ }
}

// -------------------------------------------------------------
// Draws the seven day boxes from the current plan.
// -------------------------------------------------------------
function renderWeek() {
    weekDaysContainer.innerHTML = '';
    const recipesById = new Map(recipes.map(r => [r.id, r]));
    const sortedRecipes = [...recipes].sort((a, b) => a.name.localeCompare(b.name));

    DAYS.forEach(day => {
        const box = document.createElement('div');
        box.classList.add('plan-day');
        if (day === todayName()) box.classList.add('plan-today');

        const heading = document.createElement('h3');
        heading.textContent = dayLabel(day) + (day === todayName() ? ' (today)' : '');
        box.appendChild(heading);

        // ---- Each recipe planned for this day ----
        const list = document.createElement('ul');
        list.classList.add('plan-recipes');
        plan.forEach((entry, index) => {
            if (entry.day !== day) return;
            const recipe = recipesById.get(entry.recipe_id);

            const li = document.createElement('li');
            const name = document.createElement('span');
            // (A recipe that's since been deleted still shows, so you
            // can see it and take it off.)
            name.textContent = recipe ? recipe.name : 'Deleted recipe';
            li.appendChild(name);

            // How many people - 1, 2 or 3.
            const people = document.createElement('select');
            people.setAttribute('aria-label', `How many people for ${name.textContent} on ${dayLabel(day)}`);
            [1, 2, 3].forEach(count => {
                const option = document.createElement('option');
                option.value = count;
                option.textContent = `for ${count}`;
                people.appendChild(option);
            });
            people.value = String(entry.people);
            people.addEventListener('change', () => {
                plan[index].people = Number(people.value);
                savePlan();
            });
            li.appendChild(people);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.classList.add('remove-item-btn');
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Take ${name.textContent} off ${dayLabel(day)}`);
            remove.addEventListener('click', () => {
                plan.splice(index, 1);
                savePlan();
            });
            li.appendChild(remove);

            list.appendChild(li);
        });
        box.appendChild(list);

        // ---- "Add a recipe..." dropdown ----
        const add = document.createElement('select');
        add.setAttribute('aria-label', `Add a recipe to ${dayLabel(day)}`);
        add.innerHTML = '<option value="">+ Add a recipe...</option>' +
            sortedRecipes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
        add.addEventListener('change', () => {
            if (!add.value) return;
            plan.push({ day, recipe_id: add.value, people: DEFAULT_PEOPLE });
            savePlan();
        });
        box.appendChild(add);

        weekDaysContainer.appendChild(box);
    });
}

// -------------------------------------------------------------
// Writes an amount from the shopping list in a friendly way:
// tins as "2 tins", grams as g/kg, millilitres as ml/L, "each" as
// just the number.
// -------------------------------------------------------------
function describeAmount(item, quantity) {
    if (item.tinsToBuy !== undefined && quantity === item.toBuy) {
        return `${item.tinsToBuy} ${item.tinsToBuy === 1 ? 'tin' : 'tins'}`;
    }
    if (item.unit === 'g') return quantity >= 1000 ? `${Math.round(quantity / 10) / 100} kg` : `${Math.round(quantity)} g`;
    if (item.unit === 'ml') return quantity >= 1000 ? `${Math.round(quantity / 10) / 100} L` : `${Math.round(quantity)} ml`;
    return String(quantity);
}

// One shopping list line as plain text, e.g. "Chopped tomatoes - 2 tins"
function shoppingLineText(item) {
    if (item.unit === 'spoon') return `${item.name} (none in the house)`;
    return `${item.name} - ${describeAmount(item, item.toBuy)}`;
}

// -------------------------------------------------------------
// Draws the shopping list: what to buy (with tick boxes and a link
// to check its price), and - folded away underneath - everything
// the house already has enough of.
// -------------------------------------------------------------
function renderShoppingList() {
    shoppingListContainer.innerHTML = '';

    if (plan.length === 0) {
        shoppingListContainer.innerHTML = '<p class="no-matches">Add some recipes to the week to see what to buy.</p>';
        return;
    }

    const toBuy = shoppingList.filter(item => item.toBuy > 0);
    const gotEnough = shoppingList.filter(item => item.toBuy <= 0);

    if (toBuy.length === 0) {
        shoppingListContainer.innerHTML = '<p class="can-make">You already have everything for this week!</p>';
    } else {
        const list = document.createElement('ul');
        list.classList.add('shopping-list');

        toBuy.forEach(item => {
            const li = document.createElement('li');
            const id = `buy-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

            const tick = document.createElement('input');
            tick.type = 'checkbox';
            tick.id = id;
            tick.checked = tickedItems.has(item.name);
            tick.addEventListener('change', () => {
                if (tick.checked) tickedItems.add(item.name); else tickedItems.delete(item.name);
                li.classList.toggle('ticked', tick.checked);
                saveTickedItems();
            });
            li.classList.toggle('ticked', tick.checked);

            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = shoppingLineText(item);

            // Which recipes it's for, in small text underneath.
            const forRecipes = document.createElement('small');
            forRecipes.textContent = `For: ${item.recipes.join(', ')}`
                + (item.have > 0 && item.unit !== 'spoon' ? ` (have ${describeAmount(item, item.have)}, need ${describeAmount(item, item.needed)})` : '');

            // Opens the Price Checker with this item already typed in.
            const priceLink = document.createElement('a');
            priceLink.href = `price-checker.html?search=${encodeURIComponent(item.name)}`;
            priceLink.textContent = 'Check price';
            priceLink.classList.add('check-price-link');

            li.appendChild(tick);
            li.appendChild(label);
            li.appendChild(priceLink);
            li.appendChild(forRecipes);
            li.appendChild(buildAddToControls(item, id));
            list.appendChild(li);
        });
        shoppingListContainer.appendChild(list);

        // "Purchased" - adds everything ticked to the inventory.
        const purchasedBtn = document.createElement('button');
        purchasedBtn.type = 'button';
        purchasedBtn.id = 'purchased-btn';
        purchasedBtn.textContent = 'Purchased - add ticked items to the inventory';
        purchasedBtn.addEventListener('click', () => addPurchasedToInventory(purchasedBtn));
        shoppingListContainer.appendChild(purchasedBtn);
    }

    if (gotEnough.length > 0) {
        const details = document.createElement('details');
        details.classList.add('missing-details');
        details.innerHTML = `<summary>Already in the house (${gotEnough.length})</summary>
            <ul>${gotEnough.map(item => `<li>${escapeHtml(item.name)}</li>`).join('')}</ul>`;
        shoppingListContainer.appendChild(details);
    }
}

// =============================================================
// "PURCHASED" - ticked items straight into the inventory
// =============================================================
// Every line on the shopping list has a small "Add to" row: which
// storage area it goes in, and how much you actually bought. The
// place starts on the server's guess (wherever it's already kept, or
// fridge/freezer/pantry from its name - see guessStorageLocation() in
// server.js), and the amount starts on how much the list says to buy -
// change either if you need to (e.g. you bought a 1 kg pack, not 750 g).
// The "Purchased" button then adds every TICKED line to the inventory
// in one go, with an Undo message straight after.
// -------------------------------------------------------------
const STORAGE_AREAS = [
    ['pantry', 'Pantry'],
    ['fridge', 'Fridge'],
    ['freezer', 'Freezer (Inside)'],
    ['chest', 'Chest Freezer']
];

// What you changed in each line's "Add to" row, so it isn't lost when
// the list re-draws (e.g. after ticking something). Keyed by item name.
const addToChoices = new Map();

// The amount and unit the "Add to" row starts on:
// - tinned goods in whole tins ("2 tins")
// - tsp/tbsp things ("none in the house") as 1 - e.g. one bottle
// - everything else as however much the list says to buy
function startingAmount(item) {
    if (item.tinsToBuy !== undefined) return { quantity: item.tinsToBuy, unit: 'tin' };
    if (item.unit === 'spoon') return { quantity: 1, unit: 'each' };
    return { quantity: item.unit === 'each' ? item.toBuy : Math.round(item.toBuy), unit: item.unit };
}

// Unit names shown next to the amount box.
const UNIT_NAMES = { g: 'g', ml: 'ml', each: 'each', tin: 'tins' };

// Builds one line's "Add to [Fridge] [750] g" row.
function buildAddToControls(item, id) {
    if (!addToChoices.has(item.name)) {
        addToChoices.set(item.name, { location: item.location || 'pantry', ...startingAmount(item) });
    }
    const choice = addToChoices.get(item.name);

    const row = document.createElement('div');
    row.classList.add('add-to-row');

    const locationLabel = document.createElement('label');
    locationLabel.htmlFor = `${id}-location`;
    locationLabel.textContent = 'Add to';

    const location = document.createElement('select');
    location.id = `${id}-location`;
    STORAGE_AREAS.forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        location.appendChild(option);
    });
    location.value = choice.location;
    location.addEventListener('change', () => { choice.location = location.value; });

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = 'any';
    amount.value = choice.quantity;
    amount.setAttribute('aria-label', `How much ${item.name} you bought`);
    amount.addEventListener('input', () => { choice.quantity = amount.value; });

    const unit = document.createElement('span');
    unit.textContent = UNIT_NAMES[choice.unit] || choice.unit;

    row.appendChild(locationLabel);
    row.appendChild(location);
    row.appendChild(amount);
    row.appendChild(unit);
    return row;
}

// Sends every ticked line to the server to be added to the inventory.
function addPurchasedToInventory(button) {
    const items = shoppingList
        .filter(item => item.toBuy > 0 && tickedItems.has(item.name))
        .map(item => {
            const choice = addToChoices.get(item.name) || { location: item.location, ...startingAmount(item) };
            return { name: item.name, quantity: Number(choice.quantity), unit: choice.unit, location: choice.location };
        })
        .filter(item => item.quantity > 0);

    if (items.length === 0) {
        alert('Tick the things you bought first.');
        return;
    }

    button.disabled = true;
    fetch(`${SERVER_URL}/meal-plan/purchased`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
    })
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            return response.json();
        })
        .then(({ undoId, description }) => {
            // They're in the house now, so untick them and re-work the
            // list - they'll move down to "Already in the house".
            items.forEach(item => {
                tickedItems.delete(item.name);
                addToChoices.delete(item.name);
            });
            saveTickedItems();
            loadShoppingList();
            showUndoToast(description, undoId, loadShoppingList);
        })
        .catch(error => {
            console.error('Could not add the shopping to the inventory:', error);
            alert("Couldn't add those to the inventory - nothing was changed. Try again in a moment.");
            button.disabled = false;
        });
}

// Asks the server for the shopping list for the current plan.
function loadShoppingList() {
    fetch(`${SERVER_URL}/meal-plan/shopping-list`)
        .then(response => response.json())
        .then(list => {
            shoppingList = list;
            renderShoppingList();
        })
        .catch(error => {
            console.error('Could not load the shopping list:', error);
            shoppingListContainer.innerHTML = "<p>Couldn't work out the shopping list - try refreshing the page.</p>";
        });
}

// Saves the whole plan, then re-draws the week and the shopping list.
function savePlan() {
    renderWeek();
    fetch(`${SERVER_URL}/meal-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan })
    })
        .then(response => {
            if (!response.ok) throw new Error('Server said ' + response.status);
            loadShoppingList();
        })
        .catch(error => {
            console.error('Could not save the meal plan:', error);
            alert("Couldn't save the meal plan - try again in a moment.");
        });
}

// "Clear the week" - empties every day (and un-ticks the list).
document.getElementById('clear-week-btn').addEventListener('click', () => {
    if (!confirm('Take every recipe off the week?')) return;
    plan = [];
    tickedItems.clear();
    saveTickedItems();
    savePlan();
});

// "Copy list" - copies the to-buy list as plain text, ready to paste
// into a message or your phone's notes.
document.getElementById('copy-list-btn').addEventListener('click', () => {
    const status = document.getElementById('copy-list-status');
    const lines = shoppingList.filter(item => item.toBuy > 0).map(item => '- ' + shoppingLineText(item));
    if (lines.length === 0) {
        status.textContent = 'Nothing to buy!';
        return;
    }
    navigator.clipboard.writeText('Shopping list:\n' + lines.join('\n'))
        .then(() => { status.textContent = 'Copied!'; })
        .catch(() => { status.textContent = "Couldn't copy - your browser blocked it."; });
});

// -------------------------------------------------------------
// Load the recipes and the saved plan when the page opens.
// -------------------------------------------------------------
Promise.all([
    fetch(`${SERVER_URL}/recipes`).then(r => r.json()),
    fetch(`${SERVER_URL}/meal-plan`).then(r => r.json())
])
    .then(([savedRecipes, savedPlan]) => {
        recipes = savedRecipes;
        plan = savedPlan.map(entry => ({ ...entry, people: Number(entry.people) || DEFAULT_PEOPLE }));
        renderWeek();
        loadShoppingList();
    })
    .catch(error => {
        console.error('Could not load the meal planner:', error);
    });
