-- =============================================================
-- PHASE 2 UPGRADE - turns the live phase 1 tables into the phase 2
-- design (see docs/database-design.md)
-- =============================================================
-- Run ONCE in SSMS with the ADMIN login, on the pantry database,
-- with the website stopped (see the README for the full steps).
--
-- Everything is one transaction with XACT_ABORT ON: if any part
-- fails, the whole upgrade is rolled back and the phase 1 tables are
-- left exactly as they were. It refuses to run a second time.
--
-- How it works: each changed table is built new as <name>_new with
-- its phase 2 key, the existing rows are copied across (converted on
-- the way), then the old tables are dropped and the new ones renamed.
-- ingredient_aliases and stock_minimums don't change.
--
-- Rows that can't fit the new keys are combined rather than lost:
-- - stock with the same place + name + unit: quantities added up
-- - a recipe ingredient listed twice with the same unit: added up
-- - the same recipe twice on one day of the meal plan: kept once
-- - two prices for the same product, store and millisecond: the
--   later one kept
-- - the same product starred twice: the later one kept
-- =============================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID('dbo.people', 'U') IS NOT NULL
BEGIN
    THROW 50000, 'This database already has the phase 2 tables (dbo.people exists) - nothing was changed.', 1;
END;

BEGIN TRANSACTION;

-- -------------------------------------------------------------
-- PEOPLE - the household, plus any other name found in the old
-- votes, activity log or watch list, so no row loses its person.
-- -------------------------------------------------------------
CREATE TABLE dbo.people (
    person_id INT IDENTITY(1,1) CONSTRAINT PK_people PRIMARY KEY,
    name      NVARCHAR(50) NOT NULL CONSTRAINT UQ_people_name UNIQUE
);

INSERT INTO dbo.people (name) VALUES ('Charlotte'), ('Todd'), ('Kayleigh');

INSERT INTO dbo.people (name)
SELECT DISTINCT n.name
FROM (
    SELECT person AS name FROM dbo.recipe_votes
    UNION SELECT person FROM dbo.activity_log
    UNION SELECT added_by FROM dbo.watch_list
) AS n
WHERE n.name IS NOT NULL AND n.name <> ''
  AND n.name NOT IN (SELECT name FROM dbo.people);

-- -------------------------------------------------------------
-- STORES - the branches the price checker knows, plus any other
-- store name found in the old prices / watch list (switched off,
-- since there's no store code to search it with).
-- -------------------------------------------------------------
CREATE TABLE dbo.stores (
    store_name    NVARCHAR(100) CONSTRAINT PK_stores PRIMARY KEY,
    chain         NVARCHAR(50)  NULL,
    suburb        NVARCHAR(50)  NULL,
    store_code    NVARCHAR(200) NULL,
    is_main_store BIT NOT NULL CONSTRAINT DF_stores_main DEFAULT 0,
    is_preferred  BIT NOT NULL CONSTRAINT DF_stores_preferred DEFAULT 0,
    is_active     BIT NOT NULL CONSTRAINT DF_stores_active DEFAULT 1
);

INSERT INTO dbo.stores (store_name, chain, suburb, store_code, is_main_store, is_preferred, is_active) VALUES
    ('Woolworths Moorhouse',  'Woolworths', 'Moorhouse',  'dm-Pickup,f-9169,a-495,s-10235',       0, 0, 1),
    ('Woolworths Northlands', 'Woolworths', 'Northlands', 'dm-Pickup,f-9540,a-480,s-38',          0, 0, 1),
    ('Woolworths Ferrymead',  'Woolworths', 'Ferrymead',  'dm-Pickup,f-9576,a-726,s-10410',       1, 1, 1),
    ('PAK''nSAVE Moorhouse',  'PAK''nSAVE', 'Moorhouse',  '61dd754e-8525-4b9e-9e08-173389eea8a8', 0, 0, 1),
    ('PAK''nSAVE Papanui',    'PAK''nSAVE', 'Papanui',    '8cd700ae-d96f-4761-bd7a-805d6b93536d', 0, 0, 1),
    ('PAK''nSAVE Riccarton',  'PAK''nSAVE', 'Riccarton',  '4a279605-eaa8-470d-bcd4-0a9e3c9ab43b', 0, 0, 1),
    ('PAK''nSAVE Wainoni',    'PAK''nSAVE', 'Wainoni',    'dbca5e00-f7f9-43ae-91de-031ad16f8a92', 1, 1, 1),
    ('Trents Wholesale',      'Trents',     NULL,         NULL,                                   1, 1, 1);

INSERT INTO dbo.stores (store_name, chain, is_active)
SELECT DISTINCT s.store_name,
       CASE WHEN s.store_name LIKE 'Woolworths%' THEN 'Woolworths'
            WHEN s.store_name LIKE 'PAK%' THEN 'PAK''nSAVE'
            WHEN s.store_name LIKE 'Trents%' THEN 'Trents' END,
       0
FROM (SELECT store AS store_name FROM dbo.prices UNION SELECT store FROM dbo.watch_list) AS s
WHERE s.store_name IS NOT NULL AND s.store_name <> ''
  AND s.store_name NOT IN (SELECT store_name FROM dbo.stores);

-- -------------------------------------------------------------
-- LOCATIONS - the storage areas.
-- -------------------------------------------------------------
CREATE TABLE dbo.locations (
    location_code NVARCHAR(10) CONSTRAINT PK_locations PRIMARY KEY,
    location_name NVARCHAR(50) NOT NULL,
    storage_type  NVARCHAR(10) NOT NULL
                  CONSTRAINT CK_locations_type CHECK (storage_type IN ('cupboard', 'chilled', 'frozen')),
    sort_order    INT NOT NULL
);

INSERT INTO dbo.locations (location_code, location_name, storage_type, sort_order) VALUES
    ('pantry',  'Pantry',           'cupboard', 1),
    ('fridge',  'Fridge',           'chilled',  2),
    ('freezer', 'Freezer (Inside)', 'frozen',   3),
    ('chest',   'Chest Freezer',    'frozen',   4);

-- -------------------------------------------------------------
-- INVENTORY - keyed on place + name + unit (no more id).
-- -------------------------------------------------------------
CREATE TABLE dbo.inventory_new (
    location_code NVARCHAR(10)  NOT NULL
                  CONSTRAINT FK_inventory_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    name          NVARCHAR(200) NOT NULL,
    unit          NVARCHAR(20)  NOT NULL,
    quantity      DECIMAL(12,3) NOT NULL,
    track         NVARCHAR(10)  NULL CONSTRAINT CK_inventory_track CHECK (track IN ('have', 'amount')),
    low           BIT NOT NULL CONSTRAINT DF_inventory_low DEFAULT 0,
    CONSTRAINT PK_inventory PRIMARY KEY (location_code, name, unit)
);

INSERT INTO dbo.inventory_new (location_code, name, unit, quantity, track, low)
SELECT location, MIN(name), unit, SUM(quantity), MAX(track), CAST(MAX(CAST(low AS INT)) AS BIT)
FROM dbo.inventory
GROUP BY location, name, unit;

-- -------------------------------------------------------------
-- RECIPES - id renamed to recipe_id; the values don't change.
-- -------------------------------------------------------------
CREATE TABLE dbo.recipes_new (
    recipe_id    NVARCHAR(20)  CONSTRAINT PK_recipes PRIMARY KEY,
    name         NVARCHAR(200) NOT NULL,
    instructions NVARCHAR(MAX) NOT NULL CONSTRAINT DF_recipes_instructions DEFAULT '',
    servings     INT NULL
);

INSERT INTO dbo.recipes_new (recipe_id, name, instructions, servings)
SELECT id, name, instructions, servings FROM dbo.recipes;

-- -------------------------------------------------------------
-- RECIPE INGREDIENTS - keyed on recipe + ingredient + unit, with
-- sort_order keeping the recipe's own order.
-- -------------------------------------------------------------
CREATE TABLE dbo.recipe_ingredients_new (
    recipe_id       NVARCHAR(20)  NOT NULL
                    CONSTRAINT FK_recipe_ingredients_recipe REFERENCES dbo.recipes_new(recipe_id) ON DELETE CASCADE,
    ingredient_name NVARCHAR(200) NOT NULL,
    unit            NVARCHAR(20)  NOT NULL CONSTRAINT DF_recipe_ingredients_unit DEFAULT '',
    quantity        DECIMAL(12,3) NULL,
    sort_order      INT NOT NULL,
    CONSTRAINT PK_recipe_ingredients PRIMARY KEY (recipe_id, ingredient_name, unit)
);

INSERT INTO dbo.recipe_ingredients_new (recipe_id, ingredient_name, unit, quantity, sort_order)
SELECT recipe_id, MIN(ingredient_name), ISNULL(unit, ''), SUM(quantity),
       ROW_NUMBER() OVER (PARTITION BY recipe_id ORDER BY MIN(id))
FROM dbo.recipe_ingredients
WHERE recipe_id IN (SELECT id FROM dbo.recipes)
GROUP BY recipe_id, ingredient_name, ISNULL(unit, '');

-- -------------------------------------------------------------
-- RECIPE VOTES - person name swapped for person_id.
-- -------------------------------------------------------------
CREATE TABLE dbo.recipe_votes_new (
    recipe_id NVARCHAR(20) NOT NULL
              CONSTRAINT FK_recipe_votes_recipe REFERENCES dbo.recipes_new(recipe_id) ON DELETE CASCADE,
    person_id INT NOT NULL
              CONSTRAINT FK_recipe_votes_person REFERENCES dbo.people(person_id),
    vote      NVARCHAR(10) NOT NULL,
    CONSTRAINT PK_recipe_votes PRIMARY KEY (recipe_id, person_id)
);

INSERT INTO dbo.recipe_votes_new (recipe_id, person_id, vote)
SELECT v.recipe_id, p.person_id, v.vote
FROM dbo.recipe_votes v
JOIN dbo.people p ON p.name = v.person
WHERE v.recipe_id IN (SELECT id FROM dbo.recipes);

-- -------------------------------------------------------------
-- MEAL PLAN - keyed on day + recipe; people renamed people_count.
-- -------------------------------------------------------------
CREATE TABLE dbo.meal_plan_new (
    day          NVARCHAR(10) NOT NULL,
    recipe_id    NVARCHAR(20) NOT NULL
                 CONSTRAINT FK_meal_plan_recipe REFERENCES dbo.recipes_new(recipe_id) ON DELETE CASCADE,
    people_count INT NULL,
    CONSTRAINT PK_meal_plan PRIMARY KEY (day, recipe_id)
);

INSERT INTO dbo.meal_plan_new (day, recipe_id, people_count)
SELECT day, recipe_id, MAX(people)
FROM dbo.meal_plan
WHERE recipe_id IN (SELECT id FROM dbo.recipes)
GROUP BY day, recipe_id;

-- -------------------------------------------------------------
-- PRICES - keyed on store + product + time, store pointing at stores.
-- -------------------------------------------------------------
CREATE TABLE dbo.prices_new (
    store_name    NVARCHAR(100) NOT NULL
                  CONSTRAINT FK_prices_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
    item_name     NVARCHAR(300) NOT NULL,
    date_checked  DATETIMEOFFSET(3) NOT NULL,
    price         DECIMAL(10,2) NULL,
    cup_price     DECIMAL(10,2) NULL,
    cup_measure   NVARCHAR(50)  NULL,
    package_size  NVARCHAR(50)  NULL,
    original_name NVARCHAR(300) NULL,
    CONSTRAINT PK_prices PRIMARY KEY (store_name, item_name, date_checked)
);

INSERT INTO dbo.prices_new (store_name, item_name, date_checked, price, cup_price, cup_measure, package_size, original_name)
SELECT store, item_name, checked, price, cup_price, cup_measure, package_size, original_name
FROM (
    SELECT *, CAST(date_checked AS DATETIMEOFFSET(3)) AS checked,
           ROW_NUMBER() OVER (PARTITION BY store, item_name, CAST(date_checked AS DATETIMEOFFSET(3)) ORDER BY id DESC) AS keep
    FROM dbo.prices
) AS p
WHERE keep = 1;

-- -------------------------------------------------------------
-- ACTIVITY LOG - the NZ date + time become one exact logged_at,
-- line_no numbers rows logged in the same minute, the person name
-- becomes person_id, and the location name becomes its code.
-- -------------------------------------------------------------
CREATE TABLE dbo.activity_log_new (
    logged_at     DATETIMEOFFSET(7) NOT NULL,
    line_no       INT NOT NULL,
    person_id     INT NULL
                  CONSTRAINT FK_activity_log_person REFERENCES dbo.people(person_id),
    action        NVARCHAR(50)  NOT NULL,
    item          NVARCHAR(200) NULL,
    quantity      DECIMAL(12,3) NULL,
    unit          NVARCHAR(20)  NULL,
    location_code NVARCHAR(10)  NULL
                  CONSTRAINT FK_activity_log_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    details       NVARCHAR(MAX) NULL,
    CONSTRAINT PK_activity_log PRIMARY KEY (logged_at, line_no)
);

INSERT INTO dbo.activity_log_new (logged_at, line_no, person_id, action, item, quantity, unit, location_code, details)
SELECT CAST(CONCAT(CONVERT(CHAR(10), a.log_date, 23), ' ', CONVERT(CHAR(8), a.log_time, 108)) AS DATETIME2(7))
           AT TIME ZONE 'New Zealand Standard Time',
       ROW_NUMBER() OVER (PARTITION BY a.log_date, a.log_time ORDER BY a.id),
       p.person_id, a.action, a.item, a.quantity, a.unit, l.location_code, a.details
FROM dbo.activity_log a
LEFT JOIN dbo.people p ON p.name = a.person
LEFT JOIN dbo.locations l ON l.location_name = a.location OR l.location_code = a.location;

-- -------------------------------------------------------------
-- BARCODES - name becomes item_name, plus the new brand / product
-- name / source / who / when columns (blank for barcodes you've
-- already saved - they fill in as you scan).
-- -------------------------------------------------------------
CREATE TABLE dbo.barcodes_new (
    barcode            NVARCHAR(50)  CONSTRAINT PK_barcodes PRIMARY KEY,
    item_name          NVARCHAR(200) NOT NULL,
    brand              NVARCHAR(100) NULL,
    product_name       NVARCHAR(300) NULL,
    quantity           DECIMAL(12,3) NULL,
    unit               NVARCHAR(20)  NULL,
    location_code      NVARCHAR(10)  NULL
                       CONSTRAINT FK_barcodes_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    source             NVARCHAR(20)  NULL,
    added_by_person_id INT NULL
                       CONSTRAINT FK_barcodes_person REFERENCES dbo.people(person_id),
    date_added         DATE NULL
);

INSERT INTO dbo.barcodes_new (barcode, item_name, quantity, unit, location_code, source)
SELECT b.barcode, b.name, b.quantity, b.unit, l.location_code, 'scanned'
FROM dbo.barcodes b
LEFT JOIN dbo.locations l ON l.location_code = b.location OR l.location_name = b.location;

-- -------------------------------------------------------------
-- WATCH LIST - keyed on store + product + size (no more id), with
-- added_by swapped for added_by_person_id.
-- -------------------------------------------------------------
CREATE TABLE dbo.watch_list_new (
    store_name         NVARCHAR(100) NOT NULL
                       CONSTRAINT FK_watch_list_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
    item_name          NVARCHAR(300) NOT NULL,
    package_size       NVARCHAR(50)  NOT NULL CONSTRAINT DF_watch_list_size DEFAULT '',
    search_term        NVARCHAR(300) NULL,
    added_by_person_id INT NULL
                       CONSTRAINT FK_watch_list_person REFERENCES dbo.people(person_id),
    date_added         DATE NULL,
    CONSTRAINT PK_watch_list PRIMARY KEY (store_name, item_name, package_size)
);

INSERT INTO dbo.watch_list_new (store_name, item_name, package_size, search_term, added_by_person_id, date_added)
SELECT w.store, w.item_name, w.size, w.search_term, p.person_id, CAST(w.date_added AS DATE)
FROM (
    SELECT *, ISNULL(package_size, '') AS size,
           ROW_NUMBER() OVER (PARTITION BY store, item_name, ISNULL(package_size, '') ORDER BY id DESC) AS keep
    FROM dbo.watch_list
) AS w
LEFT JOIN dbo.people p ON p.name = w.added_by
WHERE w.keep = 1;

-- -------------------------------------------------------------
-- Swap the new tables in (children of recipes dropped first).
-- -------------------------------------------------------------
DROP TABLE dbo.recipe_ingredients;
DROP TABLE dbo.recipe_votes;
DROP TABLE dbo.meal_plan;
DROP TABLE dbo.recipes;
DROP TABLE dbo.inventory;
DROP TABLE dbo.prices;
DROP TABLE dbo.activity_log;
DROP TABLE dbo.barcodes;
DROP TABLE dbo.watch_list;

EXEC sp_rename 'dbo.inventory_new', 'inventory';
EXEC sp_rename 'dbo.recipes_new', 'recipes';
EXEC sp_rename 'dbo.recipe_ingredients_new', 'recipe_ingredients';
EXEC sp_rename 'dbo.recipe_votes_new', 'recipe_votes';
EXEC sp_rename 'dbo.meal_plan_new', 'meal_plan';
EXEC sp_rename 'dbo.prices_new', 'prices';
EXEC sp_rename 'dbo.activity_log_new', 'activity_log';
EXEC sp_rename 'dbo.barcodes_new', 'barcodes';
EXEC sp_rename 'dbo.watch_list_new', 'watch_list';

COMMIT TRANSACTION;

-- Row counts after the upgrade - compare with SELECT COUNT(*) from
-- before, or with the table the migration printed.
-- (sp_rename prints a "Caution: changing any part of an object name"
-- message for each table above - that's expected.)
SELECT 'people' AS table_name, COUNT(*) AS row_count FROM dbo.people
UNION ALL SELECT 'stores', COUNT(*) FROM dbo.stores
UNION ALL SELECT 'locations', COUNT(*) FROM dbo.locations
UNION ALL SELECT 'inventory', COUNT(*) FROM dbo.inventory
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
