# Code Graph — 9Router (MIBP Fork)

High-level module map, request flow, and package boundaries.

## Published Packages & Tooling
- **Root (`9router-app`)**: Next.js 16 dashboard + `/v1/*` API gateway (`custom-server.js`, `next.config.mjs`, `src/`, `open-sse/`).
- **`cli/` (`9router`)**: Separate CLI launcher & tray package (`cli/cli.js`, `cli/src/cli/`, `cli/hooks/`, `cli/scripts/`).
- **`tests/`**: Independent Vitest ESM package (`tests/vitest.config.js`, `tests/setup/isolateDataDir.js`, `tests/unit/`, `tests/translator/`, `tests/__baseline__/`).
- **`scripts/`**: Lockfile guard (`verify-lockfile-npm10.mjs`), undefined-identifier gate (`verify-no-undef.mjs`), standalone copy (`copy-standalone-assets.mjs`), registry scripts, and baseline realigner.

## Request & Runtime Flow

```text
Client / CLI Tool
  │
  ▼
custom-server.js (TCP client IP normalization; strips untrusted X-Forwarded-For)
  │
  ▼
src/dashboardGuard.js (PUBLIC_PREFIXES, PUBLIC_API_PATHS, PROTECTED_API_PATHS, LOCAL_ONLY_PATHS)
  │
  ├─► Public compatibility routes (next.config.mjs rewrites /v1/*, /v1beta/*, /codex/*, /responses/*, /systemone/*)
  │     │
  │     ▼
  │   src/app/api/v1/* & src/app/api/v1beta/*
  │     │  (chat, responses, messages, models, models/info, audio/voices, audio/speech,
  │     │   audio/transcriptions, images, embeddings, search, web, videos, systemone)
  │     ▼
  │   src/sse/handlers/* + src/sse/services/{keyAccess,model,auth,tokenRefresh}.js
  │     │
  │     ▼
  │   open-sse/handlers/{chatCore,embeddingsCore,imageGenerationCore,ttsCore,sttCore,searchCore}.js
  │     ├─► open-sse/rtk/* (fail-open tool_result / prompt compression)
  │     ├─► open-sse/translator/* (format detection & OpenAI-pivot / direct translation)
  │     └─► open-sse/executors/* (BaseExecutor + provider executors + proxyAwareFetch)
  │
  └─► Dashboard APIs (src/app/api/*) & UI (src/app/(dashboard)/*)
        │
        ▼
      src/lib/* (db/repos, oauth, network proxy fitness, ttsVoices, updateNotifier)
        │
        ▼
      ${DATA_DIR}/db/data.sqlite
```

## Module Map

- **`src/instrumentation.js`**: Server startup hooks — console log buffer, `open-sse/providers/catalogOverride.js`, `src/lib/modelCaps/overrides.js`, and `src/lib/modelCatalog/sync.js`.
- **`src/sse/`**: App-side gateway bridge (`handlers/*`, `services/keyAccess.js` per-key allow-list and `combosOnly` checks, `services/model.js`, `services/auth.js`, `services/tokenRefresh.js`, `services/systemoneRouter.js`, `services/antigravityQuota.js`, `services/backgroundTokenRefresh.js`, `utils/logger.js`).
- **`src/lib/`**:
  - `db/`: SQLite adapter chain (`driver.js`), schema (`schema.js`), migrations (`migrate.js`, `migrations/`), repositories (`repos/*`), barrel (`index.js` / `localDb.js`).
  - `oauth/`: OAuth flows, constants, PKCE/device helpers, token mappers.
  - `network/`: `connectionProxy.js`, `proxyTest.js`, `poolEgressProbe.js`, `stateSweeper.js`.
  - `ttsVoices.js`: Shared TTS voice-listing service (`VOICE_FETCHERS`) used directly by `/api/media-providers/tts/voices` and `/v1/audio/voices` (for `edge-tts`/`local-device`) without HTTP self-fetch.
  - `updateNotifier.js`: Fork git-tag update checker & SSE broadcaster.
- **`src/shared/`**: Cross-cutting constants (`providers.js`, `models.js`, `keyAccess.js`), helpers (`keyAccess.js`, `usageProviders.js`, `machineId.js`, `ssrfGuard.js`), and shared UI components (`ModelSelectModal.js`, `UsageStats.js`, `OAuthModal.js`, `UpdateNotificationPopup.js`).
- **`src/mitm/`**: Local MITM proxy child process for CLI tool interception.
- **`open-sse/`**: Standalone provider engine (`config/*`, `providers/registry/*` compiled into `providers/index.js`, `executors/*` via `executors/index.js`, `handlers/*`, `translator/*`, `services/*` including `proxyPoolFitness.js` + `tokenRefresh/` + `usage/`, `rtk/*`, `utils/*`).
