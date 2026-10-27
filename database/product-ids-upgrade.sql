-- =============================================================
-- PHASE 7 UPGRADE - every price points at a product (see
-- docs/database-design.md)
-- =============================================================
-- Run ONCE in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query, so the yellow bar says pantry),
-- with the website stopped (see the README for the full steps).
-- Then re-run database/warehouse.sql.
--
-- One transaction with XACT_ABORT ON: if any part fails, the whole
-- upgrade is rolled back and the tables are left exactly as they
-- were. It refuses to run a second time.
--
-- What it does:
-- 1. products gets a number key, product_id. The barcode becomes
--    optional (and still unique), because most products now come from
--    price checks and many never get one (Trents, loose produce).
--    products also gets package_size.
-- 2. store_products points at product_id: each chain's product code
--    -> the product. Trents has no codes, so its saved name stands in
--    ("name:Bulk Rice 10kg") - the same goes for older prices saved
--    before product codes.
-- 3. prices gets product_id (a foreign key - every price belongs to a
--    product) and its key becomes store + product + time. It also
--    gets the special-price columns: is_special, was_price (the normal
--    price when it's on special), special_type (special, club or
--    multibuy) and special_note.
-- 4. adds dbo.usp_link_barcode, which links a barcode to a
--    supermarket's product code - merging two products into one when
--    the barcode shows they're the same thing.
-- 5. removes the warehouse's product dimension and price fact, so
--    warehouse.sql can rebuild them on product_id.
--
-- Everything after the old tables are dropped runs through EXEC(...),
-- so SQL Server only checks it once the new tables exist.
-- =============================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF COL_LENGTH('dbo.products', 'product_id') IS NOT NULL
BEGIN
    RAISERROR('This database already has products.product_id - nothing was changed.', 16, 1);
    SET NOEXEC ON;
END;

IF OBJECT_ID('dbo.store_products', 'U') IS NULL OR COL_LENGTH('dbo.prices', 'product_code') IS NULL
BEGIN
    RAISERROR('The phase 5 tables were not found - check the yellow bar / database dropdown says pantry. Nothing was changed.', 16, 1);
    SET NOEXEC ON;
END;
GO

-- (SET NOEXEC ON above skips everything below if either check failed.)
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

-- Copies of the three tables being rebuilt.
SELECT * INTO #old_products FROM dbo.products;
SELECT * INTO #old_store_products FROM dbo.store_products;
SELECT * INTO #old_prices FROM dbo.prices;

DROP TABLE dbo.store_products;
DROP TABLE dbo.products;
DROP TABLE dbo.prices;

-- The warehouse's product dimension and price fact are rebuilt on
-- product_id by warehouse.sql.
IF OBJECT_ID('dw.fact_price', 'U') IS NOT NULL DROP TABLE dw.fact_price;
IF OBJECT_ID('dw.dim_product', 'U') IS NOT NULL DROP TABLE dw.dim_product;

EXEC(N'
-- -------------------------------------------------------------
-- PRODUCTS - one row per real product. product_id is its key; the
-- barcode is optional but unique. item_name, ingredient_name and
-- location_code come from scanning it at home; brand, product_name
-- and package_size from a supermarket.
-- -------------------------------------------------------------
CREATE TABLE dbo.products (
    product_id         INT IDENTITY(1,1) CONSTRAINT PK_products PRIMARY KEY,
    barcode            NVARCHAR(50)  NULL,
    item_name          NVARCHAR(200) NULL,
    ingredient_name    NVARCHAR(200) NULL
                       CONSTRAINT FK_products_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    brand              NVARCHAR(100) NULL,
    product_name       NVARCHAR(300) NULL,
    package_size       NVARCHAR(50)  NULL,
    quantity           DECIMAL(12,3) NULL,
    unit               NVARCHAR(20)  NULL,
    location_code      NVARCHAR(10)  NULL
                       CONSTRAINT FK_products_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    source             NVARCHAR(20)  NULL,
    added_by_person_id INT NULL
                       CONSTRAINT FK_products_person REFERENCES dbo.people(person_id),
    date_added         DATE NULL
);
CREATE UNIQUE INDEX UQ_products_barcode ON dbo.products(barcode) WHERE barcode IS NOT NULL;

-- -------------------------------------------------------------
-- STORE PRODUCTS - each chain''s own code for a product, pointing at
-- the product. Stores with no codes (Trents) use "name:" + the saved
-- name instead.
-- -------------------------------------------------------------
CREATE TABLE dbo.store_products (
    chain        NVARCHAR(50)  NOT NULL,
    product_code NVARCHAR(320) NOT NULL,
    product_id   INT NOT NULL CONSTRAINT FK_store_products_product REFERENCES dbo.products(product_id),
    date_linked  DATE NULL,
    CONSTRAINT PK_store_products PRIMARY KEY (chain, product_code)
);

-- -------------------------------------------------------------
-- PRICES - every saved price, never changed or deleted. One price per
-- product, per store, per moment.
-- -------------------------------------------------------------
CREATE TABLE dbo.prices (
    store_name    NVARCHAR(100) NOT NULL
                  CONSTRAINT FK_prices_store REFERENCES dbo.stores(store_name) ON UPDATE CASCADE,
    product_id    INT NOT NULL CONSTRAINT FK_prices_product REFERENCES dbo.products(product_id),
    date_checked  DATETIMEOFFSET(3) NOT NULL,
    item_name     NVARCHAR(300) NOT NULL,
    price         DECIMAL(10,2) NULL,
    cup_price     DECIMAL(10,2) NULL,
    cup_measure   NVARCHAR(50)  NULL,
    package_size  NVARCHAR(50)  NULL,
    original_name NVARCHAR(300) NULL,
    product_code  NVARCHAR(50)  NULL,
    is_special    BIT NOT NULL CONSTRAINT DF_prices_is_special DEFAULT 0,
    was_price     DECIMAL(10,2) NULL,
    special_type  NVARCHAR(20)  NULL CONSTRAINT CK_prices_special_type CHECK (special_type IN (''special'', ''club'', ''multibuy'')),
    special_note  NVARCHAR(100) NULL,
    CONSTRAINT PK_prices PRIMARY KEY (store_name, product_id, date_checked)
);

DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE ''New Zealand Standard Time'' AS DATE);

-- 1. Products scanned at home keep everything, now with a product_id.
INSERT INTO dbo.products (barcode, item_name, ingredient_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added)
SELECT barcode, item_name, ingredient_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added
FROM #old_products;

-- 2. Links made before (code -> barcode) become code -> product.
INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT o.chain, o.product_code, p.product_id, o.date_linked
FROM #old_store_products o
JOIN dbo.products p ON p.barcode = o.barcode;

-- 3. Each old price''s chain and code. A price saved without a code
-- uses the newest code saved for the same chain and name, if there is
-- one, otherwise "name:" + its saved name.
SELECT o.*, ISNULL(st.chain, o.store_name) AS chain, CAST(NULL AS NVARCHAR(320)) AS code_key
INTO #p
FROM #old_prices o
JOIN dbo.stores st ON st.store_name = o.store_name;

UPDATE x
SET code_key = COALESCE(x.product_code,
        (SELECT TOP 1 q.product_code FROM #p q
         WHERE q.chain = x.chain AND q.item_name = x.item_name AND q.product_code IS NOT NULL
         ORDER BY q.date_checked DESC),
        N''name:'' + x.item_name)
FROM #p x;

-- 4. A new product for every code that isn''t linked to one yet, named
-- from its newest price. MERGE (rather than INSERT) so OUTPUT can hand
-- back each new product_id next to the code it was made for.
DECLARE @made TABLE (product_id INT, chain NVARCHAR(50), product_code NVARCHAR(320));

MERGE dbo.products AS t
USING (
    SELECT k.chain, k.code_key, latest.original_name, latest.item_name, latest.package_size
    FROM (SELECT DISTINCT chain, code_key FROM #p) AS k
    CROSS APPLY (SELECT TOP 1 x.original_name, x.item_name, x.package_size FROM #p x
                 WHERE x.chain = k.chain AND x.code_key = k.code_key ORDER BY x.date_checked DESC) AS latest
    WHERE NOT EXISTS (SELECT 1 FROM dbo.store_products sp WHERE sp.chain = k.chain AND sp.product_code = k.code_key)
) AS s ON 1 = 0
WHEN NOT MATCHED THEN
    INSERT (product_name, package_size, source, date_added)
    VALUES (ISNULL(s.original_name, s.item_name), s.package_size, ''price check'', @today)
OUTPUT inserted.product_id, s.chain, s.code_key INTO @made;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT chain, product_code, product_id, @today FROM @made;

-- 5. Every price, now pointing at its product.
IF EXISTS (SELECT 1 FROM #p x JOIN dbo.store_products sp ON sp.chain = x.chain AND sp.product_code = x.code_key
           GROUP BY x.store_name, sp.product_id, x.date_checked HAVING COUNT(*) > 1)
    THROW 50001, ''Two prices would share the same store, product and moment - nothing was changed.'', 1;

INSERT INTO dbo.prices (store_name, product_id, date_checked, item_name, price, cup_price, cup_measure, package_size, original_name, product_code)
SELECT x.store_name, sp.product_id, x.date_checked, x.item_name, x.price, x.cup_price, x.cup_measure, x.package_size, x.original_name, x.product_code
FROM #p x
JOIN dbo.store_products sp ON sp.chain = x.chain AND sp.product_code = x.code_key;

IF (SELECT COUNT(*) FROM dbo.prices) <> (SELECT COUNT(*) FROM #old_prices)
   OR (SELECT COUNT(*) FROM dbo.products WHERE barcode IS NOT NULL) <> (SELECT COUNT(*) FROM #old_products)
    THROW 50002, ''Some rows did not come across - nothing was changed.'', 1;
');

COMMIT TRANSACTION;
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


-- After the upgrade: prices unchanged in number, barcode_products the
-- same as your old products count, and every price with a product.
SELECT 'prices' AS what, COUNT(*) AS how_many FROM dbo.prices
UNION ALL SELECT 'products', COUNT(*) FROM dbo.products
UNION ALL SELECT 'barcode_products', COUNT(*) FROM dbo.products WHERE barcode IS NOT NULL
UNION ALL SELECT 'store_products', COUNT(*) FROM dbo.store_products
UNION ALL SELECT 'products_made_from_names', COUNT(*) FROM dbo.store_products WHERE product_code LIKE 'name:%';

-- Each product with its prices, most-checked first, to eyeball.
SELECT TOP 20 p.product_id, p.product_name, p.package_size, COUNT(*) AS prices, COUNT(DISTINCT pr.store_name) AS stores
FROM dbo.products p
JOIN dbo.prices pr ON pr.product_id = p.product_id
GROUP BY p.product_id, p.product_name, p.package_size
ORDER BY prices DESC;
GO

SET NOEXEC OFF;
GO
