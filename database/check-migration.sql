-- =============================================================
-- CHECK THE DATA - run in SSMS on the pantry database, e.g. after
-- an upgrade (see database/archive), to see the data
-- is all there. (Updated for the phase 5 tables.)
-- =============================================================

-- Row count per table
SELECT 'people' AS table_name, COUNT(*) AS row_count FROM dbo.people
UNION ALL SELECT 'stores', COUNT(*) FROM dbo.stores
UNION ALL SELECT 'locations', COUNT(*) FROM dbo.locations
UNION ALL SELECT 'ingredients', COUNT(*) FROM dbo.ingredients
UNION ALL SELECT 'inventory', COUNT(*) FROM dbo.inventory
UNION ALL SELECT 'recipes', COUNT(*) FROM dbo.recipes
UNION ALL SELECT 'recipe_ingredients', COUNT(*) FROM dbo.recipe_ingredients
UNION ALL SELECT 'recipe_votes', COUNT(*) FROM dbo.recipe_votes
UNION ALL SELECT 'meal_plan', COUNT(*) FROM dbo.meal_plan
UNION ALL SELECT 'ingredient_aliases', COUNT(*) FROM dbo.ingredient_aliases
UNION ALL SELECT 'prices', COUNT(*) FROM dbo.prices
UNION ALL SELECT 'activity_log', COUNT(*) FROM dbo.activity_log
UNION ALL SELECT 'ingredients with a minimum', COUNT(*) FROM dbo.ingredients WHERE minimum_quantity IS NOT NULL
UNION ALL SELECT 'products', COUNT(*) FROM dbo.products
UNION ALL SELECT 'store_products', COUNT(*) FROM dbo.store_products
UNION ALL SELECT 'prices with a product code', COUNT(*) FROM dbo.prices WHERE product_code IS NOT NULL
UNION ALL SELECT 'watch_list', COUNT(*) FROM dbo.watch_list;

-- Stock per storage area
SELECT l.location_name, COUNT(i.name) AS items
FROM dbo.locations l
LEFT JOIN dbo.inventory i ON i.location_code = l.location_code
GROUP BY l.location_name, l.sort_order
ORDER BY l.sort_order;

-- Every recipe with how many ingredients and votes it has -
-- a recipe showing 0 ingredients is worth a look
SELECT r.recipe_id, r.name, r.servings,
       (SELECT COUNT(*) FROM dbo.recipe_ingredients i WHERE i.recipe_id = r.recipe_id) AS ingredients,
       (SELECT COUNT(*) FROM dbo.recipe_votes v WHERE v.recipe_id = r.recipe_id) AS votes
FROM dbo.recipes r
ORDER BY r.name;

-- Votes with who cast them
SELECT r.name AS recipe, p.name AS person, v.vote
FROM dbo.recipe_votes v
JOIN dbo.recipes r ON r.recipe_id = v.recipe_id
JOIN dbo.people p ON p.person_id = v.person_id
ORDER BY r.name, p.name;

-- The full stock list, with the ingredient each item counts as
SELECT l.location_name, i.name, i.ingredient_name, i.quantity, i.unit, i.track, i.low
FROM dbo.inventory i
JOIN dbo.locations l ON l.location_code = i.location_code
ORDER BY l.sort_order, i.name;

-- Names you've used that link to a DIFFERENT ingredient name - worth a
-- quick look that each one is what you'd expect
SELECT 'stock' AS used_in, name, ingredient_name FROM dbo.inventory WHERE name <> ingredient_name
UNION SELECT 'recipe', name, ingredient_name FROM dbo.recipe_ingredients WHERE name <> ingredient_name
UNION SELECT 'product', item_name, ingredient_name FROM dbo.products WHERE item_name <> ingredient_name
ORDER BY ingredient_name, name;

-- Every minimum ("always want ...")
SELECT ingredient_name, minimum_quantity, minimum_unit
FROM dbo.ingredients
WHERE minimum_quantity IS NOT NULL
ORDER BY ingredient_name;

-- Each supermarket product code linked to a barcode, with the product
SELECT sp.chain, sp.product_code, sp.barcode, p.brand, p.product_name, p.item_name, sp.date_linked
FROM dbo.store_products sp
JOIN dbo.products p ON p.barcode = sp.barcode
ORDER BY p.product_name, sp.chain;

-- Ingredients you've added yourself (anything not in the built-in list)
SELECT ingredient_name, tin_quantity, tin_unit
FROM dbo.ingredients
WHERE source = 'yours'
ORDER BY ingredient_name;

-- The most recent activity, in NZ time
SELECT TOP 20 logged_at AT TIME ZONE 'New Zealand Standard Time' AS nz_time, line_no,
       p.name AS person, a.action, a.item, a.quantity, a.unit, l.location_name, a.details
FROM dbo.activity_log a
LEFT JOIN dbo.people p ON p.person_id = a.person_id
LEFT JOIN dbo.locations l ON l.location_code = a.location_code
ORDER BY a.logged_at DESC, a.line_no;
