-- Optional upgrade for databases created before latency/jitter under load was
-- recorded. Run the block for your database type once. Without these columns
-- everything keeps working: telemetry.php falls back to the original columns
-- and simply doesn't store the under-load values. (SQLite databases are
-- upgraded automatically.)

-- MySQL / MariaDB
ALTER TABLE `speedtest_users`
  ADD COLUMN `dl_ping` text,
  ADD COLUMN `dl_jitter` text,
  ADD COLUMN `ul_ping` text,
  ADD COLUMN `ul_jitter` text;

-- PostgreSQL
-- ALTER TABLE speedtest_users
--   ADD COLUMN dl_ping text,
--   ADD COLUMN dl_jitter text,
--   ADD COLUMN ul_ping text,
--   ADD COLUMN ul_jitter text;

-- Microsoft SQL Server
-- ALTER TABLE [dbo].[speedtest_users] ADD
--   [dl_ping] [nvarchar](max) NULL,
--   [dl_jitter] [nvarchar](max) NULL,
--   [ul_ping] [nvarchar](max) NULL,
--   [ul_jitter] [nvarchar](max) NULL;
