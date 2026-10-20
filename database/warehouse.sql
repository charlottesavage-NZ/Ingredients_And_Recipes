-- =============================================================
-- PHASE 6 - THE WAREHOUSE: a galaxy (constellation) schema
-- =============================================================
-- Real tables in their own "dw" schema, with surrogate keys, primary
-- keys and foreign keys, so SSMS and Power BI see a proper
-- dimensional model. Several fact tables share the same dimensions
-- (that's what makes it a galaxy), and two dimensions branch off
-- another (store -> chain, product -> ingredient), the snowflake part.
--
--   Facts (things that happened, or were true on a day)
--     dw.fact_price             one row per saved price
--     dw.fact_activity          one row per activity log line
--     dw.fact_stock_snapshot    what was in the house, one copy per day
--     dw.fact_recipe_ingredient each ingredient line of each recipe
--     dw.fact_recipe_vote       each person's like/dislike
--     dw.fact_meal_plan         this week's plan
--
--   Dimensions (what the facts are sliced by)
--     dw.dim_date, dw.dim_person, dw.dim_location, dw.dim_chain,
--     dw.dim_store, dw.dim_ingredient, dw.dim_product, dw.dim_recipe,
--     dw.dim_activity_type
--
-- The website never reads these - it keeps using the dbo tables.
-- dw.usp_load_warehouse copies the dbo data in: dimensions are
-- upserted (MERGE), so each row keeps its key for good, and a row that
-- has gone from the website's tables is kept with is_current = 0. The
-- facts are reloaded each time, except the stock snapshot, which adds
-- today's copy and keeps every earlier day - so stock levels build up
-- a history.
--
-- Key -1 in a dimension is the "Unknown" row, e.g. a log line with no
-- person, or a price whose product has no ingredient yet.
--
-- Run in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query). Safe to re-run: tables are only
-- created if missing, and the procedure is replaced. The website
-- keeps running.
-- =============================================================

-- Wrong database (e.g. master)? Say so, and skip everything below.
IF DB_NAME() <> 'pantry' AND DB_NAME() NOT LIKE 'pantry[_]%'
BEGIN
    RAISERROR('This is not a pantry database - check the yellow bar says pantry. Nothing was changed.', 16, 1);
    SET NOEXEC ON;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'dw')
    EXEC ('CREATE SCHEMA dw AUTHORIZATION dbo');
GO


-- -------------------------------------------------------------
-- DIMENSIONS
-- -------------------------------------------------------------

-- DIM_DATE - one row per day (NZ calendar). date_key is the date as a
-- number, e.g. 20261020. day_of_week: Monday = 1 ... Sunday = 7.
IF OBJECT_ID('dw.dim_date', 'U') IS NULL
CREATE TABLE dw.dim_date (
    date_key     INT          CONSTRAINT PK_dim_date PRIMARY KEY,
    full_date    DATE         NOT NULL CONSTRAINT UQ_dim_date_full_date UNIQUE,
    [year]       SMALLINT     NOT NULL,
    [quarter]    TINYINT      NOT NULL,
    month_number TINYINT      NOT NULL,
    month_name   NVARCHAR(10) NOT NULL,
    year_month   CHAR(7)      NOT NULL,
    iso_week     TINYINT      NOT NULL,
    day_of_week  TINYINT      NOT NULL,
    day_name     NVARCHAR(10) NOT NULL,
    is_weekend   BIT          NOT NULL
);
GO

-- DIM_PERSON - everyone who can log in.
IF OBJECT_ID('dw.dim_person', 'U') IS NULL
CREATE TABLE dw.dim_person (
    person_key INT IDENTITY(1,1) CONSTRAINT PK_dim_person PRIMARY KEY,
    person_id  INT          NULL CONSTRAINT UQ_dim_person_person_id UNIQUE,
    name       NVARCHAR(50) NOT NULL,
    is_current BIT          NOT NULL
);
GO

-- DIM_LOCATION - the storage areas.
IF OBJECT_ID('dw.dim_location', 'U') IS NULL
CREATE TABLE dw.dim_location (
    location_key  INT IDENTITY(1,1) CONSTRAINT PK_dim_location PRIMARY KEY,
    location_code NVARCHAR(10) NOT NULL CONSTRAINT UQ_dim_location_code UNIQUE,
    location_name NVARCHAR(50) NOT NULL,
    storage_type  NVARCHAR(10) NOT NULL,
    sort_order    INT          NOT NULL,
    is_current    BIT          NOT NULL
);
GO

-- DIM_CHAIN - Woolworths, PAK'nSAVE, Trents (snowflaked off dim_store).
IF OBJECT_ID('dw.dim_chain', 'U') IS NULL
CREATE TABLE dw.dim_chain (
    chain_key  INT IDENTITY(1,1) CONSTRAINT PK_dim_chain PRIMARY KEY,
    chain_name NVARCHAR(50) NOT NULL CONSTRAINT UQ_dim_chain_name UNIQUE
);
GO

-- DIM_STORE - each supermarket branch, pointing at its chain.
IF OBJECT_ID('dw.dim_store', 'U') IS NULL
CREATE TABLE dw.dim_store (
    store_key     INT IDENTITY(1,1) CONSTRAINT PK_dim_store PRIMARY KEY,
    store_name    NVARCHAR(100) NOT NULL CONSTRAINT UQ_dim_store_name UNIQUE,
    chain_key     INT NOT NULL CONSTRAINT FK_dim_store_chain REFERENCES dw.dim_chain(chain_key),
    suburb        NVARCHAR(50) NULL,
    is_main_store BIT NOT NULL,
    is_preferred  BIT NOT NULL,
    is_active     BIT NOT NULL,
    is_current    BIT NOT NULL
);
GO

-- DIM_INGREDIENT - the master list, with each tin size and minimum.
IF OBJECT_ID('dw.dim_ingredient', 'U') IS NULL
CREATE TABLE dw.dim_ingredient (
    ingredient_key   INT IDENTITY(1,1) CONSTRAINT PK_dim_ingredient PRIMARY KEY,
    ingredient_name  NVARCHAR(200) NOT NULL CONSTRAINT UQ_dim_ingredient_name UNIQUE,
    source           NVARCHAR(10)  NOT NULL,
    tin_quantity     DECIMAL(12,3) NULL,
    tin_unit         NVARCHAR(20)  NULL,
    minimum_quantity DECIMAL(12,3) NULL,
    minimum_unit     NVARCHAR(20)  NULL,
    has_minimum      BIT NOT NULL,
    is_current       BIT NOT NULL
);
GO

-- DIM_PRODUCT - each product prices were saved for, pointing at its
-- ingredient (snowflake). product_ref is the business key: the
-- barcode once the supermarket's code is linked to one
-- ("barcode:9415221000123"), otherwise the saved name ("name:Pams
-- Diced Tomatoes"). Every barcode in dbo.products is here too.
IF OBJECT_ID('dw.dim_product', 'U') IS NULL
CREATE TABLE dw.dim_product (
    product_key    INT IDENTITY(1,1) CONSTRAINT PK_dim_product PRIMARY KEY,
    product_ref    NVARCHAR(320) NOT NULL CONSTRAINT UQ_dim_product_ref UNIQUE,
    barcode        NVARCHAR(50)  NULL,
    product_name   NVARCHAR(300) NOT NULL,
    brand          NVARCHAR(100) NULL,
    ingredient_key INT NOT NULL CONSTRAINT FK_dim_product_ingredient REFERENCES dw.dim_ingredient(ingredient_key),
    is_home_brand  BIT NOT NULL,
    is_current     BIT NOT NULL
);
GO

-- DIM_RECIPE - each recipe.
IF OBJECT_ID('dw.dim_recipe', 'U') IS NULL
CREATE TABLE dw.dim_recipe (
    recipe_key  INT IDENTITY(1,1) CONSTRAINT PK_dim_recipe PRIMARY KEY,
    recipe_id   NVARCHAR(20)  NOT NULL CONSTRAINT UQ_dim_recipe_id UNIQUE,
    recipe_name NVARCHAR(200) NOT NULL,
    servings    INT NULL,
    is_current  BIT NOT NULL
);
GO

-- DIM_ACTIVITY_TYPE - each kind of log line. direction: +1 adds stock,
-- -1 takes it away, 0 changes nothing (or can't be counted).
IF OBJECT_ID('dw.dim_activity_type', 'U') IS NULL
CREATE TABLE dw.dim_activity_type (
    activity_type_key INT IDENTITY(1,1) CONSTRAINT PK_dim_activity_type PRIMARY KEY,
    action            NVARCHAR(50) NOT NULL CONSTRAINT UQ_dim_activity_type_action UNIQUE,
    category          NVARCHAR(20) NOT NULL,
    direction         SMALLINT     NOT NULL
);
GO

-- The "Unknown" rows (key -1) and the known kinds of log line.
SET IDENTITY_INSERT dw.dim_person ON;
IF NOT EXISTS (SELECT 1 FROM dw.dim_person WHERE person_key = -1)
    INSERT INTO dw.dim_person (person_key, person_id, name, is_current) VALUES (-1, NULL, 'Unknown', 1);
SET IDENTITY_INSERT dw.dim_person OFF;

SET IDENTITY_INSERT dw.dim_location ON;
IF NOT EXISTS (SELECT 1 FROM dw.dim_location WHERE location_key = -1)
    INSERT INTO dw.dim_location (location_key, location_code, location_name, storage_type, sort_order, is_current) VALUES (-1, '(unknown)', 'Unknown', 'unknown', 99, 1);
SET IDENTITY_INSERT dw.dim_location OFF;

SET IDENTITY_INSERT dw.dim_chain ON;
IF NOT EXISTS (SELECT 1 FROM dw.dim_chain WHERE chain_key = -1)
    INSERT INTO dw.dim_chain (chain_key, chain_name) VALUES (-1, 'Unknown');
SET IDENTITY_INSERT dw.dim_chain OFF;

SET IDENTITY_INSERT dw.dim_ingredient ON;
IF NOT EXISTS (SELECT 1 FROM dw.dim_ingredient WHERE ingredient_key = -1)
    INSERT INTO dw.dim_ingredient (ingredient_key, ingredient_name, source, has_minimum, is_current) VALUES (-1, '(unknown)', 'unknown', 0, 1);
SET IDENTITY_INSERT dw.dim_ingredient OFF;

INSERT INTO dw.dim_activity_type (action, category, direction)
SELECT v.action, v.category, v.direction
FROM (VALUES
    ('Added',                  'stock in',     1),
    ('Bought (shopping list)', 'stock in',     1),
    ('Took out',               'stock out',   -1),
    ('Used (I made this)',     'stock out',   -1),
    ('Removed',                'stock out',   -1),
    ('Edited',                 'stock change', 0),
    ('Cleared',                'stock change', 0),
    ('Cleared everything',     'stock change', 0),
    ('Undo',                   'stock change', 0),
    ('Marked running low',     'running low',  0),
    ('Cleared running low',    'running low',  0),
    ('Set minimum',            'minimum',      0),
    ('Removed minimum',        'minimum',      0),
    ('Added recipe',           'recipe',       0),
    ('Edited recipe',          'recipe',       0),
    ('Deleted recipe',         'recipe',       0)
) AS v(action, category, direction)
WHERE NOT EXISTS (SELECT 1 FROM dw.dim_activity_type t WHERE t.action = v.action);
GO


-- -------------------------------------------------------------
-- FACTS
-- -------------------------------------------------------------
-- Each fact's primary key is its grain - what one row is - so it
-- mirrors the website table it comes from. saved_name, logged_at,
-- item_name etc. are "degenerate dimensions": identifying values
-- kept on the fact, with no table of their own.

-- FACT_PRICE - one row per saved price.
IF OBJECT_ID('dw.fact_price', 'U') IS NULL
CREATE TABLE dw.fact_price (
    store_key     INT NOT NULL CONSTRAINT FK_fact_price_store REFERENCES dw.dim_store(store_key),
    saved_name    NVARCHAR(300) NOT NULL,
    checked_at    DATETIMEOFFSET(3) NOT NULL,
    date_key      INT NOT NULL CONSTRAINT FK_fact_price_date REFERENCES dw.dim_date(date_key),
    product_key   INT NOT NULL CONSTRAINT FK_fact_price_product REFERENCES dw.dim_product(product_key),
    checked_at_nz DATETIME2(0) NOT NULL,
    price         DECIMAL(10,2) NULL,
    cup_price     DECIMAL(10,2) NULL,
    cup_measure   NVARCHAR(50)  NULL,
    package_size  NVARCHAR(50)  NULL,
    original_name NVARCHAR(300) NULL,
    product_code  NVARCHAR(50)  NULL,
    change_since_last_check DECIMAL(10,2) NULL,
    CONSTRAINT PK_fact_price PRIMARY KEY (store_key, saved_name, checked_at)
);
GO

-- FACT_ACTIVITY - one row per activity log line. signed_quantity is
-- the quantity with the activity type's direction (+ in, - out).
IF OBJECT_ID('dw.fact_activity', 'U') IS NULL
CREATE TABLE dw.fact_activity (
    logged_at         DATETIMEOFFSET(7) NOT NULL,
    line_no           INT NOT NULL,
    date_key          INT NOT NULL CONSTRAINT FK_fact_activity_date REFERENCES dw.dim_date(date_key),
    person_key        INT NOT NULL CONSTRAINT FK_fact_activity_person REFERENCES dw.dim_person(person_key),
    location_key      INT NOT NULL CONSTRAINT FK_fact_activity_location REFERENCES dw.dim_location(location_key),
    ingredient_key    INT NOT NULL CONSTRAINT FK_fact_activity_ingredient REFERENCES dw.dim_ingredient(ingredient_key),
    activity_type_key INT NOT NULL CONSTRAINT FK_fact_activity_type REFERENCES dw.dim_activity_type(activity_type_key),
    logged_at_nz      DATETIME2(0) NOT NULL,
    item_as_typed     NVARCHAR(200) NULL,
    quantity          DECIMAL(12,3) NULL,
    unit              NVARCHAR(20)  NULL,
    signed_quantity   DECIMAL(12,3) NULL,
    details           NVARCHAR(MAX) NULL,
    CONSTRAINT PK_fact_activity PRIMARY KEY (logged_at, line_no)
);
GO

-- FACT_STOCK_SNAPSHOT - everything in the house, copied once a day.
IF OBJECT_ID('dw.fact_stock_snapshot', 'U') IS NULL
CREATE TABLE dw.fact_stock_snapshot (
    date_key       INT NOT NULL CONSTRAINT FK_fact_stock_snapshot_date REFERENCES dw.dim_date(date_key),
    location_key   INT NOT NULL CONSTRAINT FK_fact_stock_snapshot_location REFERENCES dw.dim_location(location_key),
    item_name      NVARCHAR(200) NOT NULL,
    unit           NVARCHAR(20)  NOT NULL,
    ingredient_key INT NOT NULL CONSTRAINT FK_fact_stock_snapshot_ingredient REFERENCES dw.dim_ingredient(ingredient_key),
    quantity       DECIMAL(12,3) NOT NULL,
    is_low         BIT NOT NULL,
    CONSTRAINT PK_fact_stock_snapshot PRIMARY KEY (date_key, location_key, item_name, unit)
);
GO

-- FACT_RECIPE_INGREDIENT - each ingredient line of each recipe.
IF OBJECT_ID('dw.fact_recipe_ingredient', 'U') IS NULL
CREATE TABLE dw.fact_recipe_ingredient (
    recipe_key      INT NOT NULL CONSTRAINT FK_fact_recipe_ingredient_recipe REFERENCES dw.dim_recipe(recipe_key),
    line_no         INT NOT NULL,
    ingredient_key  INT NOT NULL CONSTRAINT FK_fact_recipe_ingredient_ingredient REFERENCES dw.dim_ingredient(ingredient_key),
    name_as_written NVARCHAR(200) NOT NULL,
    quantity        DECIMAL(12,3) NULL,
    unit            NVARCHAR(20)  NOT NULL,
    CONSTRAINT PK_fact_recipe_ingredient PRIMARY KEY (recipe_key, line_no)
);
GO

-- FACT_RECIPE_VOTE - each person's vote. vote_value: like = 1,
-- dislike = -1, so SUM gives a recipe's score.
IF OBJECT_ID('dw.fact_recipe_vote', 'U') IS NULL
CREATE TABLE dw.fact_recipe_vote (
    recipe_key INT NOT NULL CONSTRAINT FK_fact_recipe_vote_recipe REFERENCES dw.dim_recipe(recipe_key),
    person_key INT NOT NULL CONSTRAINT FK_fact_recipe_vote_person REFERENCES dw.dim_person(person_key),
    vote       NVARCHAR(10) NOT NULL,
    vote_value SMALLINT NOT NULL,
    CONSTRAINT PK_fact_recipe_vote PRIMARY KEY (recipe_key, person_key)
);
GO

-- FACT_MEAL_PLAN - this week's plan (the plan has days, not dates).
IF OBJECT_ID('dw.fact_meal_plan', 'U') IS NULL
CREATE TABLE dw.fact_meal_plan (
    recipe_key   INT NOT NULL CONSTRAINT FK_fact_meal_plan_recipe REFERENCES dw.dim_recipe(recipe_key),
    day_of_week  TINYINT NOT NULL,
    day_name     NVARCHAR(10) NOT NULL,
    people_count INT NULL,
    CONSTRAINT PK_fact_meal_plan PRIMARY KEY (recipe_key, day_of_week)
);
GO


-- -------------------------------------------------------------
-- THE LOAD - copies the website's data into the warehouse, in one
-- transaction. The website runs it every morning after the watch
-- list check; run it yourself before a Power BI refresh with
--   EXEC dw.usp_load_warehouse;
-- -------------------------------------------------------------
CREATE OR ALTER PROCEDURE dw.usp_load_warehouse
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE);
    DECLARE @today_key INT = CONVERT(INT, CONVERT(CHAR(8), @today, 112));

    BEGIN TRANSACTION;

    -- ---- dim_date: from the first price or log line to the end of next year
    DECLARE @first DATE = (
        SELECT MIN(d) FROM (
            SELECT CAST(MIN(date_checked) AT TIME ZONE 'New Zealand Standard Time' AS DATE) FROM dbo.prices
            UNION ALL SELECT CAST(MIN(logged_at) AT TIME ZONE 'New Zealand Standard Time' AS DATE) FROM dbo.activity_log
            UNION ALL SELECT @today
        ) AS x(d)
    );
    DECLARE @last DATE = DATEFROMPARTS(YEAR(@today) + 1, 12, 31);

    WITH digits AS (
        SELECT n FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) AS v(n)
    ),
    numbers AS (
        SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n AS n
        FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
    ),
    days AS (
        SELECT DATEADD(DAY, n, @first) AS full_date FROM numbers WHERE n <= DATEDIFF(DAY, @first, @last)
    )
    INSERT INTO dw.dim_date (date_key, full_date, [year], [quarter], month_number, month_name, year_month, iso_week, day_of_week, day_name, is_weekend)
    SELECT CONVERT(INT, CONVERT(CHAR(8), d.full_date, 112)),
           d.full_date,
           YEAR(d.full_date),
           DATEPART(QUARTER, d.full_date),
           MONTH(d.full_date),
           DATENAME(MONTH, d.full_date),
           CONVERT(CHAR(7), d.full_date, 126),
           DATEPART(ISO_WEEK, d.full_date),
           (DATEDIFF(DAY, '19000101', d.full_date) % 7) + 1,
           DATENAME(WEEKDAY, d.full_date),
           CASE WHEN (DATEDIFF(DAY, '19000101', d.full_date) % 7) >= 5 THEN 1 ELSE 0 END
    FROM days AS d
    WHERE NOT EXISTS (SELECT 1 FROM dw.dim_date AS x WHERE x.full_date = d.full_date);

    -- ---- dim_person
    MERGE dw.dim_person AS t
    USING dbo.people AS s ON t.person_id = s.person_id
    WHEN MATCHED THEN UPDATE SET name = s.name, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (person_id, name, is_current) VALUES (s.person_id, s.name, 1)
    WHEN NOT MATCHED BY SOURCE AND t.person_key > 0 THEN UPDATE SET is_current = 0;

    -- ---- dim_location
    MERGE dw.dim_location AS t
    USING dbo.locations AS s ON t.location_code = s.location_code
    WHEN MATCHED THEN UPDATE SET location_name = s.location_name, storage_type = s.storage_type, sort_order = s.sort_order, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (location_code, location_name, storage_type, sort_order, is_current)
        VALUES (s.location_code, s.location_name, s.storage_type, s.sort_order, 1)
    WHEN NOT MATCHED BY SOURCE AND t.location_key > 0 THEN UPDATE SET is_current = 0;

    -- ---- dim_chain, then dim_store
    INSERT INTO dw.dim_chain (chain_name)
    SELECT DISTINCT s.chain FROM dbo.stores AS s
    WHERE s.chain IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dw.dim_chain AS c WHERE c.chain_name = s.chain);

    MERGE dw.dim_store AS t
    USING (
        SELECT s.store_name, ISNULL(c.chain_key, -1) AS chain_key, s.suburb, s.is_main_store, s.is_preferred, s.is_active
        FROM dbo.stores AS s
        LEFT JOIN dw.dim_chain AS c ON c.chain_name = s.chain
    ) AS s ON t.store_name = s.store_name
    WHEN MATCHED THEN UPDATE SET chain_key = s.chain_key, suburb = s.suburb, is_main_store = s.is_main_store,
        is_preferred = s.is_preferred, is_active = s.is_active, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (store_name, chain_key, suburb, is_main_store, is_preferred, is_active, is_current)
        VALUES (s.store_name, s.chain_key, s.suburb, s.is_main_store, s.is_preferred, s.is_active, 1)
    WHEN NOT MATCHED BY SOURCE THEN UPDATE SET is_current = 0;

    -- ---- dim_ingredient
    MERGE dw.dim_ingredient AS t
    USING dbo.ingredients AS s ON t.ingredient_name = s.ingredient_name
    WHEN MATCHED THEN UPDATE SET source = s.source, tin_quantity = s.tin_quantity, tin_unit = s.tin_unit,
        minimum_quantity = s.minimum_quantity, minimum_unit = s.minimum_unit,
        has_minimum = CASE WHEN s.minimum_quantity IS NULL THEN 0 ELSE 1 END, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (ingredient_name, source, tin_quantity, tin_unit, minimum_quantity, minimum_unit, has_minimum, is_current)
        VALUES (s.ingredient_name, s.source, s.tin_quantity, s.tin_unit, s.minimum_quantity, s.minimum_unit,
                CASE WHEN s.minimum_quantity IS NULL THEN 0 ELSE 1 END, 1)
    WHEN NOT MATCHED BY SOURCE AND t.ingredient_key > 0 THEN UPDATE SET is_current = 0;

    -- ---- dim_recipe
    MERGE dw.dim_recipe AS t
    USING dbo.recipes AS s ON t.recipe_id = s.recipe_id
    WHEN MATCHED THEN UPDATE SET recipe_name = s.name, servings = s.servings, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (recipe_id, recipe_name, servings, is_current) VALUES (s.recipe_id, s.name, s.servings, 1)
    WHEN NOT MATCHED BY SOURCE THEN UPDATE SET is_current = 0;

    -- ---- dim_activity_type: any new kind of log line, as "other"
    INSERT INTO dw.dim_activity_type (action, category, direction)
    SELECT DISTINCT a.action, 'other', 0 FROM dbo.activity_log AS a
    WHERE NOT EXISTS (SELECT 1 FROM dw.dim_activity_type AS t WHERE t.action = a.action);

    -- ---- Each price with the product it belongs to. If any price for
    -- the same store and saved name has its product code linked to a
    -- barcode, they all count as that barcode's product - so older
    -- prices saved before the link (or before phase 5) join up too.
    SELECT p.store_name, p.item_name, p.date_checked, p.price, p.cup_price, p.cup_measure,
           p.package_size, p.original_name, p.product_code, l.barcode,
           CAST(CASE WHEN l.barcode IS NOT NULL THEN N'barcode:' + l.barcode ELSE N'name:' + p.item_name END AS NVARCHAR(320)) AS product_ref
    INTO #price
    FROM dbo.prices AS p
    CROSS APPLY (
        SELECT MAX(sp.barcode) AS barcode
        FROM dbo.prices AS same
        JOIN dbo.stores AS st ON st.store_name = same.store_name
        JOIN dbo.store_products AS sp ON sp.chain = st.chain AND sp.product_code = same.product_code
        WHERE same.store_name = p.store_name AND same.item_name = p.item_name
    ) AS l;

    -- ---- dim_product: every barcode product, plus every saved name
    -- that isn't linked to a barcode yet
    MERGE dw.dim_product AS t
    USING (
        SELECT src.product_ref, src.barcode, src.product_name, src.brand,
               ISNULL(i.ingredient_key, -1) AS ingredient_key,
               CASE WHEN src.product_name LIKE 'Pams %' OR src.product_name LIKE 'Woolworths %'
                         OR src.brand LIKE 'Pams%' OR src.brand LIKE 'Woolworths%' THEN 1 ELSE 0 END AS is_home_brand
        FROM (
            SELECT N'barcode:' + pr.barcode AS product_ref, pr.barcode,
                   COALESCE(pr.item_name, pr.product_name,
                            (SELECT TOP 1 x.item_name FROM #price AS x WHERE x.barcode = pr.barcode ORDER BY x.date_checked DESC),
                            pr.barcode) AS product_name,
                   pr.brand, pr.ingredient_name
            FROM dbo.products AS pr
            UNION ALL
            SELECT DISTINCT x.product_ref, NULL, x.item_name, NULL, NULL
            FROM #price AS x
            WHERE x.barcode IS NULL
        ) AS src
        LEFT JOIN dw.dim_ingredient AS i ON i.ingredient_name = src.ingredient_name
    ) AS s ON t.product_ref = s.product_ref
    WHEN MATCHED THEN UPDATE SET barcode = s.barcode, product_name = s.product_name, brand = s.brand,
        ingredient_key = s.ingredient_key, is_home_brand = s.is_home_brand, is_current = 1
    WHEN NOT MATCHED BY TARGET THEN INSERT (product_ref, barcode, product_name, brand, ingredient_key, is_home_brand, is_current)
        VALUES (s.product_ref, s.barcode, s.product_name, s.brand, s.ingredient_key, s.is_home_brand, 1)
    WHEN NOT MATCHED BY SOURCE THEN UPDATE SET is_current = 0;

    -- ---- The facts (dimensions are never deleted, so facts go first)
    DELETE FROM dw.fact_price;
    DELETE FROM dw.fact_activity;
    DELETE FROM dw.fact_recipe_ingredient;
    DELETE FROM dw.fact_recipe_vote;
    DELETE FROM dw.fact_meal_plan;
    DELETE FROM dw.fact_stock_snapshot WHERE date_key = @today_key;

    INSERT INTO dw.fact_price (store_key, saved_name, checked_at, date_key, product_key, checked_at_nz, price, cup_price,
                               cup_measure, package_size, original_name, product_code, change_since_last_check)
    SELECT ds.store_key, x.item_name, x.date_checked,
           CONVERT(INT, CONVERT(CHAR(8), CAST(x.date_checked AT TIME ZONE 'New Zealand Standard Time' AS DATE), 112)),
           dp.product_key,
           CAST(x.date_checked AT TIME ZONE 'New Zealand Standard Time' AS DATETIME2(0)),
           x.price, x.cup_price, x.cup_measure, x.package_size, x.original_name, x.product_code,
           x.price - LAG(x.price) OVER (PARTITION BY x.store_name, x.product_ref ORDER BY x.date_checked)
    FROM #price AS x
    JOIN dw.dim_store AS ds ON ds.store_name = x.store_name
    JOIN dw.dim_product AS dp ON dp.product_ref = x.product_ref;

    -- A log line's item is the name as typed, so it's matched to an
    -- ingredient the way the site would: the ingredient itself, then an
    -- alias, then a stock row or recipe line with that name.
    INSERT INTO dw.fact_activity (logged_at, line_no, date_key, person_key, location_key, ingredient_key, activity_type_key,
                                  logged_at_nz, item_as_typed, quantity, unit, signed_quantity, details)
    SELECT a.logged_at, a.line_no,
           CONVERT(INT, CONVERT(CHAR(8), CAST(a.logged_at AT TIME ZONE 'New Zealand Standard Time' AS DATE), 112)),
           ISNULL(pe.person_key, -1),
           ISNULL(lo.location_key, -1),
           ISNULL(di.ingredient_key, -1),
           at.activity_type_key,
           CAST(a.logged_at AT TIME ZONE 'New Zealand Standard Time' AS DATETIME2(0)),
           a.item, a.quantity, a.unit,
           at.direction * ABS(a.quantity),
           a.details
    FROM dbo.activity_log AS a
    JOIN dw.dim_activity_type AS at ON at.action = a.action
    LEFT JOIN dw.dim_person AS pe ON pe.person_id = a.person_id
    LEFT JOIN dw.dim_location AS lo ON lo.location_code = a.location_code
    OUTER APPLY (
        SELECT TOP 1 m.ingredient_name
        FROM (
            SELECT ingredient_name, 1 FROM dbo.ingredients WHERE ingredient_name = a.item
            UNION ALL SELECT ingredient_name, 2 FROM dbo.ingredient_aliases WHERE alias = a.item
            UNION ALL SELECT ingredient_name, 3 FROM dbo.inventory WHERE name = a.item
            UNION ALL SELECT ingredient_name, 4 FROM dbo.recipe_ingredients WHERE name = a.item
        ) AS m(ingredient_name, preference)
        WHERE at.category <> 'recipe'
        ORDER BY m.preference
    ) AS found
    LEFT JOIN dw.dim_ingredient AS di ON di.ingredient_name = found.ingredient_name;

    INSERT INTO dw.fact_stock_snapshot (date_key, location_key, item_name, unit, ingredient_key, quantity, is_low)
    SELECT @today_key, lo.location_key, i.name, i.unit, ISNULL(di.ingredient_key, -1), i.quantity, i.low
    FROM dbo.inventory AS i
    JOIN dw.dim_location AS lo ON lo.location_code = i.location_code
    LEFT JOIN dw.dim_ingredient AS di ON di.ingredient_name = i.ingredient_name;

    INSERT INTO dw.fact_recipe_ingredient (recipe_key, line_no, ingredient_key, name_as_written, quantity, unit)
    SELECT dr.recipe_key, ri.sort_order, ISNULL(di.ingredient_key, -1), ri.name, ri.quantity, ri.unit
    FROM dbo.recipe_ingredients AS ri
    JOIN dw.dim_recipe AS dr ON dr.recipe_id = ri.recipe_id
    LEFT JOIN dw.dim_ingredient AS di ON di.ingredient_name = ri.ingredient_name;

    INSERT INTO dw.fact_recipe_vote (recipe_key, person_key, vote, vote_value)
    SELECT dr.recipe_key, ISNULL(pe.person_key, -1), v.vote,
           CASE v.vote WHEN 'like' THEN 1 WHEN 'dislike' THEN -1 ELSE 0 END
    FROM dbo.recipe_votes AS v
    JOIN dw.dim_recipe AS dr ON dr.recipe_id = v.recipe_id
    LEFT JOIN dw.dim_person AS pe ON pe.person_id = v.person_id;

    INSERT INTO dw.fact_meal_plan (recipe_key, day_of_week, day_name, people_count)
    SELECT dr.recipe_key, d.day_of_week, d.day_name, mp.people_count
    FROM dbo.meal_plan AS mp
    JOIN dw.dim_recipe AS dr ON dr.recipe_id = mp.recipe_id
    CROSS APPLY (SELECT CASE LOWER(mp.day)
            WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
            WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7 END AS day_of_week,
            UPPER(LEFT(mp.day, 1)) + LOWER(SUBSTRING(mp.day, 2, 20)) AS day_name) AS d
    WHERE d.day_of_week IS NOT NULL;

    COMMIT TRANSACTION;
END;
GO


-- -------------------------------------------------------------
-- WHO CAN USE IT
-- - the website (pantry_app) can run the load, and nothing else in dw
-- - Power BI (pantry_reports) can read the warehouse
-- -------------------------------------------------------------
IF DATABASE_PRINCIPAL_ID('pantry_app') IS NOT NULL
    GRANT EXECUTE ON OBJECT::dw.usp_load_warehouse TO pantry_app;
IF DATABASE_PRINCIPAL_ID('pantry_reports') IS NOT NULL
    GRANT SELECT ON SCHEMA::dw TO pantry_reports;
GO


-- -------------------------------------------------------------
-- First load, then how many rows each table has.
-- -------------------------------------------------------------
EXEC dw.usp_load_warehouse;

SELECT 'dim_date' AS table_name, COUNT(*) AS row_count FROM dw.dim_date
UNION ALL SELECT 'dim_person', COUNT(*) FROM dw.dim_person
UNION ALL SELECT 'dim_location', COUNT(*) FROM dw.dim_location
UNION ALL SELECT 'dim_chain', COUNT(*) FROM dw.dim_chain
UNION ALL SELECT 'dim_store', COUNT(*) FROM dw.dim_store
UNION ALL SELECT 'dim_ingredient', COUNT(*) FROM dw.dim_ingredient
UNION ALL SELECT 'dim_product', COUNT(*) FROM dw.dim_product
UNION ALL SELECT 'dim_recipe', COUNT(*) FROM dw.dim_recipe
UNION ALL SELECT 'dim_activity_type', COUNT(*) FROM dw.dim_activity_type
UNION ALL SELECT 'fact_price', COUNT(*) FROM dw.fact_price
UNION ALL SELECT 'fact_activity', COUNT(*) FROM dw.fact_activity
UNION ALL SELECT 'fact_stock_snapshot', COUNT(*) FROM dw.fact_stock_snapshot
UNION ALL SELECT 'fact_recipe_ingredient', COUNT(*) FROM dw.fact_recipe_ingredient
UNION ALL SELECT 'fact_recipe_vote', COUNT(*) FROM dw.fact_recipe_vote
UNION ALL SELECT 'fact_meal_plan', COUNT(*) FROM dw.fact_meal_plan;

-- Log lines whose item couldn't be matched to an ingredient (worth a
-- look - usually a name that's since been renamed or removed).
SELECT f.item_as_typed, t.action, COUNT(*) AS times
FROM dw.fact_activity AS f
JOIN dw.dim_activity_type AS t ON t.activity_type_key = f.activity_type_key
WHERE f.ingredient_key = -1 AND f.item_as_typed IS NOT NULL AND t.category <> 'recipe'
GROUP BY f.item_as_typed, t.action
ORDER BY times DESC;
GO

SET NOEXEC OFF;
GO
