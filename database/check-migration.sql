-- =============================================================
-- CHECK MIGRATION - run in SSMS on the pantry database after
-- database/migrate-csv-to-database.js, to see the data arrived.
-- Compare the counts with the table the migration script printed.
-- =============================================================

-- Row count per table
SELECT 'inventory' AS table_name, COUNT(*) AS row_count FROM dbo.inventory
UNION ALL SELECT 'recipes', COUNT(*) FROM dbo.recipes
UNION ALL SELECT 'recipe_ingredients', COUNT(*) FROM dbo.recipe_ingredients
UNION ALL SELECT 'recipe_votes', COUNT(*) FROM dbo.recipe_votes
UNION ALL SELECT 'meal_plan', COUNT(*) FROM dbo.meal_plan
UNION ALL SELECT 'ingredient_aliases', COUNT(*) FROM dbo.ingredient_aliases
UNION ALL SELECT 'prices', COUNT(*) FROM dbo.prices
UNION ALL SELECT 'activity_log', COUNT(*) FROM dbo.activity_log
UNION ALL SELECT 'stock_minimums', COUNT(*) FROM dbo.stock_minimums
UNION ALL SELECT 'barcodes', COUNT(*) FROM dbo.barcodes
UNION ALL SELECT 'watch_list', COUNT(*) FROM dbo.watch_list;

-- Stock per storage area (pantry.csv, fridge.csv, freezer.csv, chest.csv)
SELECT location, COUNT(*) AS items
FROM dbo.inventory
GROUP BY location
ORDER BY location;

-- Every recipe with how many ingredients and votes it brought across -
-- a recipe showing 0 ingredients is worth a look
SELECT r.id, r.name, r.servings,
       (SELECT COUNT(*) FROM dbo.recipe_ingredients i WHERE i.recipe_id = r.id) AS ingredients,
       (SELECT COUNT(*) FROM dbo.recipe_votes v WHERE v.recipe_id = r.id) AS votes
FROM dbo.recipes r
ORDER BY r.name;

-- The full stock list
SELECT location, name, quantity, unit, track, low
FROM dbo.inventory
ORDER BY location, name;
