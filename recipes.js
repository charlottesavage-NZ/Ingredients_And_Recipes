// -------------------------------------------------------------
// This handles the Recipes page: adding, editing, and deleting
// recipes (each with any number of ingredients), displaying all
// saved recipes, checking each recipe against the combined house
// inventory to show what's missing, and letting household members
// vote like/dislike on each recipe.
// -------------------------------------------------------------

const SERVER_URL = '/recipes';

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

// Every known ingredient alias (e.g. "Diced Tomatoes In Juice" ->
// "Tinned Tomatoes"), used by checkRecipeAvailability() below so
// differently-worded names for the same thing still match.
let currentAliases = [];

// The same aliases as a quick lookup table - see buildAliasLookup().
let aliasLookup = new Map();

// Who's currently selected in the "Who's voting?" dropdown.
// Empty string means nobody's picked yet.
let currentPerson = '';

// The full list of household members, loaded from the server.
// Needed so we can show ALL of them on every recipe card, even
// the ones who haven't voted on that recipe yet.
let currentHouseholdMembers = [];

// Prevents the dropdown being rebuilt (and losing your selection)
// every time loadEverything() runs again after a vote.
let personDropdownPopulated = false;

// Same idea as personDropdownPopulated, but for the vote-filter
// dropdown's per-person options, which also only need to be built once.
let voteFilterPopulated = false;

// Current values of the three filter controls. Empty string means
// "not filtering on this one". All three combine together (AND) -
// see filterRecipes() below.
let currentVoteFilter = '';
let currentIngredientFilter = '';
let currentNameFilter = '';

// -------------------------------------------------------------
// Weight/volume conversion tables - same idea as script.js, but
// duplicated here since this is a separate page with its own
// script file. Used to convert a recipe's ingredient (which could
// be typed in kg or L) into the SAME base unit the pantry stores
// in (g or ml), so quantities can be fairly compared.
// -------------------------------------------------------------
const WEIGHT_UNITS_TO_GRAMS = { g: 1, kg: 1000 };
const VOLUME_UNITS_TO_ML = { ml: 1, l: 1000 };

// -------------------------------------------------------------
// "Spoon" measures. Nobody keeps track of how many tablespoons of
// oyster sauce are left in the bottle - the pantry just says you
// have a bottle. So for anything a recipe measures in teaspoons or
// tablespoons, we only check that you have SOME of it in the house
// (in any unit), rather than trying to compare amounts. These are
// also the amounts that should never be deducted automatically
// once "I made this" exists - see isSpoonMeasure() below.
// -------------------------------------------------------------
const SPOON_UNITS = ['tsp', 'tbsp'];

function isSpoonMeasure(unit) {
    return SPOON_UNITS.includes(unit);
}

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
// Makes typed text safe to drop into an HTML string. Without this,
// a recipe or ingredient name containing a quote mark or a < sign
// (e.g. Mum's "Famous" Pie) could break the page layout, or cut
// off the value shown in an Edit box half-way through.
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
// Looks up a name in the alias list and returns its canonical
// name if one exists (e.g. "Beef Mince" -> "Mince"), otherwise
// just returns the name unchanged. Used by checkRecipeAvailability
// below so a recipe and the pantry can be worded completely
// differently and still be recognised as the same ingredient.
// -------------------------------------------------------------
function resolveIngredientName(name, aliases) {
    const match = aliases.get(name.toLowerCase());
    return match !== undefined ? match : name;
}

// -------------------------------------------------------------
// Turns the alias list into a lookup table (lowercase alias ->
// canonical name), so resolveIngredientName() above can find a
// match in one step instead of searching the whole alias list
// every time. Built once each time the data loads, rather than
// re-searching for every ingredient of every recipe on every
// keystroke in the filter boxes.
// -------------------------------------------------------------
function buildAliasLookup(aliases) {
    const lookup = new Map();
    aliases.forEach(a => {
        const key = a.alias.toLowerCase();
        // Keep the FIRST one if an alias is ever listed twice -
        // same result the old one-by-one search used to give.
        if (!lookup.has(key)) lookup.set(key, a.canonical_name);
    });
    return lookup;
}

// -------------------------------------------------------------
// Compares one recipe's ingredients against the combined house
// inventory. Returns whether you can make it, and a detailed list
// of what's short and by how much.
// -------------------------------------------------------------
function checkRecipeAvailability(recipe, inventory, aliases) {
    const missing = [];

    recipe.ingredients.forEach(ing => {
        const needed = toBaseUnit(Number(ing.quantity), ing.unit);

        // Resolve the recipe's ingredient name to its canonical form
        // first (e.g. "Beef Mince" -> "Mince"), so it's compared on
        // equal footing with whatever's actually in the pantry.
        const neededCanonicalName = resolveIngredientName(ing.ingredient_name, aliases);

        // Find a matching inventory item by CANONICAL name and base
        // unit - each pantry item also gets resolved through the
        // alias list, so "Diced Tomatoes In Juice" in the pantry
        // correctly matches a recipe asking for "Tinned Tomatoes".
        // If the units don't match (e.g. recipe wants "each" but you
        // only have it in grams), we can't compare them fairly, so
        // it's treated the same as having zero.
        const neededCanonicalKey = neededCanonicalName.toLowerCase();

        // Teaspoons/tablespoons: all that matters is whether you have
        // ANY of it, in any unit (e.g. a 500ml bottle covers "2 tbsp").
        // Only counts as missing if there's none in the house at all.
        if (isSpoonMeasure(ing.unit)) {
            const haveSome = inventory.some(item =>
                item.canonicalKey === neededCanonicalKey && Number(item.quantity) > 0
            );
            if (!haveSome) {
                missing.push(`${ing.ingredient_name} (none in the house)`);
            }
            return;
        }

        const match = inventory.find(item => {
            // canonicalKey is worked out once per pantry item when the
            // data loads (see loadEverything), not once per check.
            return item.canonicalKey === neededCanonicalKey &&
                item.unit === needed.unit;
        });

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
// Loads every known item name and fills the shared <datalist>,
// so ingredient name boxes suggest names already used in the
// pantry or other recipes.
// -------------------------------------------------------------
function loadItemNameSuggestions() {
    fetch(`${SERVER_URL}/item-names`)
        .then(response => response.json())
        .then(names => {
            const datalist = document.getElementById('ingredient-names-list');
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
// Fills the "Who's voting?" dropdown with the household members
// from the server. Only runs once (personDropdownPopulated guards
// against it), so re-loading data after a vote doesn't wipe out
// whichever name you currently have selected.
// -------------------------------------------------------------
function populatePersonDropdown(people) {
    if (personDropdownPopulated) return;

    const select = document.getElementById('person-select');
    people.forEach(person => {
        const option = document.createElement('option');
        option.value = person;
        option.textContent = person;
        select.appendChild(option);
    });

    personDropdownPopulated = true;
}

document.getElementById('person-select').addEventListener('change', function(event) {
    currentPerson = event.target.value;
});

// -------------------------------------------------------------
// Fills the vote-filter dropdown with a "likes" and "dislikes"
// option for every household member, added after the fixed "All
// recipes" / "Everyone likes" / "Everyone dislikes" options that
// already sit in the HTML. Only runs once, same reasoning as
// populatePersonDropdown above.
// -------------------------------------------------------------
function populateVoteFilterOptions(people) {
    if (voteFilterPopulated) return;

    const select = document.getElementById('vote-filter');
    people.forEach(person => {
        const likeOption = document.createElement('option');
        likeOption.value = `${person}|like`;
        likeOption.textContent = `${person} likes`;
        select.appendChild(likeOption);

        const dislikeOption = document.createElement('option');
        dislikeOption.value = `${person}|dislike`;
        dislikeOption.textContent = `${person} dislikes`;
        select.appendChild(dislikeOption);
    });

    voteFilterPopulated = true;
}

// -------------------------------------------------------------
// Checks one recipe against the vote-filter dropdown's current
// value. Handles four kinds of value:
// - ""                  -> no filter, everything passes
// - "everyone-likes"    -> every household member's vote is "like"
// - "everyone-dislikes" -> every household member's vote is "dislike"
// - "Todd|like" etc.    -> that one specific person voted that way
// -------------------------------------------------------------
function matchesVoteFilter(recipe) {
    if (!currentVoteFilter) return true;

    if (currentVoteFilter === 'everyone-likes') {
        return currentHouseholdMembers.every(person =>
            recipe.votes.some(v => v.person === person && v.vote === 'like')
        );
    }

    if (currentVoteFilter === 'everyone-dislikes') {
        return currentHouseholdMembers.every(person =>
            recipe.votes.some(v => v.person === person && v.vote === 'dislike')
        );
    }

    // Any other value is "Person|vote", e.g. "Todd|like"
    const [person, vote] = currentVoteFilter.split('|');
    return recipe.votes.some(v => v.person === person && v.vote === vote);
}

// -------------------------------------------------------------
// Checks one recipe against the ingredient-filter text box.
// Matches if ANY of the recipe's ingredient names contain the
// typed text (case-insensitive, partial match) - so typing "mince"
// finds recipes using "Beef Mince" or "Lamb Mince".
// -------------------------------------------------------------
function matchesIngredientFilter(recipe) {
    if (!currentIngredientFilter) return true;

    const search = currentIngredientFilter.toLowerCase();
    return recipe.ingredients.some(ing =>
        ing.ingredient_name.toLowerCase().includes(search)
    );
}

// -------------------------------------------------------------
// Checks one recipe against the recipe-name-filter text box.
// Same partial, case-insensitive match as the ingredient filter.
// -------------------------------------------------------------
function matchesNameFilter(recipe) {
    if (!currentNameFilter) return true;
    return recipe.name.toLowerCase().includes(currentNameFilter.toLowerCase());
}

// -------------------------------------------------------------
// Applies all three filters together (AND) to a list of recipes.
// A recipe only shows up if it passes every filter that's
// currently set - any filter left blank/default is skipped.
// -------------------------------------------------------------
function filterRecipes(recipes) {
    return recipes.filter(recipe =>
        matchesVoteFilter(recipe) &&
        matchesIngredientFilter(recipe) &&
        matchesNameFilter(recipe)
    );
}

// Re-render using the currently loaded recipes whenever a filter
// control changes - no need to re-fetch from the server, since
// filtering only affects what's DISPLAYED, not what's stored.
document.getElementById('vote-filter').addEventListener('change', function(event) {
    currentVoteFilter = event.target.value;
    renderRecipes(filterRecipes(currentRecipes));
});

document.getElementById('ingredient-filter').addEventListener('input', function(event) {
    currentIngredientFilter = event.target.value.trim();
    renderRecipes(filterRecipes(currentRecipes));
});

document.getElementById('name-filter').addEventListener('input', function(event) {
    currentNameFilter = event.target.value.trim();
    renderRecipes(filterRecipes(currentRecipes));
});

// Resets all three filter controls and re-renders the full list.
document.getElementById('clear-filters-btn').addEventListener('click', function() {
    currentVoteFilter = '';
    currentIngredientFilter = '';
    currentNameFilter = '';

    document.getElementById('vote-filter').value = '';
    document.getElementById('ingredient-filter').value = '';
    document.getElementById('name-filter').value = '';

    renderRecipes(filterRecipes(currentRecipes));
});

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
        <input type="text" class="ingredient-name" placeholder="Ingredient Name" value="${escapeHtml(name)}" list="ingredient-names-list">
        <input type="number" class="ingredient-quantity" placeholder="Quantity" value="${escapeHtml(quantity)}">
        <select class="ingredient-unit">
            <option value="g">grams (g)</option>
            <option value="kg">kilograms (kg)</option>
            <option value="ml">millilitres (mL)</option>
            <option value="l">litres (L)</option>
            <option value="tsp">Teaspoons (tsp)</option>
            <option value="tbsp">Tablespoons (tbsp)</option>
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
// UPLOAD A RECIPE FROM A TEXT FILE
// Lets you skip typing everything by hand. Write (or paste, or
// get an AI to reformat for you) a recipe into a plain .txt file
// using this exact layout, then upload it here:
//
//   Title: Spaghetti Bolognese
//   Ingredients:
//   Beef mince, 500, g
//   Tinned tomatoes, 400, g
//   Onion, 1, each
//   Instructions:
//   Brown the mince in a pan.
//   Add onion and cook until soft.
//
// This ONLY fills in the form below - it doesn't save anything by
// itself. You still need to look it over and click "Save Recipe"
// (or "Update Recipe"), exactly as if you'd typed it in yourself.
// -------------------------------------------------------------
const recipeFileInput = document.getElementById('recipe-file-input');

recipeFileInput.addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (!file) return;

    // FileReader reads the file's contents in the background, then
    // fires "load" once the whole file is available as text.
    const reader = new FileReader();

    reader.onload = function(loadEvent) {
        const fileText = loadEvent.target.result;
        const parsed = parseRecipeFile(fileText);

        if (!parsed) {
            alert("Could not read that file. Make sure it has Title:, Ingredients:, and Instructions: sections, in that order.");
            return;
        }

        fillFormFromParsedRecipe(parsed);

        // Clear the file input so uploading the SAME file again later
        // (e.g. after fixing a typo in it) still fires "change".
        recipeFileInput.value = '';
    };

    reader.readAsText(file);
});

// -------------------------------------------------------------
// Turns the raw text of an uploaded file into a plain object:
// { name, instructions, ingredients: [{ ingredient_name, quantity, unit }] }
// Returns null if the file doesn't have the sections we expect, in
// the order we expect them.
// -------------------------------------------------------------
function parseRecipeFile(fileText) {
    const lines = fileText.split('\n').map(line => line.trim());

    const titleLineIndex = lines.findIndex(line => line.toLowerCase().startsWith('title:'));
    const ingredientsLineIndex = lines.findIndex(line => line.toLowerCase().startsWith('ingredients:'));
    const instructionsLineIndex = lines.findIndex(line => line.toLowerCase().startsWith('instructions:'));

    // If any section is missing, or they're not in Title ->
    // Ingredients -> Instructions order, we can't reliably parse it.
    if (titleLineIndex === -1 || ingredientsLineIndex === -1 || instructionsLineIndex === -1) {
        return null;
    }
    if (ingredientsLineIndex < titleLineIndex || instructionsLineIndex < ingredientsLineIndex) {
        return null;
    }

    // The recipe name is whatever comes after "Title:" on that line.
    const name = lines[titleLineIndex].slice('title:'.length).trim();

    // Ingredient lines sit between "Ingredients:" and "Instructions:".
    // Each one looks like "Name, quantity, unit" - split by comma,
    // same layout as the ingredient rows in the form.
    const ingredientLines = lines
        .slice(ingredientsLineIndex + 1, instructionsLineIndex)
        .filter(line => line.length > 0);

    const ingredients = ingredientLines.map(line => {
        const [ingName, quantity, unit] = line.split(',').map(part => part.trim());
        return {
            ingredient_name: ingName || '',
            quantity: quantity || '',
            unit: (unit || 'g').toLowerCase()
        };
    });

    // Everything after "Instructions:" is the method. Keep the line
    // breaks (joined back with \n) so paragraph structure carries
    // over into the textarea, instead of squashing it into one line.
    const instructions = lines
        .slice(instructionsLineIndex + 1)
        .join('\n')
        .trim();

    return { name, instructions, ingredients };
}

// -------------------------------------------------------------
// Fills the Add Recipe form with a parsed recipe, replacing
// whatever ingredient rows are currently there. This does NOT
// save anything - it just gets the form ready for you to check
// over and click "Save Recipe" yourself.
// -------------------------------------------------------------
function fillFormFromParsedRecipe(parsed) {
    recipeNameInput.value = parsed.name;
    recipeInstructionsInput.value = parsed.instructions;

    ingredientRowsContainer.innerHTML = "";

    if (parsed.ingredients.length === 0) {
        // Always leave at least one row, same as resetForm() does.
        addIngredientRow();
    } else {
        parsed.ingredients.forEach(ing => addIngredientRow(ing));
    }
}

// -------------------------------------------------------------
// Loads recipes, the combined inventory, AND the household member
// list before rendering, since each recipe card needs all three.
// Promise.all runs all three fetches at the same time rather than
// waiting for one to finish before starting the next.
// -------------------------------------------------------------
function loadEverything() {
    Promise.all([
        fetch(`${SERVER_URL}/recipes`).then(r => r.json()),
        fetch(`${SERVER_URL}/inventory-all`).then(r => r.json()),
        fetch(`${SERVER_URL}/household-members`).then(r => r.json()),
        fetch(`${SERVER_URL}/ingredient-aliases`).then(r => r.json())
    ])
        .then(([recipes, inventory, people, aliases]) => {
            currentRecipes = recipes;
            currentHouseholdMembers = people;
            currentAliases = aliases;
            aliasLookup = buildAliasLookup(aliases);

            // Work out each pantry item's canonical name ONCE here,
            // so checkRecipeAvailability() doesn't have to redo it
            // for every ingredient of every recipe on every re-render.
            currentInventory = inventory.map(item => ({
                ...item,
                canonicalKey: resolveIngredientName(item.name, aliasLookup).toLowerCase()
            }));
            populatePersonDropdown(people);
            populateVoteFilterOptions(people);

            // currentRecipes always holds the FULL list (needed for
            // vote/edit/delete lookups elsewhere), but we only ever
            // display the filtered subset.
            renderRecipes(filterRecipes(recipes));
        })
        .catch(error => {
            console.error('Could not load recipes/inventory/household members from server:', error);
        });
}

// -------------------------------------------------------------
// Builds the HTML for one recipe's voting section: every household
// member's current vote (or "no vote" if they haven't), plus
// Like/Dislike buttons to cast or change your own vote.
// -------------------------------------------------------------
function renderVotes(recipe) {
    const voteEmojis = { like: '👍', dislike: '👎' };

    const voteListHTML = currentHouseholdMembers.map(person => {
        const personVote = recipe.votes.find(v => v.person === person);
        const display = personVote ? voteEmojis[personVote.vote] : 'no vote';
        return `<li>${escapeHtml(person)}: ${display}</li>`;
    }).join('');

    return `
        <div class="vote-section">
            <ul class="vote-list">${voteListHTML}</ul>
            <button type="button" class="vote-btn" data-id="${recipe.id}" data-vote="like">👍 Like</button>
            <button type="button" class="vote-btn" data-id="${recipe.id}" data-vote="dislike">👎 Dislike</button>
        </div>
    `;
}

// -------------------------------------------------------------
// Splits a block of text into separate sentences. It splits after
// a . ! or ? that's followed by a space and then a capital letter,
// so "Preheat to 200c. Cook the onion" splits into two, but
// "about 1.5 cups" or "approx. 5 mins" stays in one piece.
// -------------------------------------------------------------
function splitIntoSentences(text) {
    return text.split(/(?<=[.!?])\s+(?=[A-Z])/);
}

// -------------------------------------------------------------
// Turns a recipe's instructions into a numbered list of steps,
// instead of one big wall of text:
// - Each line typed into the Instructions box becomes its own
//   numbered step (pressing Enter = starting a new step).
// - Inside a step, every sentence starts on a new line, so long
//   steps are easy to scan while you're cooking.
// - If the whole method was typed as ONE line, there's nothing to
//   split steps on, so each sentence becomes its own step instead.
// This only changes how it LOOKS - the saved text isn't touched.
// -------------------------------------------------------------
function renderInstructions(instructions) {
    const lines = instructions
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const steps = lines.length === 1 ? splitIntoSentences(lines[0]) : lines;

    const stepsHTML = steps.map(step => {
        const sentencesHTML = splitIntoSentences(step)
            .map(sentence => `<span class="instruction-sentence">${escapeHtml(sentence)}</span>`)
            .join('');
        return `<li>${sentencesHTML}</li>`;
    }).join('');

    return `<ol class="instructions-list">${stepsHTML}</ol>`;
}

// -------------------------------------------------------------
// Builds the on-page list of recipes, each showing its name,
// ingredients, instructions, an availability check, votes, and
// Edit/Delete buttons.
// -------------------------------------------------------------
function renderRecipes(recipes) {
    recipeList.innerHTML = "";

    recipes.forEach(recipe => {
        const card = document.createElement('div');
        card.classList.add('recipe-card');

        // Turn the ingredients array into a simple bullet list of text
        const ingredientsHTML = recipe.ingredients
            .map(ing => `<li>${escapeHtml(ing.ingredient_name)} — ${escapeHtml(ing.quantity)} ${escapeHtml(ing.unit)}</li>`)
            .join('');

        const availability = checkRecipeAvailability(recipe, currentInventory, aliasLookup);

        // Show a clear yes/no plus, if missing anything, a list of
        // exactly what and how much more is needed.
        // The missing list starts folded away (a <details> box) to keep
        // the page tidy - click "Missing (X items)" to open it up.
        const missingCount = availability.missing.length;
        const availabilityHTML = availability.canMake
            ? `<p class="can-make">✅ You can make this!</p>`
            : `<details class="missing-details">
                   <summary class="cannot-make">❌ Missing (${missingCount} item${missingCount === 1 ? '' : 's'})</summary>
                   <ul class="missing-list">${
                       availability.missing.map(m => `<li>${escapeHtml(m)}</li>`).join('')
                   }</ul>
               </details>`;

        // data-id stores the recipe's id directly on each button, so
        // when clicked we know exactly which recipe it refers to.
        card.innerHTML = `
            <h3>${escapeHtml(recipe.name)}</h3>
            <ul>${ingredientsHTML}</ul>
            ${renderInstructions(recipe.instructions)}
            ${availabilityHTML}
            ${renderVotes(recipe)}
            <button type="button" class="made-recipe-btn" data-id="${recipe.id}">🍳 I made this</button>
            <button type="button" class="edit-recipe-btn" data-id="${recipe.id}">Edit</button>
            <button type="button" class="delete-recipe-btn" data-id="${recipe.id}">Delete</button>
        `;

        recipeList.appendChild(card);
    });
}

// Load existing recipes (and inventory, and household members) as
// soon as the page opens
loadEverything();

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

    // Gather every ingredient row into a plain array of objects.
    // Rows left blank (no name typed) are skipped, so clicking
    // "+ Add Ingredient" without filling it in doesn't save junk data.
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
            loadEverything();
        })
        .catch(error => {
            console.error('Could not save recipe:', error);
        });
});

// -------------------------------------------------------------
// Friendly names for each storage area, used in the "I made this"
// confirmation message (e.g. "from the Chest Freezer").
// -------------------------------------------------------------
const SECTION_LABELS = {
    fridge: 'Fridge',
    pantry: 'Pantry',
    freezer: 'Freezer (Inside)',
    chest: 'Chest Freezer'
};

// Shows an amount nicely, e.g. 1500 + "g" -> "1.5 kg".
function describeAmount(quantity, unit) {
    const nice = formatQuantity(Number(quantity), unit);
    return `${nice.quantity} ${nice.unit}`;
}

// -------------------------------------------------------------
// Turns the server's plan (see planRecipeDeduction() in server.js)
// into the plain-text message shown in the Confirm/Cancel box:
// what will be taken and from where, anything there isn't enough
// of, and anything that's deliberately left alone.
// -------------------------------------------------------------
function describeDeductionPlan(plan) {
    const removing = [];
    const short = [];

    plan.deductions.forEach(d => {
        d.taken.forEach(t => {
            // Only mention the stored name if it's worded differently
            // from the recipe (e.g. recipe says "Beef mince", the
            // fridge says "Mince"), so it's clear what's being used.
            const storedAs = t.item.toLowerCase() === d.ingredient.toLowerCase() ? '' : ` ("${t.item}")`;
            removing.push(`• ${d.ingredient}${storedAs}: ${describeAmount(t.quantity, t.unit)} from the ${SECTION_LABELS[t.section]}`);
        });

        if (d.short > 0) {
            const note = d.taken.length > 0 ? 'using up all you have' : 'none in the house';
            short.push(`• ${d.ingredient}: ${describeAmount(d.short, d.unit)} short (${note})`);
        }
    });

    const leftAlone = plan.skipped.map(s =>
        s.reason === 'spoon'
            ? `• ${s.ingredient} (tsp/tbsp - remove it yourself when it runs out)`
            : `• ${s.ingredient} (less than one whole)`
    );

    const parts = [`Mark "${plan.recipe}" as made?`];
    if (removing.length) parts.push('This will remove:\n' + removing.join('\n'));
    if (short.length) parts.push('Not enough in the house:\n' + short.join('\n'));
    if (leftAlone.length) parts.push('Not removed:\n' + leftAlone.join('\n'));

    return { message: parts.join('\n\n'), anythingToRemove: removing.length > 0 };
}

// -------------------------------------------------------------
// "I made this": first asks the server for a PREVIEW of what would
// be taken out of stock (nothing is changed yet), shows it in a
// Confirm/Cancel box, and only if you click OK asks the server to
// actually take it out. A mis-click can't empty the pantry.
// -------------------------------------------------------------
function markRecipeAsMade(recipeId) {
    const url = `${SERVER_URL}/recipes/${recipeId}/made`;
    const send = isConfirmed => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: isConfirmed })
    }).then(response => {
        if (!response.ok) throw new Error('Server said ' + response.status);
        return response.json();
    });

    send(false)
        .then(preview => {
            const { message, anythingToRemove } = describeDeductionPlan(preview);

            if (!anythingToRemove) {
                alert(message + '\n\nThere\'s nothing in the house to take out for this recipe, so nothing was changed.');
                return;
            }

            if (!confirm(message)) return;

            return send(true).then(() => loadEverything());
        })
        .catch(error => {
            console.error('Could not mark recipe as made:', error);
            alert('Something went wrong - nothing was taken out of stock. Try again in a moment.');
        });
}

// -------------------------------------------------------------
// Handles clicking any Vote, Edit, or Delete button on a recipe
// card. We listen on the whole list (event delegation) rather
// than on each button individually, because the buttons are
// created dynamically by renderRecipes() and don't exist yet
// when this code first runs.
// -------------------------------------------------------------
recipeList.addEventListener('click', function(event) {

    if (event.target.classList.contains('vote-btn')) {
        if (!currentPerson) {
            alert("Please select who you are from the dropdown before voting.");
            return;
        }

        const recipeId = event.target.dataset.id;
        const vote = event.target.dataset.vote;

        fetch(`${SERVER_URL}/recipes/${recipeId}/votes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person: currentPerson, vote })
        })
            .then(response => response.json())
            .then(() => {
                loadEverything();
            })
            .catch(error => {
                console.error('Could not save vote:', error);
            });
        return;
    }

    if (event.target.classList.contains('made-recipe-btn')) {
        markRecipeAsMade(event.target.dataset.id);
        return;
    }

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
                loadEverything();
            })
            .catch(error => {
                console.error('Could not delete recipe:', error);
            });
    }
});