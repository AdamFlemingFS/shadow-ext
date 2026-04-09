# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Chrome extension (Manifest V3) called **Shadow DOM Selector for FullStory**. It lets users click any element on a page — including elements inside shadow DOM — and generates a FullStory-compatible CSS selector for it. The extension also scans pages for elements with specific data attributes and persists up to 20 saved selectors.

## Development

No build system. Pure vanilla JavaScript — no npm, no transpilation, no bundler.

**To run:** Load the directory as an unpacked extension in Chrome via `chrome://extensions/` → "Load unpacked".

**To test:** Open `test-page.html` locally in Chrome with the extension installed. It contains shadow DOM scenarios specifically for testing the picker and scan features.

## Architecture

The extension uses Chrome MV3's three-process model:

### `background.js` — Service Worker
- Routes messages between the content script and side panel
- Manages per-tab state in `chrome.storage.session` (picker active flag + last 50 results)
- Opens the side panel when the toolbar icon is clicked
- Injects `content.js` as a fallback if message delivery fails

### `content.js` — Content Script (IIFE, runs on all URLs, all frames)
The core logic. Key responsibilities:
- **Picker UI**: Creates an overlay + tooltip that follows the cursor; clicking captures the element
- **Selector generation**: `getBestSelector(el)` uses a priority hierarchy: `data-*` attributes → handwritten IDs → stable class names → `tag[attr]` → tag only. Heuristics skip auto-generated identifiers (webpack CSS modules, hashed classes, React/Angular/Scoped CSS prefixes).
- **Shadow DOM traversal**: Uses `e.composedPath()` to get the full path through shadow boundaries, then `buildSelectorSegments()` splits it into fragments at each `ShadowRoot`. The result is a FullStory selector (space-separated descendant selector) and a human-readable debug path with `>>` at shadow boundaries.
- **Page scanning**: `walkDOMDeep(root)` is a generator that recursively enters shadow roots; used by `scanPageForAttribute()` and `discoverStableAttributes()`

### `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — Side Panel UI
Three tabs:
- **Selection**: Displays picked elements with copyable selectors and a breakdown of shadow boundary segments
- **Scan**: Trigger attribute scanning and browse auto-discovered `data-*`/`aria-*`/`role` attributes
- **Saved**: Persist selectors (up to 20) to `chrome.storage.local` with custom names and a "done" checkbox

Communicates with background via a long-lived port (`chrome.runtime.connect({ name: "sidepanel" })`), plus one-shot messages for actions.

## Message Protocol

Side panel sends to background, which forwards to content:
- `ACTIVATE_PICKER` / `DEACTIVATE_PICKER`
- `DISCOVER_ATTRIBUTES` / `SCAN_PAGE` / `HIGHLIGHT_ELEMENT`
- `GET_TAB_STATE` / `CLEAR_RESULTS`

Content sends to background, which forwards to side panel:
- `SELECTOR_RESULT` — element was clicked; carries selector, debug path, and segment breakdown
- `PICKER_CANCELLED` — Escape key pressed
- `TAB_STATE` — current state (picker active + results array)

## Storage

- `chrome.storage.session` — tab state (survives service worker restarts, cleared when browser closes)
- `chrome.storage.local` — saved elements (persists across sessions)
