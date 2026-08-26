# Quarry — feature checklist

Status is maintained as work proceeds. An item is checked only when it is
implemented **and** verified, with the evidence named. "Live" means driven
against a live Postgres; "CDP" means driven
through the running app window via `test/probe/drive.mjs`.

## Round 1 — daily-driver query tool

- [x] **1. Connect, introspect, schema tree** — live: relations across multiple schemas, PK/FK/index metadata
- [x] **2. Monaco editor, tabbed consoles, per-tab undo** — one model per tab
- [x] **3. Statement-under-caret execution** — dollar-quote aware splitter, 26 unit tests
- [x] **4. Chunked fetch + cancellation** — live: 500/500/1000 chunks; `pg_cancel_backend`
- [x] **5. Context-aware completion** — CDP: `from ap` → schemas + tables; `u.` → columns with PK/FK badges
- [x] **6. FK-driven `JOIN ... ON` pre-fill** — both directions, picks the right FK of two
- [x] **7. Hover documentation** — CDP: column shows type, NOT NULL, FK target, indexes
- [x] **8. Go to table (⌘B)** — CDP: opened the table under the caret in a new tab
- [x] **9. Auto-alias on table insert** — `order_line` → `ol`, deduped to `o2`
- [x] **10. Expand `*` to column list (⌘⇧X)** — leaves `count(*)` alone
- [x] **11. Query history (FTS5), CSV export, Keychain secrets, DBeaver import**

## Round 2 — the full gamut

- [x] **12. Highlight the statement ⌘⏎ will run** — CDP: tracks caret across statements
- [x] **13. Execute whole script (⌘⇧⏎)** — CDP: 5 statements, stops at first failure
- [x] **14. Multiple result tabs** — auto-focus on the first tab returning rows
- [x] **15. Server notices (`RAISE NOTICE`)** — CDP: `NOTICE: hello from quarry 42`
- [x] **16. Catalog auto-refresh after DDL** — new schema appears in the tree immediately
- [x] **17. EXPLAIN / EXPLAIN ANALYZE** — CDP: plan rows with costs and timings
- [x] **18. Manual/auto-commit toggle**
- [x] **19. Commit / Rollback** — CDP: another session saw `alpha` until Commit, then `COMMITTED`
- [x] **20. Correct tx state after a failed statement** — `TX failed`, Commit reports the rollback
- [x] **21. Warn before discarding an open transaction** — window close *and* ⌘Q
- [x] **22. UPDATE via cell edit** — live DB verified
- [x] **23. INSERT new rows** — serial id assigned by the sequence
- [x] **24. DELETE rows**
- [x] **25. Explicit SET NULL** — renders as `NULL` in the cell before submit
- [x] **26. Revert staged changes**
- [x] **27. Affected-row counts for INSERT/UPDATE/DELETE**
- [x] **28. CREATE / ALTER / DROP / TRUNCATE**
- [x] **29. `RETURNING` shows rows**
- [x] **30. Complex queries** — CTEs, window functions, scalar subqueries, data-modifying CTEs
- [x] **31. DDL view for a table** — tree context menu; serial columns collapse correctly
- [x] **32. Result filter box**
- [x] **33. Copy as CSV / JSON / INSERT**
- [x] **34. Independent audit** — two agents; every finding fixed (see below)

## Round 3 — DBA cockpit

- [x] **35. Graphical EXPLAIN plan tree** — CDP: `Sort 0.61 ms 596 → 626` over `Seq Scan 0.28 ms`,
      heat bars scaled to self time, filter line shown, >10x misestimates flagged.
      Self time is computed by netting off children, since `Actual Total Time` is
      cumulative and per-loop. 20 unit tests.
- [x] **36. Active sessions, blocking chains, held locks** — 3 diagnostics
- [x] **37. Index usage, unused indexes, duplicate indexes** — unused list emits a ready `DROP INDEX`
- [x] **38. Table sizes, dead tuples, cache hit ratio** — CDP: `app.batch_job_result 12 MB`
- [x] **39. Vacuum health** — last vacuum/analyze and xid age per table
- [x] **40. Slow queries via `pg_stat_statements`** — CDP: absent extension returns
      *"needs the pg_stat_statements extension"* with the exact `CREATE EXTENSION` to run
- [x] **41. Re-audit round 3** — an independent agent found 17 defects, listed below.
      All fixed and covered by tests; the plan arithmetic was re-verified against
      real parallel, CTE and nested-loop plans (self times now sum to 1.00x the
      reported execution time, previously 0.00x for CTEs and 2.9x for parallel).

All 11 diagnostics run through the ordinary query path, so each lands in the normal
grid with sorting, filtering, `Copy as` and CSV export already working.

## Bugs found by audit and fixed

| Severity | Defect | Fix |
|---|---|---|
| Critical | Open cursor deadlocked the connection permanently | `run()` releases the cursor; `refreshTableNames` no longer bypasses the queue |
| Critical | Packaged build ran the whole console — `currentStatement` read a DEV-only global | editor handed over by prop; build has zero `__editor` reads |
| Critical | `FROM t a, t b` self-join marked editable → wrote to the wrong row | real table-reference scanner replaces the regex |
| Critical | Exporting an `INSERT ... RETURNING` re-executed the write | export streams cached rows + the live cursor |
| High | Caret on a blank line ran the *last* statement in the buffer | `statementAt` returns the preceding statement |
| High | Trailing backslash swallowed the next statement | `standard_conforming_strings` honoured; `E''` still escapes |
| High | Submit reported success when it matched zero rows | batch fails with an explanatory error |
| High | Commit on an aborted transaction claimed success | performs the rollback and says so |
| High | ⌘Q bypassed the open-transaction guard | one guard shared by close and quit |
| Medium | Explicit NULL dropped on staged inserts | absent key = untouched, present null = NULL |
| Medium | `renderPreview` corrupted `$1` inside identifiers | scanner skips quoted runs |
| Medium | Apostrophe in a quoted identifier blanked the statement | `maskLiterals` skips quoted identifiers |
| Medium | Completion saw only the first table of a comma FROM | shared scanner |
| Low | `begin()` left the quit guard blind; ⌘R double-bound; ⌘⌫ shadowed Monaco | all corrected |

## Bugs found by the round-3 audit and fixed

| Severity | Defect | Fix |
|---|---|---|
| Critical | `EXPLAIN ANALYZE` of a DML statement ran in autocommit — the write was durable and Rollback had nothing to undo | `queryInTx` joins the user's transaction; plain EXPLAIN still opens none |
| High | A failed EXPLAIN left the previous plan on screen and never showed the error | plan cleared on failure; an error now outranks a plan in the results body |
| High | Parallel plans: worker CPU time subtracted from the Gather's wall clock, clamped to zero, so a worker's scan claimed 2.9x the whole query's runtime | worker time divided by participants; Gather self time is now small and positive |
| High | A materialised CTE was timed twice — once in its InitPlan and again in every CTE Scan | build time discounted as a budget drawn down across scans, not per scan |
| High | `actualRows` scaled by loops while `planRows` was not, flagging perfect estimates as off by 500x | both stay per-loop for the ratio, both scale for display |
| High | `unused_indexes` emitted `DROP INDEX` for exclusion-constraint and attached partition indexes, which Postgres refuses | those excluded, plus replica-identity and any constraint-backed index; `stats_reset` surfaced |
| High | `duplicate_indexes` grouped on `indkey`, which ignores predicate, opclass and expressions — unique partial indexes were offered for deletion | groups on the full `pg_get_indexdef` with the name stripped |
| Medium | Duplicate "wasted" space summed every copy including the one you keep | reports recoverable space only |
| Medium | `bloat` reported 0.0 % on a 90 %-bloated table, because a plain VACUUM zeroes dead tuples without shrinking the heap | description corrected to say what it measures; a real `pgstattuple_approx` report added |
| Medium | `vacuum` showed `xid_age = 2147483647` for every partitioned parent, sorting them to the top as fake wraparound emergencies | `relfrozenxid = 0` reported as NULL |
| Medium | `vacuum` ignored TOAST relfrozenxid, understating real wraparound risk by thousands of xids | TOAST age and a `worst_xid_age` added, and it drives the sort |
| Medium | `sessions`/`blocking` used `now()`, frozen at transaction start — durations went negative in manual-commit mode | `clock_timestamp()` |
| Low | `blocking` called `pg_blocking_pids` twice and inner-joined the blocker, losing alerts it could not resolve | one call, LEFT JOIN |
| Low | Staged grid edits survived the explain path as inert Submit buttons | edits cleared with the result |
| Low | `locks` rendered a tuple lock as though it were a relation lock | locktype and relation separated; scoped to this database |
| Low | `cache_hit` omitted TOAST I/O; `sizes` labelled `pg_table_size` as "heap" | TOAST columns added; heap uses `pg_relation_size` |
| Low | `Session.explain()` was dead but still tested — the tested path was not the shipped one | removed; the test now exercises `explainPlan` |

## Bugs found after round 3

| Severity | Defect | Fix |
|---|---|---|
| High | Autocomplete rendered as a list of icons with no text. A global `.main { flex-direction: column }` in `app.css` hijacked Monaco's own `.main` inside each suggest row, stacking icon/label/details vertically so every label fell outside its 20px row and was clipped. The completion engine was returning correct results throughout. | every generic class name namespaced to `q-*`; `test/css.test.ts` fails the build if an unscoped rule or component ever targets a name a bundled widget uses |
| Medium | The suggest and hover widgets had a themed background but no themed foreground, so Monaco emitted no `--vscode-…-foreground` variable and `color: var(…)` resolved to nothing | foreground, selected, highlight and hover colours all defined |
| Low | Renderer errors surfaced as `Error invoking remote method 'query:run': error: …` | the IPC wrapper is stripped so the database's own words show |

## Test suites

`npm run test:all` — 196 unit · 68 live driver · 49 Session.
The Session suite exists because that layer had no coverage and hid the deadlock
behind 205 otherwise-passing assertions.
