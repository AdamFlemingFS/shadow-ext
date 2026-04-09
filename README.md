# Shadow DOM Selector for FullStory

A Chrome extension that generates CSS selectors for any element on a page — including elements buried inside shadow DOM — in a format compatible with FullStory's Data Studio CSS Selector field.

## The Problem

Modern web apps built with Stencil, Lit, or other web component frameworks render large portions of their UI inside shadow roots. Standard CSS selectors can't reach these elements, making it difficult to target them in FullStory for event capture, funnels, or custom data.

## What It Does

**Pick any element on the page** — click it and the extension produces a FullStory-compatible selector that traverses shadow boundaries, plus a human-readable debug path showing exactly which shadow roots are crossed.

**Scan for elements by attribute** — discover all `data-*`, `aria-label`, and `role` attributes present on the page, then drill into any attribute to see every unique value with its generated selector. Useful for bulk-capturing elements like cards, buttons, or navigation items.

**Save selectors** — bookmark up to 20 selectors with custom names and a "done" checkbox for tracking which ones have been added to FullStory.

## How It Works

### Selector Generation

The extension uses `event.composedPath()` on click events, which returns the full DOM path through any shadow boundary — including closed shadow roots. It splits this path into fragments at each `ShadowRoot` and generates a selector from the most stable identifiers available, prioritising:

1. `data-*` attributes (most stable — `[data-test-id="submit-btn"]`)
2. Handwritten IDs (`#user-profile`)
3. Custom element tag names (`my-button`)
4. Stable class names (heuristically filtered to exclude framework-generated classes)
5. Meaningful attributes (`aria-label`, `role`)
6. Tag name only (last resort)

Within each shadow fragment, the extension finds the **closest ancestor with a `data-*` attribute** to the target element, producing specific anchored selectors like `[data-test-id="card"] img` rather than falling back to generic class names.

### Shadow DOM Path

Alongside the FullStory selector, the extension shows a debug path using `>>` to mark each shadow boundary:

```
<site-root> >> shadow >> <router-outlet[data-filled="/pages/index"]> >> shadow >> <site-layout> > <site-home> > <site-preview-promotions> >> shadow >> <gaming-collection> > [data-test-id="card"] > <img>
```

### Page Scanner

The scanner uses a recursive `TreeWalker` that enters every open shadow root on the page. It collects all stable attribute names, then for a chosen attribute finds every unique value, deduplicates by attribute value, and generates a FullStory selector for each.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the repository folder
5. Click the extension icon in the toolbar to open the side panel

## Usage

### Picking an Element

1. Open the side panel and go to the **Selection** tab
2. Click **Pick Element** — the cursor changes to a crosshair
3. Hover over any element on the page (a blue outline tracks your cursor)
4. Click to capture — the FullStory selector and shadow DOM path appear in the panel
5. Edit the selector directly in the panel if needed, then copy or save it
6. Press **Escape** or click **Stop Picking** to exit pick mode

### Scanning by Attribute

1. Go to the **Scan** tab
2. Click **Discover Attributes** — the extension scans the page and lists all `data-*`, `aria-label`, `aria-describedby`, and `role` attributes found
3. Click any attribute in the list to automatically scan for all its unique values
4. Each result shows the attribute value, element tag, count of matching elements, and whether it's inside shadow DOM
5. Click a result row to highlight matching elements on the page
6. Click the bookmark icon to save a selector to the Saved tab

### Saved Selectors

The **Saved** tab holds up to 20 selectors with editable names. Use the "Mark done" button to track which selectors have been added to FullStory. Saved selectors persist across browser sessions.

## Compatibility

- Chrome 116+ (Manifest V3, Side Panel API)
- Works on pages using open shadow DOM (Stencil, Lit, FAST, generic web components)
- The picker works on both open and closed shadow roots via `composedPath()`; the scanner requires open shadow roots
