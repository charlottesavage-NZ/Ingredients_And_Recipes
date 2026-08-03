// -------------------------------------------------------------
// This is our local server. It runs on your laptop and acts like
// a mini version of what AWS will eventually do - it reads and
// writes CSV files ("pretend spreadsheets") for each storage area,
// and the browser talks to it using fetch().
// -------------------------------------------------------------

const http = require('http');
const fs = require('fs');

const PORT = 3000;

// -------------------------------------------------------------
// This maps each section name to its own CSV file on disk.
// Each storage area (pantry, fridge, freezer, chest) gets its
// own "table" - just a separate file for now.
// -------------------------------------------------------------
const csvFiles = {
    pantry: 'pantry.csv',
    fridge: 'fridge.csv',
    freezer: 'freezer.csv',
    chest: 'chest.csv'
};

// -------------------------------------------------------------
// Recipes are stored across two linked files:
// - recipes.csv holds the recipe itself (id, name, instructions)
// - recipe_ingredients.csv holds each ingredient, linked back to
//   its recipe via recipe_id
// This is separate from csvFiles because recipes have a different
// shape (a recipe has MANY ingredients) than pantry items.
// -------------------------------------------------------------
const RECIPES_FILE = 'recipes.csv';
const RECIPE_INGREDIENTS_FILE = 'recipe_ingredients.csv';
const RECIPE_VOTES_FILE = 'recipe_votes.csv';

const HOUSEHOLD_MEMBERS = ['Charlotte', 'Todd', 'Kayleigh'];

// -------------------------------------------------------------
// A curated baseline of common grocery items with CORRECT
// spelling. This exists so the dropdown always has trustworthy
// suggestions available, even before you've typed anything
// yourself - meaning the right spelling shows up as you type,
// rather than only appearing after you've already used it once.
// Feel free to add more items here any time you notice something
// missing.
// -------------------------------------------------------------
const COMMON_GROCERY_ITEMS = [
    'Tinned Tomatoes', 'Pasta Sauce', 'Tomato Paste',
    'Mince', 'Chicken Breast', 'Chicken Thigh', 'Bacon', 'Sausages',
    'Pasta', 'Rice', 'Flour', 'Sugar', 'Salt', 'Pepper',
    'Milk', 'Butter', 'Cheese', 'Eggs', 'Yoghurt', 'Cream',
    'Onion', 'Garlic', 'Potato', 'Carrot', 'Broccoli', 'Capsicum',
    'Olive Oil', 'Vegetable Oil', 'Soy Sauce', 'Stock', 'Baked Beans',
    'Bread', 'Butter Beans', 'Chickpeas', 'Lentils', 'Tuna', 'Salmon',
    'Gluten Free Pasta', 'Gluten Free Bread'
];

// -------------------------------------------------------------
// Weight unit conversion. Everything gets converted to grams
// before it's merged/stored, so the existing merge logic below
// (which matches by unit) doesn't need to change at all.
// -------------------------------------------------------------
const WEIGHT_UNITS_TO_GRAMS = {
    g: 1,
    kg: 1000
};

// Checks if a unit is a weight unit we know how to convert
function isWeightUnit(unit) {
    return unit in WEIGHT_UNITS_TO_GRAMS;
}

// Converts a quantity into grams
function toGrams(quantity, unit) {
    return quantity * WEIGHT_UNITS_TO_GRAMS[unit];
}

// -------------------------------------------------------------
// Volume unit conversion. Same idea as weight - everything gets
// converted to millilitres before it's merged/stored.
// -------------------------------------------------------------
const VOLUME_UNITS_TO_ML = {
    ml: 1,
    l: 1000
};

// Checks if a unit is a volume unit we know how to convert
function isVolumeUnit(unit) {
    return unit in VOLUME_UNITS_TO_ML;
}

// Converts a quantity into millilitres
function toMilliliters(quantity, unit) {
    return quantity * VOLUME_UNITS_TO_ML[unit];
}

// -------------------------------------------------------------
// Turns raw CSV text into an array of rows, where each row is
// an array of field values. This reads the WHOLE file as one
// stream of characters (not split into lines first), so a real
// line-break typed inside a quoted field (like pressing Enter
// in the Instructions box) is treated as part of that field's
// text, not as the start of a new row.
// -------------------------------------------------------------
function parseCSVRows(csvText) {
    const rows = [];
    let row = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];

        if (char === '"') {
            if (insideQuotes && csvText[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            row.push(current);
            current = '';
        } else if ((char === '\n' || char === '\r') && !insideQuotes) {
            // Only end the row on a line-break that's OUTSIDE quotes.
            // Windows files use \r\n, so skip a lone \r and act on \n.
            if (char === '\r') continue;
            row.push(current);
            rows.push(row);
            row = [];
            current = '';
        } else {
            current += char;
        }
    }

    // Catch the very last field/row if the file doesn't end with
    // a trailing newline.
    if (current.length > 0 || row.length > 0) {
        row.push(current);
        rows.push(row);
    }

    return rows;
}

// -------------------------------------------------------------
// Turns raw CSV text into an array of objects.
// -------------------------------------------------------------
function parseCSV(csvText) {
    const rows = parseCSVRows(csvText.trim());
    if (rows.length === 0) return [];

    const headers = rows[0];

    return rows.slice(1).map(values => {
        const item = {};
        headers.forEach((header, index) => {
            item[header.trim()] = (values[index] || '').trim();
        });
        return item;
    });
}

// -------------------------------------------------------------
// Wraps a value in quotes if it contains a comma, quote, or line
// break - otherwise commas inside the text would be mistaken for
// column separators when the file is read back later.
// -------------------------------------------------------------
function csvField(value) {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// -------------------------------------------------------------
// Turns an array of objects back into CSV text, ready to save
// to disk. This is the reverse of parseCSV.
// -------------------------------------------------------------
function stringifyCSV(items) {
    const header = 'name,quantity,unit';
    const rows = items.map(item =>
        [item.name, item.quantity, item.unit].map(csvField).join(',')
    );
    return [header, ...rows].join('\n') + '\n';
}

// -------------------------------------------------------------
// A generic version of stringifyCSV that works for any headers,
// not just name/quantity/unit. We need this because recipes.csv
// and recipe_ingredients.csv have different columns.
// -------------------------------------------------------------
function stringifyGenericCSV(headers, items) {
    const headerRow = headers.join(',');
    const rows = items.map(item =>
        headers.map(header => csvField(item[header])).join(',')
    );
    return [headerRow, ...rows].join('\n') + '\n';
}

// Reads a section's CSV file and hands back the parsed items.
function readItems(section, callback) {
    fs.readFile(csvFiles[section], 'utf8', (err, data) => {
        if (err) return callback(err, null);
        callback(null, parseCSV(data));
    });
}

// Saves an array of items back to a section's CSV file.
function saveItems(section, items, callback) {
    fs.writeFile(csvFiles[section], stringifyCSV(items), 'utf8', callback);
}

// -------------------------------------------------------------
// Reads recipes.csv and recipe_ingredients.csv, then combines them
// so each recipe object has its own list of ingredients attached.
// -------------------------------------------------------------
function readRecipes(callback) {
    fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
        if (err) return callback(err, null);

        fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
            if (err) return callback(err, null);

            fs.readFile(RECIPE_VOTES_FILE, 'utf8', (err, votesData) => {
                if (err) return callback(err, null);

                const recipes = parseCSV(recipesData);
                const ingredients = parseCSV(ingredientsData);
                const votes = parseCSV(votesData);

                // Attach each recipe's own ingredients AND votes by
                // matching recipe_id, same pattern as before.
                const recipesWithExtras = recipes.map(recipe => ({
                    ...recipe,
                    ingredients: ingredients.filter(ing => ing.recipe_id === recipe.id),
                    votes: votes.filter(v => v.recipe_id === recipe.id)
                }));

                callback(null, recipesWithExtras);
            });
        });
    });
}

// -------------------------------------------------------------
// Reads all four inventory sections (pantry, fridge, freezer,
// chest) and combines them into ONE list. This is needed because
// a recipe doesn't care which section an ingredient lives in -
// it just needs to know the total amount you have anywhere in
// the house. Items with the same name+unit across different
// sections get added together.
// -------------------------------------------------------------
function readAllInventory(callback) {
    const sections = Object.keys(csvFiles);
    let combined = [];
    let completed = 0;
    let hadError = false;

    sections.forEach(section => {
        fs.readFile(csvFiles[section], 'utf8', (err, data) => {
            if (hadError) return;
            if (err) {
                hadError = true;
                return callback(err, null);
            }

            combined = combined.concat(parseCSV(data));
            completed++;

            // Only combine everything once ALL four files have
            // finished reading (they're async, so this stops us
            // returning early with only some sections loaded).
            if (completed === sections.length) {
                const merged = {};

                combined.forEach(item => {
                    const key = item.name.toLowerCase() + '|' + item.unit;
                    if (!merged[key]) {
                        merged[key] = { name: item.name, unit: item.unit, quantity: 0 };
                    }
                    merged[key].quantity += Number(item.quantity);
                });

                callback(null, Object.values(merged));
            }
        });
    });
}

// -------------------------------------------------------------
// Gathers every item name the system should suggest: the curated
// baseline list PLUS every name already used in inventory or
// recipes. Curated names go in first, so the correct spelling of
// a common item is available as a suggestion even if you've never
// typed it before.
// -------------------------------------------------------------
function getAllItemNames(callback) {
    readAllInventory((err, inventoryItems) => {
        if (err) return callback(err, null);

        readRecipes((err, recipes) => {
            if (err) return callback(err, null);

            // Keyed by the LOWERCASE name, so "Tinned Tomatoes" and
            // "tinned tomatoes" count as the same item and only show
            // up once - we keep whichever casing we happen to see first.
            const namesByKey = new Map();

            function addName(name) {
                const key = name.toLowerCase();
                if (!namesByKey.has(key)) {
                    namesByKey.set(key, name);
                }
            }

            // Curated names go first, so they "win" if there's ever
            // a casing clash with something you've typed yourself.
            COMMON_GROCERY_ITEMS.forEach(addName);
            inventoryItems.forEach(item => addName(item.name));
            recipes.forEach(recipe => {
                recipe.ingredients.forEach(ing => addName(ing.ingredient_name));
            });

            callback(null, Array.from(namesByKey.values()).sort());
        });
    });
}

const server = http.createServer((req, res) => {

    // Let the browser talk to this server from a file:// page.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Browsers sometimes send a quick permission check ("OPTIONS")
    // before the real request - just say "yes, go ahead."
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ---- RECIPES: separate logic since it's two linked files, not one ----
    // This has to be checked BEFORE the pantry/fridge/freezer/chest
    // routing below, since "recipes" isn't in csvFiles and would
    // otherwise get rejected as an unknown section.
    if (req.url === '/recipes' && req.method === 'GET') {
        readRecipes((err, recipes) => {
            if (err) {
                console.error('Error reading recipes:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read recipes');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(recipes));
        });
        return;
    }

    if (req.url === '/recipes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const newRecipe = JSON.parse(body);

            // Generate a simple unique ID using the current timestamp.
            // This avoids needing to track "the last ID used" ourselves.
            const newId = Date.now().toString();

            fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipes');
                    return;
                }

                const recipes = parseCSV(recipesData);
                recipes.push({
                    id: newId,
                    name: newRecipe.name,
                    instructions: newRecipe.instructions
                });

                fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not read recipe ingredients');
                        return;
                    }

                    const ingredients = parseCSV(ingredientsData);

                    // Add one row per ingredient, all linked to this recipe's id
                    newRecipe.ingredients.forEach(ing => {
                        ingredients.push({
                            recipe_id: newId,
                            ingredient_name: ing.name,
                            quantity: ing.quantity,
                            unit: ing.unit
                        });
                    });

                    fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], recipes), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipes');
                            return;
                        }

                        fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], ingredients), 'utf8', (err) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Could not save recipe ingredients');
                                return;
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ id: newId, ...newRecipe }));
                        });
                    });
                });
            });
        });
        return;
    }

    // ---- PUT: update an existing recipe by id ----
    // Same idea as POST (create), but instead of adding a new row,
    // we replace the existing recipe's data and completely swap out
    // its ingredient rows for the new set.
    if (req.url.startsWith('/recipes/') && req.method === 'PUT') {
        const recipeId = req.url.replace('/recipes/', '');

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const updatedRecipe = JSON.parse(body);

            fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipes');
                    return;
                }

                const recipes = parseCSV(recipesData);

                // Find the recipe being edited and update its fields
                // in place, keeping the same id.
                const recipe = recipes.find(r => r.id === recipeId);
                if (!recipe) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Recipe not found');
                    return;
                }
                recipe.name = updatedRecipe.name;
                recipe.instructions = updatedRecipe.instructions;

                fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not read recipe ingredients');
                        return;
                    }

                    const ingredients = parseCSV(ingredientsData);

                    // Remove this recipe's OLD ingredient rows, then add
                    // the new set. It's simpler and safer than trying to
                    // match old ingredients to new ones one-by-one.
                    const otherIngredients = ingredients.filter(ing => ing.recipe_id !== recipeId);

                    updatedRecipe.ingredients.forEach(ing => {
                        otherIngredients.push({
                            recipe_id: recipeId,
                            ingredient_name: ing.name,
                            quantity: ing.quantity,
                            unit: ing.unit
                        });
                    });

                    fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], recipes), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipes');
                            return;
                        }

                        fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], otherIngredients), 'utf8', (err) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Could not save recipe ingredients');
                                return;
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ id: recipeId, ...updatedRecipe }));
                        });
                    });
                });
            });
        });
        return;
    }

    // ---- DELETE a single recipe by id ----
    // URL looks like /recipes/1234567890 - we need to pull the id
    // out of the end of the URL.
    if (req.url.startsWith('/recipes/') && req.method === 'DELETE') {
        const recipeId = req.url.replace('/recipes/', '');

        fs.readFile(RECIPES_FILE, 'utf8', (err, recipesData) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read recipes');
                return;
            }

            const recipes = parseCSV(recipesData);

            // Keep every recipe EXCEPT the one being deleted
            const remainingRecipes = recipes.filter(r => r.id !== recipeId);

            fs.readFile(RECIPE_INGREDIENTS_FILE, 'utf8', (err, ingredientsData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipe ingredients');
                    return;
                }

                const ingredients = parseCSV(ingredientsData);

                // Also remove any ingredient rows that belonged to
                // this recipe, otherwise they'd be orphaned - pointing
                // to a recipe_id that no longer exists anywhere.
                const remainingIngredients = ingredients.filter(ing => ing.recipe_id !== recipeId);

                fs.writeFile(RECIPES_FILE, stringifyGenericCSV(['id', 'name', 'instructions'], remainingRecipes), 'utf8', (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save recipes');
                        return;
                    }

                    fs.writeFile(RECIPE_INGREDIENTS_FILE, stringifyGenericCSV(['recipe_id', 'ingredient_name', 'quantity', 'unit'], remainingIngredients), 'utf8', (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Could not save recipe ingredients');
                            return;
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ deleted: recipeId }));
                    });
                });
            });
        });
        return;
    }


    // ---- List the household members who can vote ----
    if (req.url === '/household-members' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(HOUSEHOLD_MEMBERS));
        return;
    }

    // ---- Cast (or change) a vote on a recipe ----
    // URL looks like /recipes/1234567890/votes
    if (req.url.match(/^\/recipes\/[^/]+\/votes$/) && req.method === 'POST') {
        const recipeId = req.url.split('/')[2];

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const { person, vote } = JSON.parse(body);

            fs.readFile(RECIPE_VOTES_FILE, 'utf8', (err, votesData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read recipe votes');
                    return;
                }

                const votes = parseCSV(votesData);

                // If this person already voted on this recipe, update
                // their existing vote rather than adding a duplicate row.
                const existingVote = votes.find(v => v.recipe_id === recipeId && v.person === person);

                if (existingVote) {
                    existingVote.vote = vote;
                } else {
                    votes.push({ recipe_id: recipeId, person, vote });
                }

                fs.writeFile(RECIPE_VOTES_FILE, stringifyGenericCSV(['recipe_id', 'person', 'vote'], votes), 'utf8', (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save recipe votes');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ recipe_id: recipeId, person, vote }));
                });
            });
        });
        return;
    }
    
    // ---- Combined inventory across all four sections ----
    // Used by the Recipes page to check "do we have enough of
    // this ingredient anywhere in the house?"
    if (req.url === '/inventory-all' && req.method === 'GET') {
        readAllInventory((err, items) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read inventory');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
        });
        return;
    }

    // ---- All known item names (for dropdown/autocomplete suggestions) ----
    if (req.url === '/item-names' && req.method === 'GET') {
        getAllItemNames((err, names) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read item names');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(names));
        });
        return;
    }

    // req.url looks like "/pantry" - strip the leading slash to get
    // just the section name.
    const section = req.url.replace('/', '');

    if (!csvFiles[section]) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Unknown section: ' + section);
        return;
    }

    // ---- GET: return this section's items ----
    if (req.method === 'GET') {
        readItems(section, (err, items) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not read ' + csvFiles[section]);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
        });
        return;
    }

    // ---- POST: add/update an item, save, return the updated list ----
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });

        req.on('end', () => {
            const newItem = JSON.parse(body);
            // If this item is weight-based (g or kg), convert it to grams
            // right away. That way everything stored is in one consistent
            // unit, and "10kg" + "500g" merge correctly instead of being
            // treated as two different items.
            if (isWeightUnit(newItem.unit)) {
                newItem.quantity = toGrams(newItem.quantity, newItem.unit);
                newItem.unit = 'g';
            }

            // If this item is volume-based (ml or l), convert it to
            // millilitres right away, same reasoning as the weight
            // conversion above - one consistent unit so merging works.
            if (isVolumeUnit(newItem.unit)) {
            newItem.quantity = toMilliliters(newItem.quantity, newItem.unit);
            newItem.unit = 'ml';
            }

            readItems(section, (err, items) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Could not read ' + csvFiles[section]);
                    return;
                }

                // Same merge logic your old addItem() used: find a
                // matching item by name AND unit, adjust its quantity.
                const existingItem = items.find(i =>
                    i.name.toLowerCase() === newItem.name.toLowerCase() &&
                    i.unit === newItem.unit
                );

                if (existingItem) {
                    existingItem.quantity = Number(existingItem.quantity) + Number(newItem.quantity);

                    if (existingItem.quantity <= 0) {
                        items = items.filter(i =>
                            !(i.name.toLowerCase() === newItem.name.toLowerCase() && i.unit === newItem.unit)
                        );
                    }
                } else {
                    items.push(newItem);
                }

                saveItems(section, items, (err) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Could not save ' + csvFiles[section]);
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(items));
                });
            });
        });
        return;
    }

    // ---- DELETE: clear this section back to empty ----
    if (req.method === 'DELETE') {
        saveItems(section, [], (err) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Could not clear ' + csvFiles[section]);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        });
        return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
});

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});