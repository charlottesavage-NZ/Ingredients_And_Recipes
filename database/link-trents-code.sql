-- =============================================================
-- LINK A TRENTS PRODUCT TO ITS CODES - one product at a time
-- =============================================================
-- For Trents prices saved before the search read Trents' codes: they
-- point at the right product already (linked by name), but have no
-- product_code. This adds the product's Trents SKU and Gilmours code
-- (data-fan) and fills in product_code on its old prices.
--
-- Run database/fix-pack-sizes.sql once FIRST - it splits products
-- that had two pack sizes mixed together.
--
-- How to use (SSMS, right-click pantry -> New Query):
-- 1. Run just PART 1 to list the Trents products still missing a code.
-- 2. For each one, look it up on Trents: right-click the product ->
--    Inspect, and read "SKU: ..." (the Trents code) and data-fan="..."
--    (the Gilmours code) from its tile.
-- 3. Fill in the four values in PART 2 and run PART 2. Repeat.
--    A name with an apostrophe needs it typed twice inside the quotes,
--    e.g. N'Campbell''s Real Stock' - it's still saved with just one.
-- Safe to run twice for the same product - nothing is added twice.
-- =============================================================


-- ---- PART 1: Trents products whose prices are missing a code
SELECT pr.item_name, pr.package_size, pr.product_id, COUNT(*) AS prices_without_code
FROM dbo.prices AS pr
WHERE pr.store_name = 'Trents Wholesale' AND pr.product_code IS NULL
GROUP BY pr.item_name, pr.package_size, pr.product_id
ORDER BY pr.item_name, pr.package_size;


-- ---- PART 2: link one product (fill these in, then run from here down)
DECLARE @name          NVARCHAR(300) = N'Masterfoods Barbeque Sauce';   -- exactly as in PART 1's item_name
DECLARE @package_size  NVARCHAR(50)  = N'4.7kg';                        -- exactly as in PART 1's package_size
DECLARE @trents_sku    NVARCHAR(50)  = N'3055712';                      -- "SKU: ..." on the Trents tile
DECLARE @gilmours_code NVARCHAR(50)  = N'5002194';                      -- data-fan="..." (or NULL if you don't have it)

SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE);

-- The product: the one this SKU already points at (if a newer price
-- linked it), otherwise the one saved under this name and size.
DECLARE @name_key NVARCHAR(320) = N'name:' + LEFT(@name, 250) + N'|' + LOWER(REPLACE(ISNULL(@package_size, ''), ' ', ''));
DECLARE @product_id INT = COALESCE(
    (SELECT product_id FROM dbo.store_products WHERE chain = 'Trents' AND product_code = @trents_sku),
    (SELECT product_id FROM dbo.store_products WHERE chain = 'Trents' AND product_code = @name_key));

IF @product_id IS NULL
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('No Trents product found under that name and size - check both match PART 1 exactly. Nothing was changed.', 16, 1);
    RETURN;
END;

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT 'Trents', @trents_sku, @product_id, @today
WHERE NOT EXISTS (SELECT 1 FROM dbo.store_products WHERE chain = 'Trents' AND product_code = @trents_sku);

INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT 'Gilmours', @gilmours_code, @product_id, @today
WHERE @gilmours_code IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.store_products WHERE chain = 'Gilmours' AND product_code = @gilmours_code);

UPDATE dbo.prices
SET product_code = @trents_sku
WHERE store_name = 'Trents Wholesale' AND product_id = @product_id AND product_code IS NULL
  AND LOWER(REPLACE(ISNULL(package_size, ''), ' ', '')) = LOWER(REPLACE(ISNULL(@package_size, ''), ' ', ''));

COMMIT TRANSACTION;

-- What it looks like now: every code for this product, and its prices.
SELECT chain, product_code, product_id, date_linked FROM dbo.store_products WHERE product_id = @product_id;
SELECT store_name, item_name, price, product_code, date_checked FROM dbo.prices WHERE product_id = @product_id ORDER BY date_checked DESC;
