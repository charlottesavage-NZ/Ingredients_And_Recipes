// -------------------------------------------------------------
// This handles the Recipes page: adding, editing, and deleting
// recipes (each with any number of ingredients), and displaying
// all saved recipes. Talks to the same server.js as the inventory
// page, but uses the /recipes route instead of /pantry, /fridge, etc.
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

// Keeps a local copy of the last-loaded recipes, so when someone
// clicks Edit we can look up that recipe's full data without
// asking the server for it again.
let currentRecipes = [];

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

    // Set the dropdown to match the existing unit, since you can't
    // do this through the HTML string above the way you can with
    // a plain input's value.
    row.querySelector('.ingredient-unit').value = unit;

    ingredientRowsContainer.appendChild(row);
}

// Start with one empty ingredient row so the form isn't blank
addIngredientRow();

// Clicking "+ Add Ingredient" just adds another blank row
document.getElementById('add-ingredient-btn').addEventListener('click', () => addIngredientRow());

// -------------------------------------------------------------
// Asks the server for all saved recipes and renders them.
// -------------------------------------------------------------
function loadRecipes() {
    fetch(`${SERVER_URL}/recipes`)
        .then(response => response.json())
        .then(recipes => {
            currentRecipes = recipes;
            renderRecipes(recipes);
        })
        .catch(error => {
            console.error('Could not load recipes from server:', error);
        });
}

// -------------------------------------------------------------
// Builds the on-page list of recipes, each showing its name,
// ingredients, instructions, and Edit/Delete buttons.
// -------------------------------------------------------------
function renderRecipes(recipes) {
    recipeList.innerHTML = "";

    recipes.forEach(recipe => {
        const card = document.createElement('div');
        card.classList.add('recipe-card');

        const ingredientsHTML = recipe.ingredients
            .map(ing => `<li>${ing.ingredient_name} — ${ing.quantity} ${ing.unit}</li>`)
            .join('');

        // data-id stores the recipe's id directly on each button, so
        // when clicked we know exactly which recipe it refers to.
        card.innerHTML = `
            <h3>${recipe.name}</h3>
            <ul>${ingredientsHTML}</ul>
            <p>${recipe.instructions}</p>
            <button type="button" class="edit-recipe-btn" data-id="${recipe.id}">Edit</button>
            <button type="button" class="delete-recipe-btn" data-id="${recipe.id}">Delete</button>
        `;

        recipeList.appendChild(card);
    });
}

// Load existing recipes as soon as the page opens
loadRecipes();

// -------------------------------------------------------------
// Fills the Add Recipe form with an existing recipe's data, and
// switches the page into "editing" mode.
// -------------------------------------------------------------
function startEditingRecipe(recipe) {
    editingRecipeId = recipe.id;

    recipeNameInput.value = recipe.name;
    recipeInstructionsInput.value = recipe.instructions;

    // Clear the current ingredient rows and rebuild them from
    // this recipe's saved ingredients.
    ingredientRowsContainer.innerHTML = "";
    recipe.ingredients.forEach(ing => addIngredientRow(ing));

    // Relabel the button so it's clear you're updating, not adding
    saveButton.textContent = "Update Recipe";

    // Scroll up so the now-filled form is visible, since it might
    // be off-screen if you clicked Edit further down the page.
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

    // Decide whether we're creating a new recipe or updating one,
    // based on whether editingRecipeId was set by clicking Edit.
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
            loadRecipes();
        })
        .catch(error => {
            console.error('Could not save recipe:', error);
        });
});

// -------------------------------------------------------------
// Handles clicking any "Edit" or "Delete" button on a recipe
// card. We listen on the whole list (event delegation) rather
// than on each button individually, because the buttons are
// created dynamically by renderRecipes() and don't exist yet
// when this code first runs.
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
                // If you were editing the recipe you just deleted,
                // reset the form so it doesn't try to "update"
                // something that no longer exists.
                if (editingRecipeId === recipeId) resetForm();
                loadRecipes();
            })
            .catch(error => {
                console.error('Could not delete recipe:', error);
            });
    }
});