# DioxideAi

DioxideAi is a desktop chat client for [Ollama](https://ollama.ai) that automatically augments every prompt with live DuckDuckGo context. Version 2 ships a revamped support dialog, per-install analytics, and a configurable Ollama endpoint for remote servers.

## Highlights

- Multi-chat workspace with persistent history and one-tap **New Chat**.
- Token streaming from Ollama’s `/api/chat`, plus stop/resume controls.
- Rich “Thoughts” drawer that mirrors the assistant’s stages (model loading, web search, context ingestion, generation).
- Automatic DuckDuckGo scraping on *every* user message (no API key required).
- Attachment support for local `.txt/.md/.json/...` files with per-file and per-request size policing.
- Customisable Ollama host (defaults to `http://localhost:11434`, but can target any reachable endpoint).
- Integrated analytics (opt-in, anonymised) powered by Amplitude.
- Secure support modal with direct QR code and BTC address – free to use, donations welcome.
- Local-first storage; chats and preferences live under `app.getPath('userData')`.

## Requirements

- macOS (Apple Silicon/Intel) with [Node.js](https://nodejs.org/) 18+
- [Ollama](https://ollama.ai) running locally or remotely
- At least one model pulled via `ollama pull llama3:8b`, `ollama pull mistral`, etc.

## Setup

```bash
git clone <repo>
cd dioxideai
npm install
npm run dev
```

The dev script launches Electron with hot reload. Keep the Ollama daemon running (`ollama serve`) or set a remote endpoint in Settings → Connection.

## Usage

1. Start the app and ensure a model is selected in the header picker (models are fetched from `/api/tags` on the configured host).
2. Compose a prompt (drag files into the composer or use **📎 Attach…**) and press **Send**.
3. The main process always gathers fresh web snippets for the prompt, streams the response from Ollama, and updates the Thoughts panel as context arrives.
4. Use the **Stop** button to cancel long generations, open Thoughts to inspect retrieved snippets, reasoning, and timing, and toggle **Hide Chats** when you need a distraction-free workspace.
5. Switch endpoints or refresh the model list from Settings without restarting.

Chats auto-save and reload on launch. Attachment limits are enforced (4 files, 512 KB each, 1 MB total).

## Settings

Open the gear icon to reveal the modal preferences panel:

- **Automatic web search** – opt out if you need fully offline replies.
- **Max search results** – number of snippets captured per prompt (1–12).
- **Theme** – system/light/dark/cream themes.
- **Hide chat history sidebar** – collapse the sidebar by default.
- **Ollama server endpoint** – URL used for `/api/tags` and `/api/chat` (defaults to `http://localhost:11434`).
- **Share anonymous usage analytics** – opt in/out of Amplitude tracking.
- **WinRAR-style support** – modal overlay with QR and BTC address.
- **Delete all chats** – wipe the history immediately.

All preferences persist at `~/Library/Application Support/DioxideAi/dioxideai-settings.json`.

## Packaging (macOS)

```bash
npm run dist
```

Electron Builder produces signed DMG/ZIP artifacts under `dist/` and bundles auto-update metadata (`latest-mac.yml`). Configure `build.publish` and export `GH_TOKEN` (or another publisher token) before releasing. Notarise and staple the DMG if you plan to distribute outside the Mac App Store.

## Tips & Troubleshooting

| Issue | Fix |
| --- | --- |
| No models listed | Verify Ollama is reachable at the configured endpoint (`curl <host>/api/tags`). |
| Slow first response | Large models need a warm-up load; subsequent calls are faster. |
| Attachments rejected | Ensure each file is ≤512 KB and the total payload ≤1 MB. |
| Analytics disabled | Toggle **Share anonymous usage analytics** inside Settings; the client honours the opt-out immediately. |
| Remote host change | Update the endpoint field, hit Enter (the model list refreshes automatically). |

## Project Structure

```
dioxideai/
├─ main.js         # Electron main process: Ollama + web search + persistence
├─ preload.js      # Secure IPC bridge
├─ renderer.js     # Chat UI logic & state
├─ index.html      # Renderer markup
├─ styles.css      # Renderer styles
├─ config/         # Local analytics key (gitignored) and sample template
└─ assets/         # Support graphics & app assets
```

