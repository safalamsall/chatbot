# Browser-wide Research Collector Extension

Manifest V3 browser extension for Chrome/Chromium with:

- Browser-wide navigation/session collection
- Performance metrics and regression comparison
- DOM/network/storage/security inventories
- JavaScript Workbench with page/isolated/background execution contexts
- Search/filter, pause/resume, exclusions, retention, and export (JSON/CSV/Markdown)

## Development

```bash
cd /home/runner/work/chatbot/chatbot/extension
npm install
npm run dev
```

## Build

```bash
cd /home/runner/work/chatbot/chatbot/extension
npm run build
```

Built extension assets are emitted in `dist/`.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/home/runner/work/chatbot/chatbot/extension/dist`.
5. Click the extension action icon to open the dashboard page.

## Notes

- Some timing fields are unavailable for cross-origin resources without `Timing-Allow-Origin`.
- Restricted pages (`chrome://*`, extension pages, browser internal pages) are skipped safely.
- Metrics not exposed by the browser are labeled unavailable.
