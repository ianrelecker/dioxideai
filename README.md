# Ollama Electron Chat GUI

Desktop chat interface for running local large language models through [Ollama](https://ollama.ai) with optional live web context pulled directly from DuckDuckGo search results.

## Highlights

 - Multi-chat workspace with a persistent history sidebar and one-click **New Chat** button.
 - Streaming responses from the Ollama `/api/chat` endpoint, rendered token-by-token.
 - “Thoughts” panel that exposes the assistant’s current step (searching, context retrieved, etc.).
 - Real web search integration powered by DuckDuckGo HTML scraping (no API key required).
 - Smart search planning that expands broad prompts (e.g., “latest news”) into focused queries for richer context.
 - Quick header controls (New Chat, web-search toggle, hide chats) plus a configurable theme picker.
 - Streaming controls with a Stop button and rich Markdown rendering (code blocks, hyperlinks).
 - Drop links directly into prompts; they’re added to the context alongside web results.
 - Local-first storage of every conversation in `app.getPath('userData')`.

## Requirements

- macOS (tested on Apple Silicon and Intel)
- [Node.js](https://nodejs.org/) 18+
- [Ollama](https://ollama.ai) installed and running (`ollama serve` or the background service)
- At least one Ollama model pulled locally, e.g. `ollama pull mistral` or `ollama pull llama3`

## Setup

```bash
git clone <this repo>
cd ollama-electron-gui
npm install
```

Ensure the Ollama service is active (`ps aux | grep ollama` or run `ollama serve`) and responds at `http://localhost:11434`.

## Development

```bash
npm run dev
```

This launches the Electron app with auto-reload enabled. Edit the files under `ollama-electron-gui/` and the window will refresh automatically.

## Usage

1. Open the app (`npm run dev` or the packaged build).
2. Click **+ New Chat** or pick an existing conversation from the sidebar (use **Hide Chats** to collapse/expand the history panel).
3. Select one of the locally installed Ollama models (models are discovered via `GET /api/tags`).
4. Type a prompt and press **Send** or hit **Enter** (use **Shift+Enter** for a newline).
5. The main process decides whether to augment the prompt with live context. If it does, it plans a set of DuckDuckGo queries (broad requests like “latest news” are expanded automatically), scrapes the top snippets with `cheerio`, and streams a reply from Ollama’s `/api/chat`.
6. Responses arrive in real time; include any http(s) links in your prompt and they’ll be added to the context automatically. Use the **Stop** button beside a live response to cancel long generations, and open the “Thoughts” disclosure to inspect retrieved context.
7. Use the header pills to toggle **Web Search** (defaults to on) and **Hide Chats**. Open the gear icon to adjust additional preferences.

Chats are saved automatically and reloaded when you reopen the application.

## Settings Panel

Click the gear icon in the chat header to open the modal preferences panel:

- **Automatic web search** – disable to keep the assistant strictly offline.
- **Open thoughts by default** – auto-expand the reasoning/context drawer for each reply.
- **Max search results** – slider (1–12) controlling how many snippets are collected from DuckDuckGo per prompt.
- **Theme** – choose Light, Dark, or follow the system theme (updates instantly).
- **Hide chat history sidebar** – collapse the previous chats panel by default.
- **Export conversation** – save the current chat as Markdown or PDF.

Preferences persist in `~/Library/Application Support/ollama-electron-gui/ollama-electron-settings.json`.

## Packaging (macOS)

To create a distributable `.app`, you can add [Electron Forge](https://www.electronforge.io/) or [Electron Builder](https://www.electron.build/). Example with Forge:

```bash
npm install --save-dev @electron-forge/cli
npx electron-forge import
npm run make
```

Forge outputs a signed (development) `.app` under `out/`. For production distribution, follow Apple’s notarization guidelines.

## Configuration

- **Web search toggle**: Controlled from the UI or programmatically via `createSearchPlan` helpers in `main.js`.
- **Context window**: The scraper keeps up to `searchResultLimit` snippets per query (UI slider). Tune logic in `performWebSearch`.
- **Streaming**: Responses already stream token-by-token. If you prefer batched replies, set `stream: false` in `ask-ollama` and remove the renderer’s stream listeners.

## Data Storage

Chat logs are serialized to JSON at:

- **macOS**: `~/Library/Application Support/ollama-electron-gui/ollama-electron-chats.json`

Preferences live alongside chats in `~/Library/Application Support/ollama-electron-gui/ollama-electron-settings.json`.

Delete those files to clear the history and reset settings.

## Troubleshooting

- **No models listed**: Confirm Ollama is running and models are installed (`ollama list`).
- **Slow responses**: Larger models take longer to load; the first query may be slow while the model warms up.
- **Blocked network**: DuckDuckGo HTML endpoint must be reachable; firewalls or VPNs can interfere with scraping.
- **Packaging issues**: When packaging with Forge/Builder, ensure native modules (`cheerio`) are handled automatically; rebuilding is not required because dependencies are pure JS.

## Future Enhancements

 - Local vector store to ground models on personal notes or documents.
- Theme picker (light/dark/system) and compact density modes.
 - Per-model defaults, temperature controls, and advanced Ollama parameters.

## Project Structure

```
ollama-electron-gui/
├── main.js        # Electron main process, Ollama + search integration
├── preload.js     # Secure IPC bridge for renderer
├── renderer.js    # Chat UI logic
├── index.html     # Renderer markup
├── styles.css     # Renderer styles
├── package.json   # Scripts and dependencies
└── README.md
```

## License

MIT © Your Name
