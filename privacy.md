# Privacy Overview

This document explains what DioxideAi collects, why the data is collected, and where you can confirm each claim in the source. No legal jargon—just pointers straight to the code.

## What Never Leaves Your Machine

- **Prompts and replies stay local.** They live in `~/Library/Application Support/DioxideAi/…` and are never included in analytics payloads.  
  _Code: `renderer.js` (`recordUserMessage` / `recordAssistantMessage`, lines ~3383–3460) stores every message in `state.currentChat`, and `main.js` (`persistChats`, ~2560–2615) writes the cache to disk._
- **Attachments stream only to your model endpoint.** Analytics only record counts and total bytes—never filenames or content.  
  _Code: `renderer.js` (`applyAttachmentSelection`, ~1205–1285) captures attachments, while `buildAnalyticsPayload`, ~241–279, exports only `attachments_count` and `attachments_total_bytes`._
- **Saved chats and settings never sync to the cloud.**  
  _Code: `main.js` (`persistChats` and `persistSettings`, ~2560–2635) serializes JSON to the local `app.getPath('userData')` directory._
- **Web search context is kept inside the chat.** DuckDuckGo snippets are combined with your prompt and stored only as metadata in the conversation.  
  _Code: `main.js` (`performWebSearch`, ~2762–2885) fetches results; the renderer saves them in message metadata (`recordAssistantMessage`, ~3383–3460)._

## Analytics (Opt-in)

Amplitude telemetry is optional (Settings → Privacy). It helps answer: “How long did the model take?” or “Did model refresh fail?”

### Data captured per event

- **App identity:** version, release channel, platform, architecture, Electron/Chrome versions, OS version, locale, time zone, GPU adapter label, proxy flag.  
  _Code: `main.js` (`get-app-info`, ~704–763) and `renderer.js` (`hydrateAnalyticsContext`, ~292–322)._
- **Endpoint hints:** sanitized hostname, remote/local flag, use of llama.cpp/ChatGPT-compatible mode.  
  _Code: `renderer.js` (`getEndpointHostLabel`, `getEndpointIsRemote`, ~200–239)._
- **UI state:** theme preference, sidebar collapsed state, deep-research toggle, attachment counts/bytes.  
  _Code: `buildAnalyticsPayload`, ~241–279._
- **Chat context:** hashed chat ID (irreversible), prompt character count, attachment usage.  
  _Code: `hashIdentifier`, `buildAnalyticsPayload`, ~150–279; `trackResponseCompletedAnalytics`, ~876–907._
- **Performance spans:** model load/generation duration, total round-trip, attachment ingest time, web-search time, token counts, tokens/sec.  
  _Code: instrumentation in `handlePromptSubmit`, ~2745–2955, feeds `trackResponseCompletedAnalytics` / `trackResponseErrorAnalytics`, ~876–920._
- **Feature usage & errors:** model refresh success/failure, deep-research usage, attachment workflows, standardized `error_type` strings.  
  _Code: telemetry calls sprinkled through `renderer.js` (e.g., model refresh around ~2330, attachment handling around ~1205, response errors around ~2926+)._

### How data is sent

- **Local buffering + retry.** Events queue in `localStorage` and flush only when analytics are enabled and the app is online.  
  _Code: `renderer.js` (`loadAnalyticsQueueFromStorage`, `enqueueAnalyticsEvent`, `flushAnalyticsQueue`, ~324–417) plus `setShareAnalyticsPreference`, ~700–720._
- **Scrubbed payloads.** Strings are trimmed/capped at 256 chars, `NaN` values are dropped, and chat IDs are hashed (`h<integer>`).  
  _Code: `sanitizeAnalyticsProps`, `hashIdentifier`, `buildAnalyticsPayload`, ~150–279; device IDs come from `main.js` (`ensureAnalyticsDeviceId`, ~400–460)._

## What Is Not Collected

- **No raw prompts, answers, filenames, or attachment contents** are included in telemetry.  
  _Code: analytics helpers cited above export only counts/hashes._
- **No per-token transcripts or reasoning text.**  
  _Code: `trackResponseCompletedAnalytics` / `trackResponseErrorAnalytics` (lines ~876–920) emit only timing numbers + booleans._
- **No geolocation, IP address, or hardware serials.**  
  _Code: `get-app-info` (~704–763) exposes just OS version, locale, GPU name, and proxy flag._
- **No other telemetry SDKs.**  
  _Code: `package.json` lists the full dependency set (only `@amplitude/*` are analytics-related)._

## How to Opt Out

1. Open **Settings → Privacy**.  
2. Toggle **Share anonymous usage analytics** off. Pending events are cleared immediately.  
   _Code: `renderer.js` (`setShareAnalyticsPreference`, ~700–720) calls `window.api.initAnalytics({ optOut: true })` and stops queue flushing._

## Code Reference Cheat Sheet

- **Renderer logic:** `renderer.js` covers chat persistence, attachment handling, analytics queue, and opt-in logic.
- **IPC bridge:** `preload.js` exposes only whitelisted APIs via `contextBridge.exposeInMainWorld`.
- **Main process:** `main.js` handles disk persistence, Gain app info, and forwards events through Amplitude (`trackAnalyticsEventMain`, ~420–470).
- **Dependencies:** `package.json` shows all third-party libraries; there are no hidden tracking modules.

Questions or concerns? Open an issue on GitHub and point to the sections above—we’re happy to tighten things further if something looks off. DioxideAi’s philosophy is simple: keep conversations on your device and collect only coarse metrics that help make the app faster and more reliable.
