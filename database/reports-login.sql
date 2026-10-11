-- =============================================================
-- REPORTS LOGIN - a read-only login for Power BI (or any report tool)
-- =============================================================
-- Run once in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query), after reporting-views.sql.
-- Replace the password first, and keep it in your password manager.
--
-- pantry_reports can ONLY read the views in the reporting schema -
-- not the tables behind them, and it can't change anything.
-- =============================================================

CREATE USER pantry_reports WITH PASSWORD = 'PUT-A-NEW-STRONG-PASSWORD-HERE';

GRANT SELECT ON SCHEMA::reporting TO pantry_reports;
