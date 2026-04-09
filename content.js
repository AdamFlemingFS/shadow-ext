(() => {
  "use strict";

  // ─── State ────────────────────────────────────────────────────────────────

  let pickerActive = false;
  let overlayEl = null;
  let tooltipEl = null;
  let lastTarget = null;

  // ─── Selector Engine ──────────────────────────────────────────────────────

  /**
   * Heuristics for detecting auto-generated / unstable identifiers.
   * Skips IDs/classes that look like hashed or framework-generated strings.
   */
  const UNSTABLE_PATTERNS = [
    /^[a-z]{1,3}_[a-zA-Z0-9]{4,}$/,   // Webpack CSS modules: xK3_f2
    /[0-9]{3,}/,                         // Heavy numeric content: btn-12345
    /^[A-Z][a-z]+[A-Z]/,                // CamelCase (often React internal)
    /^css-/,                              // Emotion / styled-components
    /^sc-/,                               // styled-components scope class
    /^__/,                                // double-underscore private
    /^ng-/,                               // Angular auto-generated
  ];

  function isUnstableIdentifier(value) {
    return UNSTABLE_PATTERNS.some((re) => re.test(value));
  }

  /**
   * Returns the best single-element CSS selector for `el` that is
   * compatible with FullStory's selector syntax.
   *
   * Priority: data-* attrs > id > stable class > tagName[attr] > tagName
   */
  function getBestSelector(el) {
    const tag = el.tagName.toLowerCase();

    // 1. data-* attributes — most stable, FullStory supports all operators on these
    const dataAttrs = Array.from(el.attributes).filter(
      (a) => a.name.startsWith("data-") && a.value
    );
    if (dataAttrs.length > 0) {
      // Prefer shorter, unique-looking data attrs first
      const preferred = dataAttrs.find(
        (a) =>
          a.name.includes("testid") ||
          a.name.includes("test-id") ||
          a.name.includes("cy") ||
          a.name.includes("qa") ||
          a.name.includes("id") ||
          a.name.includes("action") ||
          a.name.includes("name") ||
          a.name.includes("component")
      ) || dataAttrs[0];
      return `[${preferred.name}="${preferred.value}"]`;
    }

    // 2. id — only if it looks stable
    if (el.id && !isUnstableIdentifier(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }

    // 3. Custom element tag — contains a hyphen, so it's already a descriptive
    //    named component. Prefer it over potentially generic class names like
    //    "hydrated", "loaded", "active" that frameworks add as state markers.
    if (tag.includes("-")) {
      return tag;
    }

    // 4. Stable class names — pick the first class that looks handwritten
    const classes = Array.from(el.classList).filter(
      (c) => !isUnstableIdentifier(c)
    );
    if (classes.length > 0) {
      return `.${CSS.escape(classes[0])}`;
    }

    // 4. Meaningful attribute fallback (role, name, type, aria-label)
    for (const attr of ["role", "name", "type", "aria-label", "aria-labelledby"]) {
      const val = el.getAttribute(attr);
      if (val) return `${tag}[${attr}="${val}"]`;
    }

    // 5. Tag name only (broadest, last resort)
    return tag;
  }

  /**
   * Segments of a selector path, one per shadow-DOM fragment boundary.
   *
   * Each segment is:
   *   { hostSelector: string, innerSelector: string, inShadow: boolean }
   *
   * hostSelector  — the selector for the shadow host itself (e.g. "my-component")
   * innerSelector — the selector for the element within that shadow root
   */
  function buildSelectorSegments(composedPath) {
    // composedPath goes from innermost to outermost: [target, ..., window]
    // We only care about Element nodes
    const elements = composedPath.filter((n) => n instanceof Element);

    if (elements.length === 0) return null;

    const target = elements[0];

    // Walk up from target, collecting elements, splitting at shadow boundaries
    const fragments = []; // array of arrays of elements, one per shadow fragment
    let currentFragment = [];

    let node = target;
    while (node && node !== document.documentElement) {
      if (node instanceof ShadowRoot) {
        if (currentFragment.length > 0) {
          fragments.unshift(currentFragment);
        }
        currentFragment = [];
        node = node.host;
        continue;
      }
      if (node instanceof Element) {
        currentFragment.unshift(node);
      }
      node = node.parentNode;
    }
    // Push the top-level document fragment
    if (currentFragment.length > 0) {
      fragments.unshift(currentFragment);
    }

    return fragments;
  }

  /**
   * Given fragments (arrays of elements per shadow boundary), produce:
   *   - fullstorySelector: space-separated descendant selector FullStory can use
   *   - debugPath:         human-readable path with ">>" at shadow boundaries
   *   - segments:          structured array for UI display
   */
  function buildOutputSelectors(fragments) {
    if (!fragments || fragments.length === 0) return null;

    const segmentStrings = fragments.map((fragment) => {
      const targetEl  = fragment[fragment.length - 1];
      const targetSel = getBestSelector(targetEl);

      // If the target itself has a data-* selector, it's specific enough alone
      if (targetSel.startsWith("[data-")) {
        return targetSel;
      }

      // Walk backwards through the fragment (excluding the target) to find the
      // closest ancestor that has a data-* selector — these are the most stable
      // anchors and more useful than the shadow host when they exist
      for (let i = fragment.length - 2; i >= 0; i--) {
        const ancestorSel = getBestSelector(fragment[i]);
        if (ancestorSel.startsWith("[data-")) {
          return `${ancestorSel} ${targetSel}`;
        }
      }

      // Fall back: prefix the shadow host if it's a custom element (descriptive tag)
      const hostEl = fragment[0];
      if (
        fragment.length > 1 &&
        hostEl !== targetEl &&
        hostEl.tagName.includes("-")
      ) {
        return `${getBestSelector(hostEl)} ${targetSel}`;
      }

      return targetSel;
    });

    // FullStory selector: flatten all segments with spaces
    const fullstorySelector = segmentStrings.join(" ");

    // Debug path: each fragment joined by " > " within, and ">>" between fragments
    const debugFragments = fragments.map((fragment) =>
      fragment.map((el) => {
        const sel = getBestSelector(el);
        return sel === el.tagName.toLowerCase()
          ? `<${sel}>`
          : `<${el.tagName.toLowerCase()}${sel.startsWith("#") || sel.startsWith(".") || sel.startsWith("[") ? sel : ""}>`; // prettier display
      }).join(" > ")
    );
    const debugPath = debugFragments.join(" >> shadow >> ");

    // Structured segments for the side panel UI
    const segments = fragments.map((fragment, i) => ({
      elements: fragment.map((el) => ({
        tag: el.tagName.toLowerCase(),
        selector: getBestSelector(el),
        attributes: Array.from(el.attributes)
          .slice(0, 5)
          .map((a) => `${a.name}="${a.value}"`),
      })),
      isShadowFragment: i > 0,
    }));

    return { fullstorySelector, debugPath, segments };
  }

  // ─── Overlay / Highlighting ───────────────────────────────────────────────

  // ── Scan highlights (triggered from the side panel) ──────────────────────

  let scanHighlightOverlays = [];
  let scanHighlightTimer    = null;

  function clearScanHighlights() {
    if (scanHighlightTimer) { clearTimeout(scanHighlightTimer); scanHighlightTimer = null; }
    scanHighlightOverlays.forEach((el) => el.remove());
    scanHighlightOverlays = [];
  }

  function showScanHighlights(attrName, attrValue) {
    clearScanHighlights();

    const matched = [];
    for (const el of walkDOMDeep(document)) {
      if (el.getAttribute(attrName) === attrValue) matched.push(el);
    }
    if (matched.length === 0) return;

    matched[0].scrollIntoView({ behavior: "smooth", block: "center" });

    matched.forEach((el) => {
      const rect    = el.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.id    = "__fs-scan-highlight__";
      Object.assign(overlay.style, {
        position:     "fixed",
        top:          `${rect.top}px`,
        left:         `${rect.left}px`,
        width:        `${rect.width || 40}px`,
        height:       `${rect.height || 20}px`,
        background:   "rgba(251, 146, 60, 0.25)",
        border:       "2px solid rgba(234, 88, 12, 0.9)",
        borderRadius: "3px",
        pointerEvents: "none",
        zIndex:       "2147483646",
        boxSizing:    "border-box",
        opacity:      "1",
        transition:   "opacity 0.4s ease",
      });
      document.body.appendChild(overlay);
      scanHighlightOverlays.push(overlay);
    });

    // Fade out after 2.1 s, remove after 2.5 s
    scanHighlightTimer = setTimeout(() => {
      scanHighlightOverlays.forEach((el) => { el.style.opacity = "0"; });
      scanHighlightTimer = setTimeout(() => clearScanHighlights(), 400);
    }, 2100);
  }

  // ── Picker overlay ────────────────────────────────────────────────────────

  function ensureOverlayContainer() {
    if (overlayEl) return;

    overlayEl = document.createElement("div");
    overlayEl.id = "__fs-shadow-picker-overlay__";
    Object.assign(overlayEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      background: "rgba(99, 102, 241, 0.25)",
      border: "2px solid rgba(99, 102, 241, 0.9)",
      borderRadius: "3px",
      pointerEvents: "none",
      zIndex: "2147483646",
      boxSizing: "border-box",
      transition: "all 0.05s ease",
    });

    tooltipEl = document.createElement("div");
    tooltipEl.id = "__fs-shadow-picker-tooltip__";
    Object.assign(tooltipEl.style, {
      display: "none",
      position: "fixed",
      padding: "4px 8px",
      background: "rgba(30, 27, 75, 0.95)",
      color: "#e0e7ff",
      fontFamily: "monospace",
      fontSize: "12px",
      lineHeight: "1.5",
      borderRadius: "4px",
      pointerEvents: "none",
      zIndex: "2147483647",
      maxWidth: "400px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    });

    document.body.appendChild(overlayEl);
    document.body.appendChild(tooltipEl);
  }

  function positionOverlay(el) {
    if (!overlayEl || !el) return;
    const rect = el.getBoundingClientRect();
    Object.assign(overlayEl.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function positionTooltip(x, y, text) {
    if (!tooltipEl) return;
    tooltipEl.textContent = text;
    // Keep tooltip from going off-screen
    const margin = 12;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    let tx = x + margin;
    let ty = y + margin;
    // Rough width estimate; adjust after render
    if (tx + 320 > vpW) tx = x - margin - Math.min(320, tx);
    if (ty + 40 > vpH) ty = y - margin - 40;
    Object.assign(tooltipEl.style, {
      left: `${tx}px`,
      top: `${ty}px`,
      display: "block",
    });
  }

  function hideOverlay() {
    if (overlayEl) {
      Object.assign(overlayEl.style, { width: "0", height: "0" });
    }
    if (tooltipEl) {
      tooltipEl.style.display = "none";
    }
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!pickerActive) return;

    ensureOverlayContainer();

    // composedPath gives us the actual element inside shadow DOM
    const path = e.composedPath();
    const target = path.find((n) => n instanceof Element);

    if (!target || target === overlayEl || target === tooltipEl) return;

    lastTarget = target;
    positionOverlay(target);

    const fragments = buildSelectorSegments(path);
    const result = buildOutputSelectors(fragments);
    const shortLabel = result
      ? `${target.tagName.toLowerCase()}  →  ${result.fullstorySelector}`
      : target.tagName.toLowerCase();

    positionTooltip(e.clientX, e.clientY, shortLabel);
  }

  function onClick(e) {
    if (!pickerActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const path = e.composedPath();
    const target = path.find(
      (n) => n instanceof Element && n !== overlayEl && n !== tooltipEl
    );

    if (!target) return;

    const fragments = buildSelectorSegments(path);
    const result = buildOutputSelectors(fragments);

    if (result) {
      // Send result to the background service worker
      chrome.runtime.sendMessage({
        type: "SELECTOR_RESULT",
        payload: result,
      });
    }

    // Keep picker active so user can click another element;
    // the side panel's "Stop Picking" button deactivates it
  }

  function onKeyDown(e) {
    if (!pickerActive) return;
    // Escape cancels the picker
    if (e.key === "Escape") {
      deactivatePicker();
      chrome.runtime.sendMessage({ type: "PICKER_CANCELLED" });
    }
  }

  // ─── Picker Lifecycle ─────────────────────────────────────────────────────

  function activatePicker() {
    if (pickerActive) return;
    pickerActive = true;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.body.style.cursor = "crosshair";
    ensureOverlayContainer();
  }

  function deactivatePicker() {
    if (!pickerActive) return;
    pickerActive = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.body.style.cursor = "";
    removeOverlay();
    lastTarget = null;
  }

  // ─── Page Scanner ─────────────────────────────────────────────────────────

  /**
   * Recursively yields every Element in `root` and inside any open shadow roots
   * beneath it. The root node itself is NOT yielded — only its descendants.
   */
  function* walkDOMDeep(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      yield node;
      if (node.shadowRoot) yield* walkDOMDeep(node.shadowRoot);
    }
  }

  /**
   * Returns true when none of `el`'s descendants (including through shadow roots)
   * carry `attrName`. Uses walkDOMDeep starting from `el` so descendants inside
   * el's own shadow root are also checked.
   */
  function isLeafForAttr(el, attrName) {
    for (const desc of walkDOMDeep(el)) {
      if (desc.hasAttribute(attrName)) return false;
    }
    return true;
  }

  /**
   * Walks from `el` up through parentNode / ShadowRoot boundaries to reconstruct
   * the same `fragments` array format that buildOutputSelectors consumes —
   * without needing a composedPath from a click event.
   */
  function buildFragmentsFromElement(el) {
    const fragments = [];
    let currentFragment = [];
    let node = el;
    while (node && node !== document.documentElement) {
      if (node instanceof ShadowRoot) {
        if (currentFragment.length) fragments.unshift(currentFragment);
        currentFragment = [];
        node = node.host;
        continue;
      }
      if (node instanceof Element) currentFragment.unshift(node);
      node = node.parentNode;
    }
    if (currentFragment.length) fragments.unshift(currentFragment);
    return fragments;
  }

  /**
   * Scans the entire page (light DOM + all open shadow roots) for elements
   * carrying `attrName`. Returns only leaf nodes (no descendant also has the
   * attribute), de-duplicated by attribute value with a count for repeats.
   *
   * Each result is compatible with the existing buildOutputSelectors shape
   * (fullstorySelector, debugPath, segments) plus scan-specific fields.
   */
  function scanPageForAttribute(attrName) {
    const seen = new Map(); // attrValue → result entry

    for (const el of walkDOMDeep(document)) {
      if (!el.hasAttribute(attrName)) continue;
      if (!isLeafForAttr(el, attrName)) continue;

      const value = el.getAttribute(attrName);
      const fragments = buildFragmentsFromElement(el);
      const output = buildOutputSelectors(fragments);
      const inShadow = fragments.length > 1;

      if (seen.has(value)) {
        seen.get(value).count++;
      } else {
        seen.set(value, {
          attrValue:         value,
          attrName:          attrName,
          fullstorySelector: output ? output.fullstorySelector : `[${attrName}="${value}"]`,
          debugPath:         output ? output.debugPath : "",
          segments:          output ? output.segments : [],
          count:             1,
          tagName:           el.tagName.toLowerCase(),
          inShadow:          inShadow,
        });
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Scans the entire page (light DOM + all open shadow roots) and returns every
   * attribute name that is considered a stable FullStory selector candidate:
   *   - any data-* attribute
   *   - aria-label, aria-labelledby, aria-describedby
   *   - role
   *
   * Returns an array of { attrName, valueCount } sorted descending by valueCount.
   */
  function discoverStableAttributes() {
    const QUALIFIED_NAMED = new Set([
      "aria-label",
      "aria-labelledby",
      "aria-describedby",
      "role",
    ]);

    // attrName → Set of distinct values
    const attrMap = new Map();

    for (const el of walkDOMDeep(document)) {
      for (const attr of el.attributes) {
        const name = attr.name;
        if (!name.startsWith("data-") && !QUALIFIED_NAMED.has(name)) continue;
        const val = attr.value.trim();
        if (!val) continue;
        if (!attrMap.has(name)) attrMap.set(name, new Set());
        attrMap.get(name).add(val);
      }
    }

    return Array.from(attrMap.entries())
      .map(([attrName, values]) => ({ attrName, valueCount: values.size }))
      .sort((a, b) => b.valueCount - a.valueCount);
  }

  // ─── Message Bus ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ACTIVATE_PICKER") {
      activatePicker();
      sendResponse({ ok: true });
    } else if (msg.type === "DEACTIVATE_PICKER") {
      deactivatePicker();
      sendResponse({ ok: true });
    } else if (msg.type === "PING") {
      sendResponse({ ok: true, active: pickerActive });
    } else if (msg.type === "DISCOVER_ATTRIBUTES") {
      const attrs = discoverStableAttributes();
      sendResponse({ ok: true, attrs });
    } else if (msg.type === "SCAN_PAGE") {
      const attrName = (msg.attrName || "data-test-id").trim();
      const results = attrName ? scanPageForAttribute(attrName) : [];
      sendResponse({ ok: true, results });
    } else if (msg.type === "HIGHLIGHT_ELEMENT") {
      showScanHighlights(msg.attrName, msg.attrValue);
      sendResponse({ ok: true });
    }
    return true; // keep channel open for async response
  });
})();
