-- =============================================================
-- FIX: products that mixed up pack sizes (one-off, after phase 7)
-- =============================================================
-- Prices saved before product codes were read were matched to a
-- product by their saved name - and the saved name has the pack size
-- taken off. So e.g. Anchor Original Cream Cheese 250g and 2kg ended
-- up as ONE product. The website now matches by name AND size
-- ("name:Anchor Original Cream Cheese|250g"); this fixes the prices
-- already saved.
--
-- For every price with no product code:
-- 1. a price WITH a code, at the same chain, with the same name and
--    size -> it belongs to that code's product
-- 2. otherwise, a product already saved under that name and size
-- 3. otherwise, for each old product, the size with the most prices
--    keeps the old product (so products that were fine keep their
--    number), and any other size gets a product of its own
-- Then the old name-only links are removed, and products left with no
-- prices that were only ever made by a price check are deleted.
--
-- Run ONCE in SSMS on the pantry database (right-click pantry -> New
-- Query). One transaction: if anything fails, nothing changes. The
-- website can keep running - it's a few seconds. Re-run
-- EXEC dw.usp_load_warehouse; afterwards to refresh reports.
-- =============================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE);

-- Every price with no code, with its chain and a tidy size.
SELECT pr.store_name, pr.product_id AS old_product_id, pr.date_checked, pr.item_name,
       pr.original_name, pr.package_size,
       ISNULL(st.chain, st.store_name) AS chain,
       LOWER(REPLACE(ISNULL(pr.package_size, ''), ' ', '')) AS size_key,
       CAST(N'name:' + LEFT(pr.item_name, 250) + N'|' + LOWER(REPLACE(ISNULL(pr.package_size, ''), ' ', '')) AS NVARCHAR(320)) AS name_key,
       CAST(NULL AS INT) AS new_product_id
INTO #old
FROM dbo.prices AS pr
JOIN dbo.stores AS st ON st.store_name = pr.store_name
WHERE pr.product_code IS NULL;

-- 1. A coded price with the same chain, name and size.
UPDATE o
SET new_product_id = (
    SELECT TOP 1 c.product_id
    FROM dbo.prices AS c
    JOIN dbo.stores AS cs ON cs.store_name = c.store_name
    WHERE c.product_code IS NOT NULL
      AND ISNULL(cs.chain, cs.store_name) = o.chain
      AND c.item_name = o.item_name
      AND LOWER(REPLACE(ISNULL(c.package_size, ''), ' ', '')) = o.size_key
    ORDER BY c.date_checked DESC)
FROM #old AS o;

-- 2. A product already linked under that name and size.
UPDATE o
SET new_product_id = sp.product_id
FROM #old AS o
JOIN dbo.store_products AS sp ON sp.chain = o.chain AND sp.product_code = o.name_key
WHERE o.new_product_id IS NULL;

-- 3. Each remaining name + size group. The biggest group on each old
-- product keeps it - unless that product has coded prices, which
-- means it belongs to a supermarket code (and so to one size) already.
SELECT o.old_product_id, o.chain, o.name_key, COUNT(*) AS prices,
       MAX(o.package_size) AS package_size,
       (SELECT TOP 1 x.original_name FROM #old AS x WHERE x.chain = o.chain AND x.name_key = o.name_key ORDER BY x.date_checked DESC) AS product_name,
       ROW_NUMBER() OVER (PARTITION BY o.old_product_id ORDER BY COUNT(*) DESC, o.name_key) AS rank_on_old_product,
       CAST(NULL AS INT) AS new_product_id
INTO #groups
FROM #old AS o
WHERE o.new_product_id IS NULL
GROUP BY o.old_product_id, o.chain, o.name_key;

UPDATE g
SET new_product_id = g.old_product_id
FROM #groups AS g
WHERE g.rank_on_old_product = 1
  AND NOT EXISTS (SELECT 1 FROM dbo.prices AS c WHERE c.product_id = g.old_product_id AND c.product_code IS NOT NULL);

-- The others get a new product each. MERGE so OUTPUT can say which
-- new product_id went with which group.
DECLARE @made TABLE (product_id INT, chain NVARCHAR(50), name_key NVARCHAR(320), old_product_id INT);

MERGE dbo.products AS t
USING (SELECT * FROM #groups WHERE new_product_id IS NULL) AS s ON 1 = 0
WHEN NOT MATCHED THEN
    INSERT (product_name, package_size, source, date_added)
    VALUES (s.product_name, s.package_size, 'price check', @today)
OUTPUT inserted.product_id, s.chain, s.name_key, s.old_product_id INTO @made;

UPDATE g
SET new_product_id = m.product_id
FROM #groups AS g
JOIN @made AS m ON m.chain = g.chain AND m.name_key = g.name_key AND m.old_product_id = g.old_product_id;

UPDATE o
SET new_product_id = g.new_product_id
FROM #old AS o
JOIN #groups AS g ON g.old_product_id = o.old_product_id AND g.chain = o.chain AND g.name_key = o.name_key
WHERE o.new_product_id IS NULL;

IF EXISTS (SELECT 1 FROM #old WHERE new_product_id IS NULL)
    THROW 50001, 'Some prices did not get a product - nothing was changed.', 1;

-- Each name + size gets its own link (if it doesn't have one yet).
INSERT INTO dbo.store_products (chain, product_code, product_id, date_linked)
SELECT o.chain, o.name_key, MIN(o.new_product_id), @today
FROM #old AS o
WHERE NOT EXISTS (SELECT 1 FROM dbo.store_products AS sp WHERE sp.chain = o.chain AND sp.product_code = o.name_key)
GROUP BY o.chain, o.name_key;

-- Move the prices.
IF EXISTS (SELECT 1 FROM #old AS o
           JOIN dbo.prices AS pr ON pr.store_name = o.store_name AND pr.product_id = o.new_product_id AND pr.date_checked = o.date_checked
           WHERE o.new_product_id <> o.old_product_id)
    THROW 50002, 'A moved price would clash with another price at the same store and moment - nothing was changed.', 1;

UPDATE pr
SET product_id = o.new_product_id
FROM dbo.prices AS pr
JOIN #old AS o ON o.store_name = pr.store_name AND o.old_product_id = pr.product_id AND o.date_checked = pr.date_checked
WHERE o.new_product_id <> o.old_product_id;

-- The old name-only links ("name:..." with no "|size") aren't used any more.
DELETE FROM dbo.store_products
WHERE product_code LIKE N'name:%' AND CHARINDEX(N'|', product_code) = 0;

-- Products left with no prices, that were only ever made by a price
-- check (no barcode, never scanned at home), and their links.
SELECT p.product_id INTO #empty
FROM dbo.products AS p
WHERE p.source = 'price check' AND p.barcode IS NULL AND p.item_name IS NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.prices AS pr WHERE pr.product_id = p.product_id);

DELETE FROM dbo.store_products WHERE product_id IN (SELECT product_id FROM #empty);
DELETE FROM dbo.products WHERE product_id IN (SELECT product_id FROM #empty);

COMMIT TRANSACTION;

-- What changed.
SELECT 'prices moved to another product' AS what, COUNT(*) AS how_many FROM #old WHERE new_product_id <> old_product_id
UNION ALL SELECT 'new products made', COUNT(*) FROM @made
UNION ALL SELECT 'empty products removed', COUNT(*) FROM #empty;

-- Any product whose prices STILL have more than one pack size (should
-- be none, or only ones a supermarket gave two sizes the same code).
SELECT p.product_id, p.product_name,
       COUNT(DISTINCT LOWER(REPLACE(ISNULL(pr.package_size, ''), ' ', ''))) AS sizes,
       STRING_AGG(pr.package_size, ', ') AS sizes_seen
FROM dbo.products AS p
JOIN dbo.prices AS pr ON pr.product_id = p.product_id
GROUP BY p.product_id, p.product_name
HAVING COUNT(DISTINCT LOWER(REPLACE(ISNULL(pr.package_size, ''), ' ', ''))) > 1;
