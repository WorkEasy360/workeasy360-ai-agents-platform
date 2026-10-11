-- Tables (and partitioned tables) per schema, from the catalog (visible to every role, unlike
-- information_schema). Run before and after the setup and every deploy step to prove that nothing
-- outside schema `agents` changed:
--
--   docker run --rm -i -e PGPASSWORD postgres:18-alpine psql "<conninfo>" -At -F ' ' < sql/00-table-counts.sql
SELECT n.nspname, count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%'
GROUP BY n.nspname
ORDER BY n.nspname;
