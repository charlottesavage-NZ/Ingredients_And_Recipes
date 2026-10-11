-- =============================================================
-- CREATE TABLES - the Azure SQL Database version of every CSV file
-- =============================================================
-- Run this ONCE in SSMS, logged in with your ADMIN login (not
-- pantry_app - that one is only allowed to read and change data,
-- not create tables):
--   1. In Object Explorer, right-click the "pantry" database
--      -> New Query
--   2. Check the database dropdown on the toolbar says "pantry"
--      (NOT master) - in Azure SQL each query window only works on
--      the database it was opened on, and USE can't switch it
--   3. Paste this whole file in and press F5
--
-- It's safe to run again: every table is wrapped in
-- "IF OBJECT_ID(...) IS NULL", which means "only create it if it
-- doesn't exist yet". So running it twice never wipes any data.
--
-- Each table mirrors one CSV file, with the same column names
-- wherever T-SQL allows it, so server.js changes as little as
-- possible. Notes on the T-SQL used:
--   NVARCHAR(n)        text up to n characters (the N means it can
--                      hold any language, e.g. accents and emoji)
--   NVARCHAR(MAX)      text with no practical limit (recipe steps)
--   DECIMAL(12,3)      an exact number with up to 3 decimal places -
--                      unlike FLOAT, 0.1 + 0.2 really is 0.3
--   BIGINT IDENTITY(1,1)  a number the database fills in itself,
--                      counting up 1, 2, 3... for each new row
--   BIT                yes/no, stored as 1/0
--   DATETIMEOFFSET     a date AND time that remembers its time zone
--   REFERENCES ... ON DELETE CASCADE
--                      "this row belongs to that recipe" - delete
--                      the recipe and these rows go with it
--
-- Text comparisons in Azure SQL ignore capitals by default (the
-- database's "collation" is case-insensitive), so "Tinned Tomatoes"
-- and "tinned tomatoes" count as the same name everywhere below -
-- the same way server.js already compares names.
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

        -- Which storage area. The CHECK stops anything else (like a
        -- typo) ever being saved in here.
        location  NVARCHAR(10)  NOT NULL
                  CHECK (location IN ('pantry', 'fridge', 'freezer', 'chest')),

        name      NVARCHAR(200) NOT NULL,
        quantity  DECIMAL(12,3) NOT NULL,
        unit      NVARCHAR(20)  NOT NULL,

        -- The "track" column: 'have' (a have-it item, like sauces),
        -- 'amount' (a counted item), or NULL if nobody's picked one
        -- and it's guessed from the name (see isHaveIt in server.js)
        track     NVARCHAR(10)  NULL
                  CHECK (track IN ('have', 'amount')),

        -- The "low" column: 1 if someone pressed L to mark it as
        -- running low (the CSV writes this as "yes" or blank)
        low       BIT           NOT NULL DEFAULT 0,

        -- Same rule as the merge in server.js: one row per item name
        -- + unit in each storage area, so adding 500 g of rice to the
        -- pantry tops up the existing rice row instead of adding a
        -- second one.
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

        -- How many people the amounts are written for. NULL on older
        -- recipes saved before the servings column existed.
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

        -- The tidied-up name used for grouping (home brands become
        -- "Home Brand", Woolworths pack sizes stripped off the end -
        -- see savedPriceName in server.js)
        item_name     NVARCHAR(300) NOT NULL,

        price         DECIMAL(10,2) NULL,
        cup_price     DECIMAL(10,2) NULL,
        cup_measure   NVARCHAR(50)  NULL,
        package_size  NVARCHAR(50)  NULL,
        store         NVARCHAR(100) NOT NULL,

        -- When the price was saved. SYSDATETIMEOFFSET() is T-SQL for
        -- "right now", filled in automatically if no time is given.
        date_checked  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),

        -- The product's name EXACTLY as the supermarket wrote it.
        -- NULL for rows saved before this column existed.
        original_name NVARCHAR(300) NULL
    );

    -- An index is like the index at the back of a book: it lets the
    -- database jump straight to one product's price history (newest
    -- first) instead of reading every row to find it.
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
        log_time  TIME(0)       NOT NULL,   -- NZ time, e.g. 18:05 (the (0) means no fractions of a second)
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


-- -------------------------------------------------------------
-- Finally, list every table so you can see they were all made.
-- You should see 11 rows in the Results tab at the bottom.
-- -------------------------------------------------------------
SELECT name AS table_name, create_date
FROM sys.tables
ORDER BY name;
