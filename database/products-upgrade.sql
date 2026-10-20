-- =============================================================
-- PHASE 5 UPGRADE - products by barcode (see docs/database-design.md)
-- =============================================================
-- Run ONCE in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query, so the yellow bar says pantry),
-- with the website stopped (see the README for the full steps).
--
-- One transaction with XACT_ABORT ON: if any part fails, the whole
-- upgrade is rolled back and the tables are left exactly as they
-- were. It refuses to run a second time.
--
-- What it does:
-- 1. barcodes becomes products - one row per real product, keyed by
--    its barcode. Your name for it and its ingredient are now
--    optional, so a product learned from a supermarket can be saved
--    before anyone has scanned it at home
-- 2. adds store_products - each supermarket chain's own product code
--    (e.g. PAK'nSAVE 5001949-EA-000) linked to a barcode
-- 3. adds product_code to prices, so a saved price knows exactly
--    which supermarket product it was
-- 4. moves stock_minimums onto the ingredients table (minimum_quantity
--    and minimum_unit) and drops stock_minimums
-- 5. puts the real brand back on prices saved as "Home Brand ..."
--    ("Home Brand Diced Tomatoes" -> "Pams Diced Tomatoes"), using
--    the supermarket's own name kept in original_name
--
-- Statements that use the NEW columns run through EXEC(...), so SQL
-- Server only checks them once those columns exist.
-- =============================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID('dbo.products', 'U') IS NOT NULL
BEGIN
    RAISERROR('This database already has the products table - nothing was changed.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('dbo.ingredients', 'U') IS NULL OR OBJECT_ID('dbo.barcodes', 'U') IS NULL
BEGIN
    RAISERROR('The phase 3 tables were not found - check the yellow bar / database dropdown says pantry. Nothing was changed.', 16, 1);
    RETURN;
END;

-- Each ingredient can only hold one minimum. If two minimums point at
-- the same ingredient (e.g. "Chopped Tomatoes" and "Tinned Tomatoes"),
-- they're listed here and nothing is changed - remove one on the
-- Inventory page, then run this again.
IF EXISTS (SELECT ingredient_name FROM dbo.stock_minimums GROUP BY ingredient_name HAVING COUNT(*) > 1)
BEGIN
    SELECT m.ingredient_name, m.name, m.minimum, m.unit
    FROM dbo.stock_minimums m
    WHERE m.ingredient_name IN (SELECT ingredient_name FROM dbo.stock_minimums GROUP BY ingredient_name HAVING COUNT(*) > 1)
    ORDER BY m.ingredient_name, m.name;
    RAISERROR('Two or more minimums point at the same ingredient (listed in Results) - nothing was changed.', 16, 1);
    RETURN;
END;

BEGIN TRANSACTION;

-- Counts before, to check against at the end.
DECLARE @barcodes INT = (SELECT COUNT(*) FROM dbo.barcodes);
DECLARE @minimums INT = (SELECT COUNT(*) FROM dbo.stock_minimums);
DECLARE @prices INT = (SELECT COUNT(*) FROM dbo.prices);

-- -------------------------------------------------------------
-- 1. products (replaces barcodes)
-- -------------------------------------------------------------
-- One row per real product, keyed by its barcode. Your name for it,
-- its ingredient and where it's kept are filled in when it's scanned
-- at home; brand, name and size can also come from a supermarket.
CREATE TABLE dbo.products (
    barcode            NVARCHAR(50)  CONSTRAINT PK_products PRIMARY KEY,
    item_name          NVARCHAR(200) NULL,
    ingredient_name    NVARCHAR(200) NULL
                       CONSTRAINT FK_products_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    brand              NVARCHAR(100) NULL,
    product_name       NVARCHAR(300) NULL,
    quantity           DECIMAL(12,3) NULL,
    unit               NVARCHAR(20)  NULL,
    location_code      NVARCHAR(10)  NULL
                       CONSTRAINT FK_products_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    source             NVARCHAR(20)  NULL,
    added_by_person_id INT NULL
                       CONSTRAINT FK_products_person REFERENCES dbo.people(person_id),
    date_added         DATE NULL
);

INSERT INTO dbo.products (barcode, item_name, ingredient_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added)
SELECT barcode, item_name, ingredient_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added
FROM dbo.barcodes;

DROP TABLE dbo.barcodes;

-- -------------------------------------------------------------
-- 2. store_products
-- -------------------------------------------------------------
-- Each supermarket chain's own code for a product, linked to its
-- barcode. Per chain, not per store: every PAK'nSAVE (and New World)
-- uses the same code for the same product.
CREATE TABLE dbo.store_products (
    chain        NVARCHAR(50)  NOT NULL,
    product_code NVARCHAR(50)  NOT NULL,
    barcode      NVARCHAR(50)  NOT NULL
                 CONSTRAINT FK_store_products_product REFERENCES dbo.products(barcode) ON UPDATE CASCADE,
    date_linked  DATE NULL,
    CONSTRAINT PK_store_products PRIMARY KEY (chain, product_code)
);

-- -------------------------------------------------------------
-- 3. prices.product_code
-- -------------------------------------------------------------
ALTER TABLE dbo.prices ADD product_code NVARCHAR(50) NULL;

-- -------------------------------------------------------------
-- 4. minimums move onto ingredients
-- -------------------------------------------------------------
ALTER TABLE dbo.ingredients ADD minimum_quantity DECIMAL(12,3) NULL, minimum_unit NVARCHAR(20) NULL;

EXEC sp_executesql N'
UPDATE i
SET minimum_quantity = m.minimum, minimum_unit = m.unit
FROM dbo.ingredients i
JOIN dbo.stock_minimums m ON m.ingredient_name = i.ingredient_name;

IF (SELECT COUNT(*) FROM dbo.ingredients WHERE minimum_quantity IS NOT NULL) <> @expected
    THROW 50001, ''Some minimums did not come across - nothing was changed.'', 1;
', N'@expected INT', @expected = @minimums;

DROP TABLE dbo.stock_minimums;

-- -------------------------------------------------------------
-- 5. "Home Brand ..." prices get their real brand back
-- -------------------------------------------------------------
-- The brand is the start of the supermarket's own name - longest
-- first, so "Pams Value" wins over "Pams".
UPDATE p
SET item_name = LEFT(p.original_name, b.brand_length) + SUBSTRING(p.item_name, LEN('Home Brand') + 1, 300)
FROM dbo.prices p
CROSS APPLY (SELECT CASE
        WHEN p.original_name LIKE 'Woolworths Essentials %' THEN 21
        WHEN p.original_name LIKE 'Pams Finest %' THEN 11
        WHEN p.original_name LIKE 'Pams Value %' THEN 10
        WHEN p.original_name LIKE 'Woolworths %' THEN 10
        WHEN p.original_name LIKE 'Pams %' THEN 4
    END AS brand_length) AS b
WHERE p.item_name LIKE 'Home Brand %' AND b.brand_length IS NOT NULL;

IF (SELECT COUNT(*) FROM dbo.prices) <> @prices
   OR (SELECT COUNT(*) FROM dbo.products) <> @barcodes
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('Some rows did not come across - nothing was changed.', 16, 1);
    RETURN;
END;

COMMIT TRANSACTION;

-- After the upgrade: products should equal your old barcode count,
-- ingredients_with_minimum your old minimum count, prices unchanged,
-- and prices_still_home_brand 0.
SELECT 'products' AS what, COUNT(*) AS how_many FROM dbo.products
UNION ALL SELECT 'store_products', COUNT(*) FROM dbo.store_products
UNION ALL SELECT 'prices', COUNT(*) FROM dbo.prices
UNION ALL SELECT 'prices_still_home_brand', COUNT(*) FROM dbo.prices WHERE item_name LIKE 'Home Brand%';

EXEC(N'SELECT ''ingredients_with_minimum'' AS what, COUNT(*) AS how_many FROM dbo.ingredients WHERE minimum_quantity IS NOT NULL;');

-- A few of the renamed prices, to eyeball.
SELECT TOP 10 store_name, item_name, original_name
FROM dbo.prices
WHERE original_name LIKE 'Pams%' OR original_name LIKE 'Woolworths%'
ORDER BY date_checked DESC;
