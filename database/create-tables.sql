-- =============================================================
-- CREATE TABLES - the full pantry database (phase 3 design)
-- =============================================================
-- For building a NEW, empty database (e.g. a pantry_dev copy for
-- testing) - then run database/seed-ingredients.sql to add the
-- built-in ingredients and aliases. The live database was upgraded
-- with database/phase2-upgrade.sql and database/ingredients-upgrade.sql
-- instead.
--
-- Run once in SSMS with the ADMIN login, on the target database
-- (not master). Safe to re-run - each table is only created if it
-- doesn't exist yet, and the starting rows are only added if missing.
--
-- Keys: a number id for people only. Everything else is keyed by
-- its real-world identity, with composite keys where one column
-- isn't enough. The default collation is case-insensitive, matching
-- the way server.js compares names.
-- =============================================================


-- -------------------------------------------------------------
-- PEOPLE - everyone who can log in and vote. Every other table
-- stores person_id, never the name.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.people', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.people (
        person_id INT IDENTITY(1,1) CONSTRAINT PK_people PRIMARY KEY,
        name      NVARCHAR(50) NOT NULL CONSTRAINT UQ_people_name UNIQUE
    );
END;


-- -------------------------------------------------------------
-- STORES - every supermarket branch the price checker can search.
-- store_code is the cookie value / store ID the scraper uses to pick
-- that branch (blank for Trents). is_main_store = in the "Our stores"
-- search; is_preferred = listed first; is_active = still offered.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.stores', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.stores (
        store_name    NVARCHAR(100) CONSTRAINT PK_stores PRIMARY KEY,
        chain         NVARCHAR(50)  NULL,
        suburb        NVARCHAR(50)  NULL,
        store_code    NVARCHAR(200) NULL,
        is_main_store BIT NOT NULL CONSTRAINT DF_stores_main DEFAULT 0,
        is_preferred  BIT NOT NULL CONSTRAINT DF_stores_preferred DEFAULT 0,
        is_active     BIT NOT NULL CONSTRAINT DF_stores_active DEFAULT 1
    );
END;


-- -------------------------------------------------------------
-- LOCATIONS - the storage areas in the house.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.locations', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.locations (
        location_code NVARCHAR(10) CONSTRAINT PK_locations PRIMARY KEY,
        location_name NVARCHAR(50) NOT NULL,
        storage_type  NVARCHAR(10) NOT NULL
                      CONSTRAINT CK_locations_type CHECK (storage_type IN ('cupboard', 'chilled', 'frozen')),
        sort_order    INT NOT NULL
    );
END;


-- -------------------------------------------------------------
-- INGREDIENTS - the master list: one row per ingredient (or anything
-- else stocked, like cat food). Stock, recipe ingredients, minimums,
-- barcodes and aliases all point at it. tin_quantity / tin_unit = the
-- size of one tin, for things that come in tins.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.ingredients', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ingredients (
        ingredient_name NVARCHAR(200) CONSTRAINT PK_ingredients PRIMARY KEY,
        tin_quantity    DECIMAL(12,3) NULL,
        tin_unit        NVARCHAR(20)  NULL,
        source          NVARCHAR(10)  NOT NULL CONSTRAINT DF_ingredients_source DEFAULT 'yours'
                        CONSTRAINT CK_ingredients_source CHECK (source IN ('built_in', 'yours'))
    );
END;


-- -------------------------------------------------------------
-- INVENTORY - what's in the house: one row per thing, per storage
-- area, per unit (quantities are kept in g / ml / each). name is as
-- typed; ingredient_name links it to the master list.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.inventory', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inventory (
        location_code NVARCHAR(10)  NOT NULL
                      CONSTRAINT FK_inventory_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
        name          NVARCHAR(200) NOT NULL,
        unit          NVARCHAR(20)  NOT NULL,
        ingredient_name NVARCHAR(200) NOT NULL
                      CONSTRAINT FK_inventory_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        quantity      DECIMAL(12,3) NOT NULL,
        track         NVARCHAR(10)  NULL CONSTRAINT CK_inventory_track CHECK (track IN ('have', 'amount')),   -- NULL = guess from the name
        low           BIT NOT NULL CONSTRAINT DF_inventory_low DEFAULT 0,                                   -- marked running low
        CONSTRAINT PK_inventory PRIMARY KEY (location_code, name, unit)
    );
END;


-- -------------------------------------------------------------
-- RECIPES - recipe_id is the exact time (in milliseconds) the
-- recipe was first saved, e.g. "1786093115133".
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipes (
        recipe_id    NVARCHAR(20)  CONSTRAINT PK_recipes PRIMARY KEY,
        name         NVARCHAR(200) NOT NULL,
        instructions NVARCHAR(MAX) NOT NULL CONSTRAINT DF_recipes_instructions DEFAULT '',
        servings     INT NULL      -- NULL = the default of 2
    );
END;


-- -------------------------------------------------------------
-- RECIPE INGREDIENTS - each ingredient in a recipe: name as the
-- recipe words it, linked to the master list. sort_order keeps them
-- in the order the recipe lists them.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipe_ingredients', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipe_ingredients (
        recipe_id       NVARCHAR(20)  NOT NULL
                        CONSTRAINT FK_recipe_ingredients_recipe REFERENCES dbo.recipes(recipe_id) ON DELETE CASCADE,
        name            NVARCHAR(200) NOT NULL,
        unit            NVARCHAR(20)  NOT NULL CONSTRAINT DF_recipe_ingredients_unit DEFAULT '',
        ingredient_name NVARCHAR(200) NOT NULL
                        CONSTRAINT FK_recipe_ingredients_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        quantity        DECIMAL(12,3) NULL,
        sort_order      INT NOT NULL,
        CONSTRAINT PK_recipe_ingredients PRIMARY KEY (recipe_id, name, unit)
    );
END;


-- -------------------------------------------------------------
-- RECIPE VOTES - one like/dislike per person per recipe.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipe_votes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipe_votes (
        recipe_id NVARCHAR(20) NOT NULL
                  CONSTRAINT FK_recipe_votes_recipe REFERENCES dbo.recipes(recipe_id) ON DELETE CASCADE,
        person_id INT NOT NULL
                  CONSTRAINT FK_recipe_votes_person REFERENCES dbo.people(person_id),
        vote      NVARCHAR(10) NOT NULL,
        CONSTRAINT PK_recipe_votes PRIMARY KEY (recipe_id, person_id)
    );
END;


-- -------------------------------------------------------------
-- MEAL PLAN - the week's plan: each recipe once per day, with how
-- many people it's for.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.meal_plan', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.meal_plan (
        day          NVARCHAR(10) NOT NULL,   -- monday to sunday
        recipe_id    NVARCHAR(20) NOT NULL
                     CONSTRAINT FK_meal_plan_recipe REFERENCES dbo.recipes(recipe_id) ON DELETE CASCADE,
        people_count INT NULL,
        CONSTRAINT PK_meal_plan PRIMARY KEY (day, recipe_id)
    );
END;


-- -------------------------------------------------------------
-- INGREDIENT ALIASES - alternative names, each pointing at one
-- ingredient ("Ground Beef" -> "Mince"). source = built_in (from the
-- built-in list) or yours (added on the site).
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.ingredient_aliases', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ingredient_aliases (
        alias           NVARCHAR(200) CONSTRAINT PK_ingredient_aliases PRIMARY KEY,
        ingredient_name NVARCHAR(200) NOT NULL
                        CONSTRAINT FK_ingredient_aliases_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        source          NVARCHAR(10)  NOT NULL CONSTRAINT DF_ingredient_aliases_source DEFAULT 'yours'
                        CONSTRAINT CK_ingredient_aliases_source CHECK (source IN ('built_in', 'yours'))
    );
END;


-- -------------------------------------------------------------
-- PRICES - every saved price, never changed or deleted, so the full
-- history is kept line by line.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.prices', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.prices (
        store_name    NVARCHAR(100) NOT NULL
                      CONSTRAINT FK_prices_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
        item_name     NVARCHAR(300) NOT NULL,   -- tidied name used for grouping (savedPriceName in server.js)
        date_checked  DATETIMEOFFSET(3) NOT NULL,
        price         DECIMAL(10,2) NULL,
        cup_price     DECIMAL(10,2) NULL,
        cup_measure   NVARCHAR(50)  NULL,
        package_size  NVARCHAR(50)  NULL,
        original_name NVARCHAR(300) NULL,       -- exactly as the supermarket wrote it
        CONSTRAINT PK_prices PRIMARY KEY (store_name, item_name, date_checked)
    );
END;


-- -------------------------------------------------------------
-- ACTIVITY LOG - who changed what, and when. logged_at is the exact
-- time of the change; line_no numbers the rows one change wrote.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.activity_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.activity_log (
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
END;


-- -------------------------------------------------------------
-- STOCK MINIMUMS - "always want 2 tins of tomatoes", in the same
-- base unit as the stock (g / ml / each).
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.stock_minimums', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_minimums (
        name    NVARCHAR(200) NOT NULL,
        unit    NVARCHAR(20)  NOT NULL,
        ingredient_name NVARCHAR(200) NOT NULL
                CONSTRAINT FK_stock_minimums_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        minimum DECIMAL(12,3) NOT NULL,
        CONSTRAINT PK_stock_minimums PRIMARY KEY (name, unit)
    );
END;


-- -------------------------------------------------------------
-- BARCODES - your own barcode database: what each scanned barcode
-- is, so the next scan fills the form in straight away.
-- source = 'openfoodfacts' (found there), 'scanned' (you typed the
-- name after scanning) or 'typed' (added by hand / uploaded).
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.barcodes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.barcodes (
        barcode            NVARCHAR(50)  CONSTRAINT PK_barcodes PRIMARY KEY,
        item_name          NVARCHAR(200) NOT NULL,   -- your name for it, e.g. Tinned Tomatoes
        ingredient_name    NVARCHAR(200) NOT NULL
                           CONSTRAINT FK_barcodes_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        brand              NVARCHAR(100) NULL,
        product_name       NVARCHAR(300) NULL,       -- full name on the pack
        quantity           DECIMAL(12,3) NULL,       -- pack size
        unit               NVARCHAR(20)  NULL,
        location_code      NVARCHAR(10)  NULL
                           CONSTRAINT FK_barcodes_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
        source             NVARCHAR(20)  NULL,
        added_by_person_id INT NULL
                           CONSTRAINT FK_barcodes_person REFERENCES dbo.people(person_id),
        date_added         DATE NULL
    );
END;


-- -------------------------------------------------------------
-- WATCH LIST - products starred on the Price Checker page, re-checked
-- every morning.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.watch_list', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.watch_list (
        store_name         NVARCHAR(100) NOT NULL
                           CONSTRAINT FK_watch_list_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
        item_name          NVARCHAR(300) NOT NULL,
        package_size       NVARCHAR(50)  NOT NULL CONSTRAINT DF_watch_list_size DEFAULT '',   -- '' if none
        search_term        NVARCHAR(300) NULL,
        added_by_person_id INT NULL
                           CONSTRAINT FK_watch_list_person REFERENCES dbo.people(person_id),
        date_added         DATE NULL,
        CONSTRAINT PK_watch_list PRIMARY KEY (store_name, item_name, package_size)
    );
END;


-- =============================================================
-- STARTING ROWS - only added if they're not there yet
-- =============================================================
INSERT INTO dbo.people (name)
SELECT v.name FROM (VALUES ('Charlotte'), ('Todd'), ('Kayleigh')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM dbo.people p WHERE p.name = v.name);

INSERT INTO dbo.locations (location_code, location_name, storage_type, sort_order)
SELECT v.* FROM (VALUES
    ('pantry',  'Pantry',           'cupboard', 1),
    ('fridge',  'Fridge',           'chilled',  2),
    ('freezer', 'Freezer (Inside)', 'frozen',   3),
    ('chest',   'Chest Freezer',    'frozen',   4)
) AS v(location_code, location_name, storage_type, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM dbo.locations l WHERE l.location_code = v.location_code);

INSERT INTO dbo.stores (store_name, chain, suburb, store_code, is_main_store, is_preferred, is_active)
SELECT v.* FROM (VALUES
    ('Woolworths Moorhouse',  'Woolworths', 'Moorhouse',  'dm-Pickup,f-9169,a-495,s-10235',       0, 0, 1),
    ('Woolworths Northlands', 'Woolworths', 'Northlands', 'dm-Pickup,f-9540,a-480,s-38',          0, 0, 1),
    ('Woolworths Ferrymead',  'Woolworths', 'Ferrymead',  'dm-Pickup,f-9576,a-726,s-10410',       1, 1, 1),
    ('PAK''nSAVE Moorhouse',  'PAK''nSAVE', 'Moorhouse',  '61dd754e-8525-4b9e-9e08-173389eea8a8', 0, 0, 1),
    ('PAK''nSAVE Papanui',    'PAK''nSAVE', 'Papanui',    '8cd700ae-d96f-4761-bd7a-805d6b93536d', 0, 0, 1),
    ('PAK''nSAVE Riccarton',  'PAK''nSAVE', 'Riccarton',  '4a279605-eaa8-470d-bcd4-0a9e3c9ab43b', 0, 0, 1),
    ('PAK''nSAVE Wainoni',    'PAK''nSAVE', 'Wainoni',    'dbca5e00-f7f9-43ae-91de-031ad16f8a92', 1, 1, 1),
    ('Trents Wholesale',      'Trents',     NULL,         NULL,                                   1, 1, 1)
) AS v(store_name, chain, suburb, store_code, is_main_store, is_preferred, is_active)
WHERE NOT EXISTS (SELECT 1 FROM dbo.stores s WHERE s.store_name = v.store_name);


-- Should list 15 tables
SELECT name AS table_name, create_date
FROM sys.tables
ORDER BY name;
