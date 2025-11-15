# DioxideAi

DioxideAi is a desktop LLM chat client that automatically augments every prompt with live DuckDuckGo context. Version 3 ships a revamped support dialog, per-install analytics, and a configurable Ollama or ChatGPT compatible API endpoint for remote servers.

## Highlights

- **Multiple chats** – persistent histories with one-tap **New Chat** and Cmd/Ctrl + N shortcuts.
- **Live streaming + cancel** – models stream tokens in real time, and the send button flips to a stop button for instant cancellation.
- **Deep research mode** – optional multi-pass planning that gathers sources, logs progress, and inserts findings into your prompt.
- **Thoughts panel** – shows model load, web search, context ingestion, and timing breakdowns.
- **Automatic DuckDuckGo search** – every prompt gets fresh web snippets (no API key required).
- **Attachment intelligence** – drop `.txt/.md/.json/...` files with per-file and per-request limits plus truncation warnings.
- **Flexible endpoints** – point at local Ollama or OpenAI-compatible hosts (llama.cpp, LM Studio, etc.).
- **Themes + layout** – neon dark terminal look that tracks the OS or locks to light/dark, plus collapsible sidebar.
- **Privacy-aware analytics** – opt-in Amplitude events with detailed timing spans and hashed identifiers (see [`privacy.md`](privacy.md)).
- **Support-friendly** – in-app Buy Me a Coffee link and tutorial tips.
- **Local-first** – chats, attachments, and settings never leave `app.getPath('userData')`.

## Requirements

- macOS (Apple Silicon/Intel) with [Node.js](https://nodejs.org/) 18+
- [Ollama](https://ollama.ai) running locally or remotely, or a ChatGPT-compatible server such as llama.cpp/LM Studio.
- At least one model pulled on that endpoint via `ollama pull llama3:8b`, `ollama pull mistral`, etc., or the equivalent for your ChatGPT-compatible host.

## Setup

```bash
git clone https://github.com/ianrelecker/dioxideai.git
cd dioxideai
npm install
npm run dev
```

The dev script launches Electron with hot reload. Keep the Ollama daemon running (`ollama serve`) or set a remote endpoint in Settings → Connection.

## Usage

1. Start the app and ensure a model is selected in the header picker (models are fetched from `/api/tags` on the configured host, or `/v1/models` when the ChatGPT-compatible toggle is enabled for llama.cpp/LM Studio endpoints).
2. Compose a prompt (drag files into the composer or use **Attach file**) and press **Send**.
3. The main process always gathers fresh web snippets for the prompt, streams the response from Ollama, and updates the Thoughts panel as context arrives.
4. Use the **Stop** button to cancel long generations, open Thoughts to inspect retrieved snippets, reasoning, and timing, and toggle **Hide Chats** when you need a distraction-free workspace.
5. Switch endpoints or refresh the model list from Settings without restarting. Press **Cmd/Ctrl + N** anywhere to create a new chat instantly.

Chats auto-save and reload on launch. Attachment limits are enforced (4 files, 512 KB each, 1 MB total).

## Settings

Open the gear icon to reveal the modal preferences panel:

- **Automatic web search** – opt out if you need fully offline replies.
- **Max search results** – number of snippets captured per prompt (1–12).
- **Theme** – follow macOS/Windows appearance or force Light/Dark (neon terminal mode).
- **Model server endpoint** – URL used for `/api/tags` and `/api/chat` (defaults to `http://localhost:11434`). Point this at your ChatGPT-compatible server when not using Ollama.
- **llama.cpp / ChatGPT-compatible mode** – makes the app talk to OpenAI-style `/v1/models` and `/v1/chat/completions` endpoints (llama.cpp, LM Studio, etc.).
- **Share anonymous usage analytics** – opt in/out of Amplitude tracking.
- **Support DioxideAi** – in-app link to Buy Me a Coffee.
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
| No models listed | Verify the configured endpoint is reachable (`curl <host>/api/tags` for Ollama or `/v1/models` when llama.cpp mode is on). |
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

## License

This project is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read and build upon the source for personal or internal use, but any commercial/production deployment requires a separate commercial license from Ian Relecker.
