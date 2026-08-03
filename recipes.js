// -------------------------------------------------------------
// This handles the Recipes page: adding, editing, and deleting
// recipes (each with any number of ingredients), displaying all
// saved recipes, and checking each recipe against the combined
// house inventory to show what's missing.
// -------------------------------------------------------------

const SERVER_URL = 'http://localhost:3000';

const ingredientRowsContainer = document.getElementById('ingredient-rows');
const recipeList = document.getElementById('recipe-list');
const recipeForm = document.getElementById('recipe-form');
const recipeNameInput = document.getElementById('recipe-name');
const recipeInstructionsInput = document.getElementById('recipe-instructions');
const saveButton = recipeForm.querySelector('button[type="submit"]');

// Keeps track of which recipe is currently being edited.
// null means "we're adding a brand new recipe", not editing one.
let editingRecipeId = null;

// Local copies of the last-loaded data, so we don't need to
// re-fetch from the server every time something re-renders.
let currentRecipes = [];
let currentInventory = [];

// -------------------------------------------------------------
// Weight/volume conversion tables - same idea as script.js, but
// duplicated here since this is a separate page with its own
// script file. Used to convert a recipe's ingredient (which could
// be typed in kg or L) into the SAME base unit the pantry stores
// in (g or ml), so quantities can be fairly compared.
// -------------------------------------------------------------
const WEIGHT_UNITS_TO_GRAMS = { g: 1, kg: 1000 };
const VOLUME_UNITS_TO_ML = { ml: 1, l: 1000 };

function toBaseUnit(quantity, unit) {
    if (unit in WEIGHT_UNITS_TO_GRAMS) {
        return { quantity: quantity * WEIGHT_UNITS_TO_GRAMS[unit], unit: 'g' };
    }
    if (unit in VOLUME_UNITS_TO_ML) {
        return { quantity: quantity * VOLUME_UNITS_TO_ML[unit], unit: 'ml' };
    }
    // "each" (or anything else) can't be converted - just pass through
    return { quantity, unit };
}

// Converts a base-unit amount back into a friendly display format,
// e.g. 200g stays "200 g", but 1500g becomes "1.5 kg".
function formatQuantity(quantity, unit) {
    if (unit === 'g' && quantity >= 1000) {
        return { quantity: Math.round((quantity / 1000) * 100) / 100, unit: 'kg' };
    }
    if (unit === 'ml' && quantity >= 1000) {
        return { quantity: Math.round((quantity / 1000) * 100) / 100, unit: 'L' };
    }
    return { quantity: Math.round(quantity * 100) / 100, unit };
}

// -------------------------------------------------------------
// Compares one recipe's ingredients against the combined house
// inventory. Returns whether you can make it, and a detailed list
// of what's short and by how much.
// -------------------------------------------------------------
function checkRecipeAvailability(recipe, inventory) {
    const missing = [];

    recipe.ingredients.forEach(ing => {
        const needed = toBaseUnit(Number(ing.quantity), ing.unit);

        // Find a matching inventory item by name AND base unit -
        // if the units don't match (e.g. recipe wants "each" but
        // you only have it in grams), we can't compare them fairly,
        // so it's treated the same as having zero.
        const match = inventory.find(item =>
            item.name.toLowerCase() === ing.ingredient_name.toLowerCase() &&
            item.unit === needed.unit
        );

        const have = match ? Number(match.quantity) : 0;

        if (have < needed.quantity) {
            const shortfall = formatQuantity(needed.quantity - have, needed.unit);
            missing.push(`${ing.ingredient_name} (need ${shortfall.quantity} more ${shortfall.unit})`);
        }
    });

    return {
        canMake: missing.length === 0,
        missing: missing
    };
}

// -------------------------------------------------------------
// Adds one ingredient row to the form. Optionally pre-fills it
// with existing values - used both for a blank new row, and for
// filling in a recipe's existing ingredients when editing.
// -------------------------------------------------------------
function addIngredientRow(existing = null) {
    const row = document.createElement('div');
    row.classList.add('ingredient-row');

    const name = existing ? existing.ingredient_name : '';
    const quantity = existing ? existing.quantity : '';
    const unit = existing ? existing.unit : 'g';

    row.innerHTML = `
        <input type="text" class="ingredient-name" placeholder="Ingredient Name" value="${name}">
        <input type="number" class="ingredient-quantity" placeholder="Quantity" value="${quantity}">
        <select class="ingredient-unit">
            <option value="g">grams (g)</option>
            <option value="kg">kilograms (kg)</option>
            <option value="ml">millilitres (mL)</option>
            <option value="l">litres (L)</option>
            <option value="each">each</option>
        </select>
    `;

    row.querySelector('.ingredient-unit').value = unit;
    ingredientRowsContainer.appendChild(row);
}

addIngredientRow();
document.getElementById('add-ingredient-btn').addEventListener('click', () => addIngredientRow());

// -------------------------------------------------------------
// Loads BOTH recipes and the combined inventory before rendering,
// since each recipe card needs the inventory to check availability
// against. Promise.all runs both fetches at the same time rather
// than waiting for one to finish before starting the other.
// -------------------------------------------------------------
function loadEverything() {
    Promise.all([
        fetch(`${SERVER_URL}/recipes`).then(r => r.json()),
        fetch(`${SERVER_URL}/inventory-all`).then(r => r.json())
    ])
        .then(([recipes, inventory]) => {
            currentRecipes = recipes;
            currentInventory = inventory;
            renderRecipes(recipes);
        })
        .catch(error => {
            console.error('Could not load recipes/inventory from server:', error);
        });
}

// -------------------------------------------------------------
// Builds the on-page list of recipes, each showing its name,
// ingredients, instructions, an availability check, and
// Edit/Delete buttons.
// -------------------------------------------------------------
function renderRecipes(recipes) {
    recipeList.innerHTML = "";

    recipes.forEach(recipe => {
        const card = document.createElement('div');
        card.classList.add('recipe-card');

        const ingredientsHTML = recipe.ingredients
            .map(ing => `<li>${ing.ingredient_name} — ${ing.quantity} ${ing.unit}</li>`)
            .join('');

        const availability = checkRecipeAvailability(recipe, currentInventory);

        // Show a clear yes/no plus, if missing anything, a list of
        // exactly what and how much more is needed.
        const availabilityHTML = availability.canMake
            ? `<p class="can-make">✅ You can make this!</p>`
            : `<p class="cannot-make">❌ Missing:</p><ul class="missing-list">${
                  availability.missing.map(m => `<li>${m}</li>`).join('')
              }</ul>`;

        card.innerHTML = `
            <h3>${recipe.name}</h3>
            <ul>${ingredientsHTML}</ul>
            <p>${recipe.instructions}</p>
            ${availabilityHTML}
            <button type="button" class="edit-recipe-btn" data-id="${recipe.id}">Edit</button>
            <button type="button" class="delete-recipe-btn" data-id="${recipe.id}">Delete</button>
        `;

        recipeList.appendChild(card);
    });
}

loadEverything();

// -------------------------------------------------------------
// Fills the Add Recipe form with an existing recipe's data, and
// switches the page into "editing" mode.
// -------------------------------------------------------------
function startEditingRecipe(recipe) {
    editingRecipeId = recipe.id;

    recipeNameInput.value = recipe.name;
    recipeInstructionsInput.value = recipe.instructions;

    ingredientRowsContainer.innerHTML = "";
    recipe.ingredients.forEach(ing => addIngredientRow(ing));

    saveButton.textContent = "Update Recipe";
    recipeForm.scrollIntoView({ behavior: 'smooth' });
}

// -------------------------------------------------------------
// Resets the form back to "adding a new recipe" mode.
// -------------------------------------------------------------
function resetForm() {
    editingRecipeId = null;
    recipeForm.reset();
    ingredientRowsContainer.innerHTML = "";
    addIngredientRow();
    saveButton.textContent = "Save Recipe";
}

// -------------------------------------------------------------
// Handles submitting the form - either creating a new recipe
// (POST) or updating one being edited (PUT), depending on
// whether editingRecipeId is set.
// -------------------------------------------------------------
recipeForm.addEventListener('submit', function(event) {
    event.preventDefault();

    const name = recipeNameInput.value.trim();
    const instructions = recipeInstructionsInput.value.trim();

    const ingredientRows = document.querySelectorAll('.ingredient-row');
    const ingredients = [];

    ingredientRows.forEach(row => {
        const ingName = row.querySelector('.ingredient-name').value.trim();
        const quantity = row.querySelector('.ingredient-quantity').value.trim();
        const unit = row.querySelector('.ingredient-unit').value;

        if (ingName && quantity) {
            ingredients.push({
                name: ingName,
                quantity: Number(quantity),
                unit: unit
            });
        }
    });

    if (!name || !instructions || ingredients.length === 0) {
        alert("Please enter a recipe name, instructions, and at least one ingredient.");
        return;
    }

    const url = editingRecipeId
        ? `${SERVER_URL}/recipes/${editingRecipeId}`
        : `${SERVER_URL}/recipes`;
    const method = editingRecipeId ? 'PUT' : 'POST';

    fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, instructions, ingredients })
    })
        .then(response => response.json())
        .then(() => {
            resetForm();
            loadEverything();
        })
        .catch(error => {
            console.error('Could not save recipe:', error);
        });
});

// -------------------------------------------------------------
// Handles clicking any "Edit" or "Delete" button on a recipe card.
// We listen on the whole list (event delegation) rather than on
// each button individually, because the buttons are created
// dynamically by renderRecipes() and don't exist yet when this
// code first runs.
// -------------------------------------------------------------
recipeList.addEventListener('click', function(event) {

    if (event.target.classList.contains('edit-recipe-btn')) {
        const recipeId = event.target.dataset.id;
        const recipe = currentRecipes.find(r => r.id === recipeId);
        if (recipe) startEditingRecipe(recipe);
        return;
    }

    if (event.target.classList.contains('delete-recipe-btn')) {
        const recipeId = event.target.dataset.id;
        const isSure = confirm("Are you sure you want to delete this recipe?");
        if (!isSure) return;

        fetch(`${SERVER_URL}/recipes/${recipeId}`, { method: 'DELETE' })
            .then(response => response.json())
            .then(() => {
                if (editingRecipeId === recipeId) resetForm();
                loadEverything();
            })
            .catch(error => {
                console.error('Could not delete recipe:', error);
            });
    }
});