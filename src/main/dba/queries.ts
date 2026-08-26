/**
 * Curated DBA diagnostics. They run through the ordinary query path, so each
 * one lands in the normal result grid and inherits sorting, filtering, copy and
 * CSV export rather than needing a bespoke view.
 */
export interface DbaQuery {
  key: string
  label: string
  group: 'Activity' | 'Indexes' | 'Storage' | 'Maintenance'
  description: string
  sql: string
  /** extension that must be installed for this to work */
  requires?: string
}

export const DBA_QUERIES: DbaQuery[] = [
  {
    key: 'sessions',
    label: 'Active Sessions',
    group: 'Activity',
    description: 'Every backend, what it is running and how long it has been waiting.',
    sql: `
SELECT pid,
       usename            AS "user",
       application_name   AS application,
       client_addr        AS client,
       state,
       wait_event_type    AS wait_type,
       wait_event,
       date_trunc('second', clock_timestamp() - state_change) AS in_state,
       date_trunc('second', clock_timestamp() - xact_start)   AS xact_age,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 200) AS query
  FROM pg_stat_activity
 WHERE datname = current_database()
   AND pid <> pg_backend_pid()
 ORDER BY (state = 'active') DESC, xact_start NULLS LAST`
  },
  {
    key: 'blocking',
    label: 'Blocking Chains',
    group: 'Activity',
    description: 'Sessions waiting on a lock, and the session holding it.',
    sql: `
SELECT waiting.pid                AS waiting_pid,
       waiting.usename            AS waiting_user,
       date_trunc('second', clock_timestamp() - waiting.query_start) AS waiting_for,
       left(regexp_replace(waiting.query, '\\s+', ' ', 'g'), 120) AS waiting_query,
       blocker.pid                AS blocking_pid,
       blocker.usename            AS blocking_user,
       blocker.state              AS blocking_state,
       left(regexp_replace(blocker.query, '\\s+', ' ', 'g'), 120) AS blocking_query
  FROM pg_stat_activity waiting
  -- One call only: pg_blocking_pids is volatile and walks the lock manager.
  CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) AS blocked(pid)
  -- LEFT so a blocker we cannot resolve degrades the row instead of losing the alert.
  LEFT JOIN pg_stat_activity blocker ON blocker.pid = blocked.pid
 ORDER BY waiting.query_start`
  },
  {
    key: 'locks',
    label: 'Held Locks',
    group: 'Activity',
    description: 'Locks held and awaited in this database, ungranted first.',
    sql: `
SELECT l.pid,
       a.usename  AS "user",
       l.locktype,
       -- Only a relation lock names a relation; a tuple or page lock merely
       -- carries the relation oid and must not be printed as if it were one.
       CASE WHEN l.locktype = 'relation' AND l.relation IS NOT NULL
            THEN l.relation::regclass::text END AS relation,
       l.mode,
       l.granted,
       left(regexp_replace(a.query, '\\s+', ' ', 'g'), 120) AS query
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.pid <> pg_backend_pid()
   AND (l.database IS NULL OR l.database = (SELECT oid FROM pg_database WHERE datname = current_database()))
 ORDER BY l.granted, l.pid`
  },
  {
    key: 'index_usage',
    label: 'Index Usage',
    group: 'Indexes',
    description: 'Scan counts per index. Zero scans on a large index is wasted write cost.',
    sql: `
SELECT s.schemaname AS schema,
       s.relname    AS "table",
       s.indexrelname AS index,
       s.idx_scan   AS scans,
       s.idx_tup_read AS tuples_read,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_relation_size(s.indexrelid) AS size_bytes,
       i.indisunique AS "unique",
       i.indisprimary AS primary
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
 ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC`
  },
  {
    key: 'unused_indexes',
    label: 'Unused Indexes',
    group: 'Indexes',
    description:
      'Never-scanned indexes that are genuinely droppable. Zero scans can also just mean stats were reset — check stats_reset.',
    sql: `
SELECT s.schemaname AS schema,
       s.relname    AS "table",
       s.indexrelname AS index,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_relation_size(s.indexrelid) AS size_bytes,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
       'DROP INDEX ' || quote_ident(s.schemaname) || '.' || quote_ident(s.indexrelname) || ';' AS drop_statement
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
 WHERE s.idx_scan = 0
   AND NOT i.indisprimary
   AND NOT i.indisunique
   -- An exclusion constraint owns its index; DROP INDEX is refused.
   AND NOT i.indisexclusion
   AND NOT i.indisreplident
   -- A partition's index attached to a parent index cannot be dropped alone.
   AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = i.indexrelid)
   -- Nor can any index backing a constraint.
   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
 ORDER BY pg_relation_size(s.indexrelid) DESC`
  },
  {
    key: 'duplicate_indexes',
    label: 'Duplicate Indexes',
    group: 'Indexes',
    description: 'Indexes whose full definition is identical apart from the name.',
    sql: `
SELECT schema, "table", indexes,
       pg_size_pretty(total_bytes - keep_bytes) AS recoverable,
       total_bytes - keep_bytes AS recoverable_bytes,
       definition
  FROM (
    SELECT n.nspname AS schema,
           c.relname AS "table",
           string_agg(ic.relname, ', ' ORDER BY ic.relname) AS indexes,
           sum(pg_relation_size(i.indexrelid)) AS total_bytes,
           max(pg_relation_size(i.indexrelid)) AS keep_bytes,
           count(*) AS n,
           min(def) AS definition
      FROM pg_index i
      JOIN pg_class c  ON c.oid = i.indrelid
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      -- Compare the whole definition with the index name stripped out. indkey
      -- alone ignores the predicate, opclass, sort order and access method, and
      -- is 0 for every expression column, so unrelated partial and expression
      -- indexes collapsed together as false duplicates.
      CROSS JOIN LATERAL (
        SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON ', 'ON ') AS def
      ) g
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     GROUP BY n.nspname, c.relname, g.def
  ) d
 WHERE n > 1
 -- One of them is kept, so only the rest is recoverable.
 ORDER BY total_bytes - keep_bytes DESC`
  },
  {
    key: 'sizes',
    label: 'Table Sizes',
    group: 'Storage',
    description: 'Heap, index and total size per relation.',
    sql: `
SELECT n.nspname AS schema,
       c.relname AS "table",
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid))       AS heap,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid)) AS toast,
       pg_size_pretty(pg_indexes_size(c.oid))        AS indexes,
       pg_total_relation_size(c.oid)                 AS total_bytes,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS est_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p','m')
   AND n.nspname NOT IN ('pg_catalog','information_schema')
 ORDER BY pg_total_relation_size(c.oid) DESC`
  },
  {
    key: 'bloat',
    label: 'Dead Tuples',
    group: 'Storage',
    description:
      'Tuples awaiting vacuum. NOT wasted space: a plain VACUUM zeroes this while leaving the heap just as large.',
    sql: `
SELECT schemaname AS schema,
       relname    AS "table",
       n_live_tup AS live,
       n_dead_tup AS dead,
       CASE WHEN n_live_tup + n_dead_tup = 0 THEN 0
            ELSE round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1)
       END AS dead_pct,
       pg_size_pretty(pg_total_relation_size(relid)) AS size,
       last_autovacuum,
       last_vacuum
  FROM pg_stat_user_tables
 ORDER BY n_dead_tup DESC`
  },
  {
    key: 'bloat_estimate',
    label: 'Table Bloat (measured)',
    group: 'Storage',
    description:
      'Actual free space per table, sampled. This is real bloat, unlike the dead-tuple count.',
    requires: 'pgstattuple',
    sql: `
SELECT n.nspname AS schema,
       c.relname AS "table",
       pg_size_pretty(a.table_len)                 AS size,
       round(a.approx_free_percent::numeric, 1)    AS free_pct,
       pg_size_pretty(a.approx_free_space::bigint) AS free_space,
       a.approx_free_space::bigint                 AS free_bytes,
       a.dead_tuple_count                          AS dead_tuples,
       pg_size_pretty(a.dead_tuple_len::bigint)    AS dead_len
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  -- _approx samples rather than reading every page, so it is safe to run on a
  -- large table; the exact form would rewrite-scan the whole heap.
  CROSS JOIN LATERAL pgstattuple_approx(c.oid) a
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog','information_schema')
 ORDER BY a.approx_free_space DESC`
  },
  {
    key: 'vacuum',
    label: 'Vacuum Health',
    group: 'Maintenance',
    description: 'When each table was last vacuumed and analyzed, and how far its xid has aged.',
    sql: `
SELECT s.schemaname AS schema,
       s.relname    AS "table",
       s.last_vacuum,
       s.last_autovacuum,
       s.last_analyze,
       s.last_autoanalyze,
       s.n_mod_since_analyze AS mods_since_analyze,
       -- A partitioned parent stores no rows and has relfrozenxid = 0, which
       -- age() reports as the maximum — it would sort to the top looking like
       -- imminent wraparound.
       CASE WHEN c.relfrozenxid <> 0 THEN age(c.relfrozenxid) END AS xid_age,
       -- A TOAST table ages independently and is usually what actually triggers
       -- anti-wraparound autovacuum.
       CASE WHEN t.relfrozenxid <> 0 THEN age(t.relfrozenxid) END AS toast_xid_age,
       greatest(
         CASE WHEN c.relfrozenxid <> 0 THEN age(c.relfrozenxid) ELSE 0 END,
         CASE WHEN t.relfrozenxid <> 0 THEN age(t.relfrozenxid) ELSE 0 END
       ) AS worst_xid_age
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid
  LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
 ORDER BY worst_xid_age DESC`
  },
  {
    key: 'slow_queries',
    label: 'Slowest Statements',
    group: 'Activity',
    description: 'Aggregate timings from pg_stat_statements.',
    requires: 'pg_stat_statements',
    sql: `
SELECT round(total_exec_time::numeric, 1) AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       round(max_exec_time::numeric, 2)   AS max_ms,
       rows,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 240) AS query
  FROM pg_stat_statements
 ORDER BY total_exec_time DESC
 LIMIT 100`
  },
  {
    key: 'cache_hit',
    label: 'Cache Hit Ratio',
    group: 'Storage',
    description: 'Heap and index buffer hit ratios per table.',
    sql: `
SELECT schemaname AS schema,
       relname    AS "table",
       heap_blks_read AS heap_read,
       heap_blks_hit  AS heap_hit,
       CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN NULL
            ELSE round(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 1)
       END AS heap_hit_pct,
       CASE WHEN coalesce(idx_blks_hit,0) + coalesce(idx_blks_read,0) = 0 THEN NULL
            ELSE round(100.0 * idx_blks_hit / (idx_blks_hit + idx_blks_read), 1)
       END AS index_hit_pct,
       -- TOAST traffic can dwarf the heap on a wide table; excluding it computes
       -- the ratio from a fraction of the real buffer activity.
       CASE WHEN coalesce(toast_blks_hit,0) + coalesce(toast_blks_read,0) = 0 THEN NULL
            ELSE round(100.0 * toast_blks_hit / (toast_blks_hit + toast_blks_read), 1)
       END AS toast_hit_pct,
       CASE WHEN (heap_blks_hit + heap_blks_read + coalesce(idx_blks_hit,0) + coalesce(idx_blks_read,0)
                  + coalesce(toast_blks_hit,0) + coalesce(toast_blks_read,0)) = 0 THEN NULL
            ELSE round(100.0 * (heap_blks_hit + coalesce(idx_blks_hit,0) + coalesce(toast_blks_hit,0))
                 / (heap_blks_hit + heap_blks_read + coalesce(idx_blks_hit,0) + coalesce(idx_blks_read,0)
                    + coalesce(toast_blks_hit,0) + coalesce(toast_blks_read,0)), 1)
       END AS overall_hit_pct
  FROM pg_statio_user_tables
 ORDER BY heap_blks_read + coalesce(idx_blks_read,0) + coalesce(toast_blks_read,0) DESC`
  }
]

export const findDbaQuery = (key: string): DbaQuery | undefined =>
  DBA_QUERIES.find((q) => q.key === key)
