-- =============================================================
-- CREATE TABLES - the Azure SQL Database version of every CSV file
-- =============================================================
-- Run once in SSMS with the ADMIN login, on the pantry database
-- (not master). Safe to re-run - each table is only created if it
-- doesn't exist yet. Column names match the CSV headers wherever
-- possible so server.js changes as little as possible.
-- The default collation is case-insensitive, matching the way
-- server.js already compares names.
-- =============================================================


-- -------------------------------------------------------------
-- INVENTORY - pantry.csv, fridge.csv, freezer.csv and chest.csv
-- all in ONE table, with a location column saying which storage
-- area each item is in.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.inventory', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inventory (
        id        BIGINT IDENTITY(1,1) PRIMARY KEY,

        location  NVARCHAR(10)  NOT NULL
                  CHECK (location IN ('pantry', 'fridge', 'freezer', 'chest')),

        name      NVARCHAR(200) NOT NULL,
        quantity  DECIMAL(12,3) NOT NULL,
        unit      NVARCHAR(20)  NOT NULL,

        -- 'have' / 'amount', or NULL = guess from the name (isHaveIt in server.js)
        track     NVARCHAR(10)  NULL
                  CHECK (track IN ('have', 'amount')),

        -- 1 = marked as running low ("yes" in the CSV)
        low       BIT           NOT NULL DEFAULT 0,

        -- Same rule as the merge in server.js: one row per name + unit per area
        CONSTRAINT inventory_one_row_per_item UNIQUE (location, name, unit)
    );
END;


-- -------------------------------------------------------------
-- RECIPES - recipes.csv
-- The ids stay exactly as they are now (e.g. "1786093115133", made
-- from Date.now() when the recipe was added), so nothing the
-- browser already knows about changes.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipes (
        id           NVARCHAR(20)  PRIMARY KEY,
        name         NVARCHAR(200) NOT NULL,
        instructions NVARCHAR(MAX) NOT NULL DEFAULT '',

        -- NULL on recipes saved before servings existed
        servings     INT           NULL
    );
END;


-- -------------------------------------------------------------
-- RECIPE INGREDIENTS - recipe_ingredients.csv
-- Many rows per recipe. Deleting a recipe deletes these too.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipe_ingredients', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipe_ingredients (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        recipe_id       NVARCHAR(20)  NOT NULL
                        REFERENCES dbo.recipes(id) ON DELETE CASCADE,
        ingredient_name NVARCHAR(200) NOT NULL,
        quantity        DECIMAL(12,3) NULL,
        unit            NVARCHAR(20)  NULL
    );
END;


-- -------------------------------------------------------------
-- RECIPE VOTES - recipe_votes.csv
-- The PRIMARY KEY on (recipe_id, person) means each person can only
-- have ONE vote per recipe - voting again changes it, same as now.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.recipe_votes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.recipe_votes (
        recipe_id NVARCHAR(20) NOT NULL
                  REFERENCES dbo.recipes(id) ON DELETE CASCADE,
        person    NVARCHAR(50) NOT NULL,
        vote      NVARCHAR(10) NOT NULL,
        PRIMARY KEY (recipe_id, person)
    );
END;


-- -------------------------------------------------------------
-- INGREDIENT ALIASES - ingredient_aliases.csv
-- Only YOUR aliases. The big built-in list stays in
-- ingredient-data.js, because it's part of the code, not data.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.ingredient_aliases', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ingredient_aliases (
        alias          NVARCHAR(200) PRIMARY KEY,
        canonical_name NVARCHAR(200) NOT NULL
    );
END;


-- -------------------------------------------------------------
-- PRICES - prices.csv
-- Pure history: one row per saved price, and rows are never changed
-- or deleted, so you can see every price over time line by line.
--
-- The id is now numbered by the database (1, 2, 3...) instead of
-- Date.now() - Excel had already mangled a lot of the old ids into
-- things like "1.78597E+12", and date_checked holds the exact time
-- anyway.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.prices', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.prices (
        id            BIGINT IDENTITY(1,1) PRIMARY KEY,

        -- tidied name used for grouping (see savedPriceName in server.js)
        item_name     NVARCHAR(300) NOT NULL,

        price         DECIMAL(10,2) NULL,
        cup_price     DECIMAL(10,2) NULL,
        cup_measure   NVARCHAR(50)  NULL,
        package_size  NVARCHAR(50)  NULL,
        store         NVARCHAR(100) NOT NULL,

        date_checked  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),

        -- exactly as the supermarket wrote it; NULL on older rows
        original_name NVARCHAR(300) NULL
    );

    -- one product's history, newest first
    CREATE INDEX prices_by_item ON dbo.prices (item_name, date_checked DESC);
END;


-- -------------------------------------------------------------
-- ACTIVITY LOG - activity_log.csv
-- Who added/used/changed what, and when. Like prices, rows are only
-- ever added, never changed. The CSV calls the first two columns
-- "date" and "time" - those are T-SQL type names, so they're
-- log_date and log_time in here to avoid confusion.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.activity_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.activity_log (
        id        BIGINT IDENTITY(1,1) PRIMARY KEY,
        log_date  DATE          NOT NULL,   -- NZ date, e.g. 2026-10-14
        log_time  TIME(0)       NOT NULL,   -- NZ time, e.g. 18:05
        person    NVARCHAR(50)  NULL,
        action    NVARCHAR(50)  NOT NULL,
        item      NVARCHAR(200) NULL,
        quantity  DECIMAL(12,3) NULL,
        unit      NVARCHAR(20)  NULL,
        location  NVARCHAR(50)  NULL,
        details   NVARCHAR(MAX) NULL
    );
END;


-- -------------------------------------------------------------
-- STOCK MINIMUMS - stock_minimums.csv
-- "Always want 2 tins of tomatoes" - only the items you've chosen
-- to set a minimum for. Stored in the same base unit as the stock
-- (g / ml / each), e.g. 2 tins of tomatoes is saved as 800 g.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.stock_minimums', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_minimums (
        name    NVARCHAR(200) NOT NULL,
        minimum DECIMAL(12,3) NOT NULL,
        unit    NVARCHAR(20)  NOT NULL,
        PRIMARY KEY (name, unit)
    );
END;


-- -------------------------------------------------------------
-- BARCODES - barcodes.csv
-- Every barcode you've scanned, remembered with the name YOU used
-- for it, so the second scan is instant.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.barcodes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.barcodes (
        barcode  NVARCHAR(50)  PRIMARY KEY,
        name     NVARCHAR(200) NOT NULL,
        quantity DECIMAL(12,3) NULL,
        unit     NVARCHAR(20)  NULL,
        location NVARCHAR(10)  NULL
    );
END;


-- -------------------------------------------------------------
-- MEAL PLAN - meal_plan.csv
-- One row per recipe planned for the week, with the day and how
-- many people it's for. Removing a recipe removes it from the plan.
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.meal_plan', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.meal_plan (
        id        BIGINT IDENTITY(1,1) PRIMARY KEY,
        day       NVARCHAR(10) NOT NULL,   -- e.g. monday
        recipe_id NVARCHAR(20) NOT NULL
                  REFERENCES dbo.recipes(id) ON DELETE CASCADE,
        people    INT          NULL
    );
END;


-- -------------------------------------------------------------
-- WATCH LIST - watch_list.csv
-- Products starred on the Price Checker page, which get re-checked
-- every morning and their price saved into dbo.prices.
-- (When the morning check last ran stays in the
-- watch_check_status.json file on the garage, NOT in here - the
-- server looks at it every 15 minutes, and asking the database that
-- often would keep waking it up and use up the free monthly
-- allowance.)
-- -------------------------------------------------------------
IF OBJECT_ID('dbo.watch_list', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.watch_list (
        id           NVARCHAR(20)  PRIMARY KEY,
        item_name    NVARCHAR(300) NOT NULL,
        store        NVARCHAR(100) NOT NULL,
        package_size NVARCHAR(50)  NULL,
        search_term  NVARCHAR(300) NULL,
        added_by     NVARCHAR(50)  NULL,
        date_added   DATETIMEOFFSET NULL
    );
END;


-- Should list 11 tables
SELECT name AS table_name, create_date
FROM sys.tables
ORDER BY name;
