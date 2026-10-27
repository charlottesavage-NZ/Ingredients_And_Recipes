-- =============================================================
-- CREATE TABLES - the full pantry database (phase 7 design)
-- =============================================================
-- For building a NEW, empty database (e.g. a pantry_dev copy for
-- testing) - then run database/seed-ingredients.sql to add the
-- built-in ingredients and aliases. The live database was upgraded
-- with the one-off scripts in database/archive
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
-- else stocked, like cat food). Stock, recipe ingredients, products
-- and aliases all point at it. tin_quantity / tin_unit = the size of
-- one tin, for things that come in tins. minimum_quantity /
-- minimum_unit = "always want 2 tins of tomatoes", in the same base
-- unit as the stock (g / ml / each), or NULL for no minimum.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.ingredients', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ingredients (
        ingredient_name NVARCHAR(200) CONSTRAINT PK_ingredients PRIMARY KEY,
        tin_quantity    DECIMAL(12,3) NULL,
        tin_unit        NVARCHAR(20)  NULL,
        source          NVARCHAR(10)  NOT NULL CONSTRAINT DF_ingredients_source DEFAULT 'yours'
                        CONSTRAINT CK_ingredients_source CHECK (source IN ('built_in', 'yours')),
        minimum_quantity DECIMAL(12,3) NULL,
        minimum_unit     NVARCHAR(20)  NULL
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
-- PRODUCTS - one row per real product. product_id is its key; the
-- barcode is optional but unique (most products come from price
-- checks, and many never get one). Your name for it, its ingredient
-- and where it's kept come from scanning it at home; brand,
-- product_name and package_size from a supermarket.
-- source = 'openfoodfacts', 'scanned', 'price check', 'supermarket'
-- or 'typed'.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.products', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.products (
        product_id         INT IDENTITY(1,1) CONSTRAINT PK_products PRIMARY KEY,
        barcode            NVARCHAR(50)  NULL,
        item_name          NVARCHAR(200) NULL,       -- your name for it, e.g. Tinned Tomatoes
        ingredient_name    NVARCHAR(200) NULL
                           CONSTRAINT FK_products_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
        brand              NVARCHAR(100) NULL,
        product_name       NVARCHAR(300) NULL,       -- full name on the pack / at the supermarket
        package_size       NVARCHAR(50)  NULL,
        quantity           DECIMAL(12,3) NULL,       -- pack size, as a number and unit
        unit               NVARCHAR(20)  NULL,
        location_code      NVARCHAR(10)  NULL
                           CONSTRAINT FK_products_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
        source             NVARCHAR(20)  NULL,
        added_by_person_id INT NULL
                           CONSTRAINT FK_products_person REFERENCES dbo.people(person_id),
        date_added         DATE NULL
    );
    CREATE UNIQUE INDEX UQ_products_barcode ON dbo.products(barcode) WHERE barcode IS NOT NULL;
END;


-- -------------------------------------------------------------
-- STORE PRODUCTS - each supermarket chain's own code for a product
-- (e.g. PAK'nSAVE "5001949-EA-000"), pointing at the product. Per
-- chain, not per store: every branch uses the same code. Stores with
-- no codes (Trents) use "name:" + the saved name instead.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.store_products', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.store_products (
        chain        NVARCHAR(50)  NOT NULL,
        product_code NVARCHAR(320) NOT NULL,
        product_id   INT NOT NULL CONSTRAINT FK_store_products_product REFERENCES dbo.products(product_id),
        date_linked  DATE NULL,
        CONSTRAINT PK_store_products PRIMARY KEY (chain, product_code)
    );
END;


-- -------------------------------------------------------------
-- PRICES - every saved price, never changed or deleted, so the full
-- history is kept line by line. One price per product, per store, per
-- moment. price is what you'd pay; on special, was_price is the normal
-- price and special_type says what kind (multibuy: price is still the
-- single price, the deal is in special_note).
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.prices', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.prices (
        store_name    NVARCHAR(100) NOT NULL
                      CONSTRAINT FK_prices_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
        product_id    INT NOT NULL CONSTRAINT FK_prices_product REFERENCES dbo.products(product_id),
        date_checked  DATETIMEOFFSET(3) NOT NULL,
        item_name     NVARCHAR(300) NOT NULL,   -- tidied name used for grouping (savedPriceName in server.js)
        price         DECIMAL(10,2) NULL,
        cup_price     DECIMAL(10,2) NULL,
        cup_measure   NVARCHAR(50)  NULL,
        package_size  NVARCHAR(50)  NULL,
        original_name NVARCHAR(300) NULL,       -- exactly as the supermarket wrote it
        product_code  NVARCHAR(50)  NULL,       -- the supermarket's own code, see store_products
        is_special    BIT NOT NULL CONSTRAINT DF_prices_is_special DEFAULT 0,
        was_price     DECIMAL(10,2) NULL,
        special_type  NVARCHAR(20)  NULL CONSTRAINT CK_prices_special_type CHECK (special_type IN ('special', 'club', 'multibuy', 'extra_low')),
        special_note  NVARCHAR(100) NULL,
        CONSTRAINT PK_prices PRIMARY KEY (store_name, product_id, date_checked)
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
GO


-- -------------------------------------------------------------
-- USP_LINK_BARCODE - links a barcode to a chain's product code.
-- - neither known yet: a new product with that barcode, linked to the code
-- - only the code known: that product gets the barcode
-- - only the barcode known: the code is linked to that product
-- - both known, but they're two different products: they're the same
--   thing, so the code's product is folded into the barcode's one
--   (its prices and codes move across, blanks are filled in, and it's
--   deleted). The barcode's product is kept because it's the one
--   scanned at home, with your name for it.
-- -------------------------------------------------------------
CREATE OR ALTER PROCEDURE dbo.usp_link_barcode
    @chain        NVARCHAR(50),
    @product_code NVARCHAR(320),
    @barcode      NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE);

    BEGIN TRANSACTION;

    DECLARE @by_code INT = (SELECT product_id FROM dbo.store_products WITH (UPDLOCK, HOLDLOCK)
                            WHERE chain = @chain AND product_code = @product_code);
    DECLARE @by_barcode INT = (SELECT product_id FROM dbo.products WITH (UPDLOCK, HOLDLOCK) WHERE barcode = @barcode);

    IF @by_code IS NULL AND @by_barcode IS NULL
    BEGIN
        INSERT INTO dbo.products (barcode, source, date_added) VALUES (@barcode, 'supermarket', @today);
        SET @by_barcode = SCOPE_IDENTITY();
    END;

    IF @by_code IS NULL
        INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
        VALUES (@chain, @product_code, @by_barcode, @today);
    ELSE IF @by_barcode IS NULL
        UPDATE dbo.products SET barcode = @barcode WHERE product_id = @by_code;
    ELSE IF @by_code <> @by_barcode
    BEGIN
        UPDATE keep
        SET item_name       = COALESCE(keep.item_name, gone.item_name),
            ingredient_name = COALESCE(keep.ingredient_name, gone.ingredient_name),
            brand           = COALESCE(keep.brand, gone.brand),
            product_name    = COALESCE(keep.product_name, gone.product_name),
            package_size    = COALESCE(keep.package_size, gone.package_size)
        FROM dbo.products AS keep
        CROSS JOIN dbo.products AS gone
        WHERE keep.product_id = @by_barcode AND gone.product_id = @by_code;

        UPDATE dbo.prices SET product_id = @by_barcode WHERE product_id = @by_code;
        UPDATE dbo.store_products SET product_id = @by_barcode, date_linked = @today WHERE product_id = @by_code;
        DELETE FROM dbo.products WHERE product_id = @by_code;
    END;

    COMMIT TRANSACTION;
END;
GO

IF DATABASE_PRINCIPAL_ID('pantry_app') IS NOT NULL
    GRANT EXECUTE ON OBJECT::dbo.usp_link_barcode TO pantry_app;
GO
