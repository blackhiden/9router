# Database Schema — 9Router

Canonical persistence reference for `src/lib/db/schema.js` (`SCHEMA_VERSION = 2`) and `src/lib/db/repos/*`.

## Storage & Driver Stack
- **SQLite file**: `${DATA_DIR}/db/data.sqlite` (defaults to `~/.9router/db/data.sqlite`, `src/lib/db/paths.js`).
- **Backups**: `${DATA_DIR}/db/backups/` (taken automatically before schema version changes).
- **Driver fallback (`src/lib/db/driver.js`)**: `bun:sqlite` → `better-sqlite3` (Node `< 24`) → `node:sqlite` (Node `>= 22.5`) → `sql.js`. Bound strings are sanitized via `withNullByteSafeParams()` to strip NUL bytes.
- **PRAGMAs (`PRAGMA_SQL`)**: `journal_mode = WAL`, `synchronous = NORMAL`, `temp_store = MEMORY`, `mmap_size = 30000000`, `cache_size = -64000`, `foreign_keys = ON`, `busy_timeout = 5000`.

## Tables (`src/lib/db/schema.js`)

| Table | Primary Key | Columns & Purpose | Indexes |
|---|---|---|---|
| `_meta` | `key TEXT` | `value TEXT NOT NULL` — stores `schemaVersion`, metadata | — |
| `settings` | `id INTEGER` (`CHECK id = 1`) | `data TEXT NOT NULL` — JSON merged with `DEFAULT_SETTINGS` (`settingsRepo.js`) | — |
| `providerConnections` | `id TEXT` | `provider TEXT NOT NULL`, `authType TEXT NOT NULL`, `name TEXT`, `email TEXT`, `priority INTEGER`, `isActive INTEGER DEFAULT 1`, `data TEXT NOT NULL` (tokens/keys/cooldown/proxyPool), `createdAt TEXT NOT NULL`, `updatedAt TEXT NOT NULL` | `idx_pc_provider(provider)`, `idx_pc_provider_active(provider, isActive)`, `idx_pc_priority(provider, priority)` |
| `providerNodes` | `id TEXT` | `type TEXT`, `name TEXT`, `data TEXT NOT NULL` (`prefix`, `apiType`, `baseUrl`), `createdAt TEXT NOT NULL`, `updatedAt TEXT NOT NULL` | `idx_pn_type(type)` |
| `proxyPools` | `id TEXT` | `isActive INTEGER DEFAULT 1`, `testStatus TEXT`, `data TEXT NOT NULL` (`name`, `proxyUrl`, `noProxy`, `type`, `strictProxy`, `lastTestedAt`, `lastError`), `createdAt TEXT NOT NULL`, `updatedAt TEXT NOT NULL` | `idx_pp_active(isActive)`, `idx_pp_status(testStatus)` |
| `apiKeys` | `id TEXT` | `key TEXT UNIQUE NOT NULL`, `name TEXT`, `machineId TEXT`, `isActive INTEGER DEFAULT 1`, `createdAt TEXT NOT NULL`, `accessRestricted INTEGER DEFAULT 0`, `accessAllow TEXT` (JSON array of combos/models/providers) | `idx_ak_key(key)` |
| `combos` | `id TEXT` | `name TEXT UNIQUE NOT NULL`, `kind TEXT`, `models TEXT NOT NULL` (JSON array), `createdAt TEXT NOT NULL`, `updatedAt TEXT NOT NULL` | `idx_combo_name(name)` |
| `kv` | `(scope, key)` | `scope TEXT NOT NULL`, `key TEXT NOT NULL`, `value TEXT NOT NULL` (JSON) | `idx_kv_scope(scope)` |
| `usageHistory` | `id INTEGER AUTOINCREMENT` | `timestamp TEXT NOT NULL`, `provider TEXT`, `model TEXT`, `connectionId TEXT`, `apiKey TEXT`, `endpoint TEXT`, `promptTokens INTEGER DEFAULT 0`, `completionTokens INTEGER DEFAULT 0`, `cost REAL DEFAULT 0`, `status TEXT`, `tokens TEXT`, `meta TEXT` | `idx_uh_ts(timestamp DESC)`, `idx_uh_provider(provider)`, `idx_uh_model(model)`, `idx_uh_conn(connectionId)` |
| `usageDaily` | `dateKey TEXT` | `data TEXT NOT NULL` — daily JSON rollups (`byProvider`, `byModel`, `byAccount`, `byApiKey`, `byEndpoint`) | — |
| `requestDetails` | `id TEXT` | `timestamp TEXT NOT NULL`, `provider TEXT`, `model TEXT`, `connectionId TEXT`, `status TEXT`, `data TEXT NOT NULL` (redacted on read) | `idx_rd_ts(timestamp DESC)`, `idx_rd_provider(provider)`, `idx_rd_model(model)`, `idx_rd_conn(connectionId)` |

### `kv` Scopes
- `modelAliases` (`aliasRepo.js`): `key` = alias, `value` = target `provider/model` string
- `customModels` (`aliasRepo.js`): `key` = `${providerAlias}|${id}|${type}`, `value` = custom model definition (`caps`, `transport`, etc.)
- `mitmAlias` (`aliasRepo.js`): `key` = CLI tool name, `value` = alias map
- `pricing` (`pricingRepo.js`): `key` = provider id, `value` = per-model pricing overrides
- `disabledModels` (`disabledModelsRepo.js`): `key` = provider alias, `value` = array of disabled model ids

## Migrations & Repositories
- **Versioned migrations**: `src/lib/db/migrations/001-initial.js` creates tables/indexes idempotently.
- **Additive schema sync**: `syncSchemaFromTables()` (`src/lib/db/migrate.js`) adds any missing tables, columns (`accessRestricted`, `accessAllow`), and indexes on boot.
- **Legacy JSON import**: One-time migration from `db.json`, `usage.json`, `disabledModels.json`, and `request-details.json` guarded by `.migrated-from-json` and row-count assertions.
- **Barrel**: `src/lib/db/index.js` (and compat shim `src/lib/localDb.js`) exports all repo functions and `exportDb()`/`importDb()`.
