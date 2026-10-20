-- =============================================================
-- PHASE 4 - STAR SCHEMA VIEWS for price reports (e.g. Power BI)
-- =============================================================
-- Views over dbo.prices and dbo.stores, in their own "reporting"
-- schema. Nothing is copied or changed - each view is a saved query,
-- so reports always see the latest prices.
--
--   reporting.vw_fact_price   one row per saved price (the fact)
--   reporting.dim_store       one row per store
--   reporting.dim_product     one row per product (tidied name)
--   reporting.dim_date        one row per day, NZ calendar
--   reporting.vw_latest_price newest price per product per store
--
-- Joins for a report: vw_fact_price.full_date -> dim_date.full_date,
-- vw_fact_price.store_name -> dim_store.store_name,
-- vw_fact_price.product_name -> dim_product.product_name.
--
-- Run in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query). Safe to re-run: CREATE OR ALTER
-- replaces each view with this version. The website doesn't use
-- these views, so it can stay running.
--
-- Times are stored as exact moments; every date here is the NZ date,
-- worked out with AT TIME ZONE 'New Zealand Standard Time' (which
-- handles daylight saving).
-- =============================================================

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'reporting')
    EXEC ('CREATE SCHEMA reporting');
GO


-- -------------------------------------------------------------
-- DIM_STORE - each store, with its chain for "by chain" reports.
-- -------------------------------------------------------------
CREATE OR ALTER VIEW reporting.dim_store AS
SELECT s.store_name,
       ISNULL(s.chain, 'Unknown') AS chain,
       s.suburb,
       s.is_main_store,
       s.is_preferred,
       s.is_active
FROM dbo.stores AS s;
GO


-- -------------------------------------------------------------
-- DIM_PRODUCT - each product, by the tidied name prices are saved
-- under. is_home_brand = a supermarket's own brand (Pams, Woolworths).
-- -------------------------------------------------------------
CREATE OR ALTER VIEW reporting.dim_product AS
SELECT d.product_name,
       CAST(CASE WHEN d.product_name LIKE 'Pams %' OR d.product_name LIKE 'Woolworths %' THEN 1 ELSE 0 END AS BIT) AS is_home_brand,
       CAST(d.first_checked AT TIME ZONE 'New Zealand Standard Time' AS DATE) AS first_checked,
       CAST(d.last_checked AT TIME ZONE 'New Zealand Standard Time' AS DATE) AS last_checked,
       d.times_checked,
       d.stores_checked,
       latest.original_name AS latest_original_name,
       latest.package_size AS latest_package_size
FROM (
    SELECT item_name AS product_name,
           MIN(date_checked) AS first_checked,
           MAX(date_checked) AS last_checked,
           COUNT(*) AS times_checked,
           COUNT(DISTINCT store_name) AS stores_checked
    FROM dbo.prices
    GROUP BY item_name
) AS d
OUTER APPLY (
    SELECT TOP 1 p.original_name, p.package_size
    FROM dbo.prices AS p
    WHERE p.item_name = d.product_name
    ORDER BY p.date_checked DESC
) AS latest;
GO


-- -------------------------------------------------------------
-- DIM_DATE - every day from the first saved price to today (NZ
-- dates), with the parts reports group by. Made from a 0-9999
-- number list, so it covers up to about 27 years of prices.
-- day_of_week: Monday = 1 ... Sunday = 7, whatever the server's
-- language settings (1 Jan 1900 was a Monday).
-- -------------------------------------------------------------
CREATE OR ALTER VIEW reporting.dim_date AS
WITH digits AS (
    SELECT n FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) AS v(n)
),
numbers AS (
    SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n AS n
    FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
),
bounds AS (
    SELECT CAST(MIN(date_checked) AT TIME ZONE 'New Zealand Standard Time' AS DATE) AS first_day,
           CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'New Zealand Standard Time' AS DATE) AS last_day
    FROM dbo.prices
),
days AS (
    SELECT DATEADD(DAY, n.n, b.first_day) AS full_date
    FROM bounds AS b
    JOIN numbers AS n ON n.n <= DATEDIFF(DAY, b.first_day, b.last_day)
)
SELECT full_date,
       YEAR(full_date) AS [year],
       DATEPART(QUARTER, full_date) AS [quarter],
       MONTH(full_date) AS month_number,
       DATENAME(MONTH, full_date) AS month_name,
       CONVERT(CHAR(7), full_date, 126) AS year_month,                  -- e.g. 2026-10
       DATEPART(ISO_WEEK, full_date) AS iso_week,
       (DATEDIFF(DAY, '19000101', full_date) % 7) + 1 AS day_of_week,
       DATENAME(WEEKDAY, full_date) AS day_name,
       CAST(CASE WHEN (DATEDIFF(DAY, '19000101', full_date) % 7) >= 5 THEN 1 ELSE 0 END AS BIT) AS is_weekend
FROM days;
GO


-- -------------------------------------------------------------
-- VW_FACT_PRICE - every saved price. change_since_last_check is the
-- difference from the previous price for the same product at the
-- same store (NULL for its first check).
-- -------------------------------------------------------------
CREATE OR ALTER VIEW reporting.vw_fact_price AS
SELECT CAST(p.date_checked AT TIME ZONE 'New Zealand Standard Time' AS DATE) AS full_date,
       p.store_name,
       p.item_name AS product_name,
       CAST(p.date_checked AT TIME ZONE 'New Zealand Standard Time' AS DATETIME2(0)) AS checked_at_nz,
       p.price,
       p.cup_price,
       p.cup_measure,
       p.package_size,
       p.original_name,
       p.price - LAG(p.price) OVER (PARTITION BY p.store_name, p.item_name ORDER BY p.date_checked) AS change_since_last_check
FROM dbo.prices AS p;
GO


-- -------------------------------------------------------------
-- VW_LATEST_PRICE - the newest price for each product at each store,
-- with which store is cheapest for that product right now (rank 1).
-- -------------------------------------------------------------
CREATE OR ALTER VIEW reporting.vw_latest_price AS
SELECT l.product_name,
       l.store_name,
       s.chain,
       l.price,
       l.cup_price,
       l.cup_measure,
       l.package_size,
       l.checked_at_nz,
       RANK() OVER (PARTITION BY l.product_name ORDER BY l.price) AS cheapest_rank
FROM (
    SELECT p.item_name AS product_name,
           p.store_name,
           p.price,
           p.cup_price,
           p.cup_measure,
           p.package_size,
           CAST(p.date_checked AT TIME ZONE 'New Zealand Standard Time' AS DATETIME2(0)) AS checked_at_nz,
           ROW_NUMBER() OVER (PARTITION BY p.store_name, p.item_name ORDER BY p.date_checked DESC) AS newest
    FROM dbo.prices AS p
) AS l
JOIN dbo.stores AS s ON s.store_name = l.store_name
WHERE l.newest = 1;
GO


-- -------------------------------------------------------------
-- Check: each view and how many rows it has.
-- -------------------------------------------------------------
SELECT 'vw_fact_price' AS view_name, COUNT(*) AS row_count FROM reporting.vw_fact_price
UNION ALL SELECT 'dim_store', COUNT(*) FROM reporting.dim_store
UNION ALL SELECT 'dim_product', COUNT(*) FROM reporting.dim_product
UNION ALL SELECT 'dim_date', COUNT(*) FROM reporting.dim_date
UNION ALL SELECT 'vw_latest_price', COUNT(*) FROM reporting.vw_latest_price;
GO
