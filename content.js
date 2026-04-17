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

  let _mmCount = 0;
  function onMouseMove(e) {
    if (!pickerActive) return;

    // #region agent log H4 – confirm extension mousemove is firing in this frame
    if (++_mmCount % 40 === 1) {
      fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run2',hypothesisId:'H4',location:'content.js:onMouseMove',message:'mousemove active in frame',data:{frameHref:location.href,count:_mmCount,targetTag:e.composedPath().find(n=>n instanceof Element)?.tagName},timestamp:Date.now()})}).catch(()=>{});
    }
    // #endregion

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

  /**
   * Returns true when `el` looks like a FullStory UI overlay rather than
   * meaningful page content — a plain <div> or <span> with no semantic
   * attributes (no id, no data-*, no role, no aria-label) that also has
   * computed pointer-events enabled.  Used to decide whether to pierce
   * the overlay and find the element underneath.
   */
  function looksLikeTransparentOverlay(el) {
    const tag = el.tagName.toLowerCase();
    if (tag !== "div" && tag !== "span") return false;
    if (el.id) return false;
    const hasData  = Array.from(el.attributes).some((a) => a.name.startsWith("data-"));
    if (hasData) return false;
    if (el.getAttribute("role") || el.getAttribute("aria-label")) return false;
    // Must actually intercept pointer events to count as an overlay
    const pe = window.getComputedStyle(el).pointerEvents;
    return pe !== "none";
  }

  function onClick(e) {
    // #region agent log H1/H2 – did onClick fire, and is picker active?
    fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run2',hypothesisId:'H1-H2',location:'content.js:onClick-entry',message:'onClick fired',data:{pickerActive,frameHref:location.href,targetTag:e.composedPath()[0]?.nodeName,pathLen:e.composedPath().length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (!pickerActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let path = e.composedPath();
    let target = path.find(
      (n) => n instanceof Element && n !== overlayEl && n !== tooltipEl
    );

    // #region agent log H2/H3 – what element was targeted?
    fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run1',hypothesisId:'H2-H3',location:'content.js:onClick-target',message:'target found',data:{targetTag:target?.tagName,targetId:target?.id,targetDataAttrs:target?Array.from(target.attributes).filter(a=>a.name.startsWith('data-')).map(a=>a.name+'='+a.value):[],isOverlay:target?looksLikeTransparentOverlay(target):null,pathLen:path.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (!target) return;

    // If the top element looks like a FullStory UI overlay (no semantic
    // attributes, plain div/span that eats pointer events), temporarily hide
    // it and re-query at the same coordinates to find the real element beneath.
    if (looksLikeTransparentOverlay(target)) {
      const savedVisibility = target.style.visibility;
      const savedPointerEvents = target.style.pointerEvents;
      target.style.visibility = "hidden";
      target.style.pointerEvents = "none";

      const pierced = document.elementFromPoint(e.clientX, e.clientY);

      target.style.visibility = savedVisibility;
      target.style.pointerEvents = savedPointerEvents;

      if (pierced && pierced !== overlayEl && pierced !== tooltipEl) {
        // Rebuild a synthetic composedPath starting from the pierced element
        // so buildSelectorSegments can traverse shadow boundaries correctly.
        target = pierced;
        path = [pierced];
        let node = pierced.parentNode;
        while (node) {
          path.push(node);
          node = node instanceof ShadowRoot ? node.host : node.parentNode;
        }
      }
    }

    const fragments = buildSelectorSegments(path);
    const result = buildOutputSelectors(fragments);

    // #region agent log H3 – log the result about to be sent (or null)
    fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run1',hypothesisId:'H3',location:'content.js:onClick-result',message:'selector result',data:{hasResult:!!result,selector:result?.fullstorySelector,segmentCount:result?.segments?.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (result) {
      chrome.runtime.sendMessage({
        type: "SELECTOR_RESULT",
        payload: result,
      });
    }

    // Keep picker active so user can click another element;
    // the side panel's "Stop Picking" button deactivates it
  }

  function onKeyDown(e) {
    // #region agent log H5 – log every keydown while picker active
    if (pickerActive) {
      fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run2',hypothesisId:'H5',location:'content.js:onKeyDown',message:'keydown while active',data:{key:e.key,code:e.code,isTrusted:e.isTrusted,frameHref:location.href},timestamp:Date.now()})}).catch(()=>{});
    }
    // #endregion
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
    // Listeners are pre-registered at script load (document_start) so the
    // extension is first in the capture-phase queue, before FullStory's own
    // handlers. We only need to flip the state flag and set up the overlay.
    if (document.body) {
      document.body.style.cursor = "crosshair";
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        document.body.style.cursor = "crosshair";
      }, { once: true });
    }
    ensureOverlayContainer();
  }

  function deactivatePicker() {
    if (!pickerActive) return;
    // #region agent log H5 – catch every deactivatePicker call with stack trace
    fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run2',hypothesisId:'H5',location:'content.js:deactivatePicker',message:'deactivatePicker called',data:{stack:new Error().stack?.split('\n').slice(1,5).join(' | '),frameHref:location.href},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    pickerActive = false;
    if (document.body) document.body.style.cursor = "";
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

  // ─── Page Harvester ──────────────────────────────────────────────────────
  //
  // Called by the Crawl driver (via HARVEST_PAGE message) to extract all stable
  // selectors and interactive candidates from the current page in one shot.

  const HARVEST_CTA_KEYWORDS = [
    "checkout", "buy now", "buy", "add to cart", "add to bag",
    "sign up", "signup", "sign-up", "subscribe", "submit",
    "continue", "proceed", "pay now", "pay", "book now", "book",
    "reserve", "register", "get started", "start free", "try free",
    "free trial", "download", "install", "claim", "redeem",
    "upgrade", "purchase", "place order", "confirm", "apply",
    "enroll", "join now", "join", "next", "complete order",
  ];

  function getElementSignals(el) {
    const rect        = el.getBoundingClientRect();
    const tag         = el.tagName.toLowerCase();
    const textContent = el.textContent.trim().slice(0, 80);
    const ariaLabel   = el.getAttribute("aria-label") || "";
    const role        = el.getAttribute("role") || "";
    const combined    = `${textContent} ${ariaLabel}`.toLowerCase();
    const inForm      = !!el.closest("form");
    const isCTA       = HARVEST_CTA_KEYWORDS.some((kw) => combined.includes(kw));
    const aboveFold   = rect.top >= 0 && rect.top < window.innerHeight;
    const boundingArea = Math.round(rect.width * rect.height);
    const inputType   = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : null;
    return { tag, textContent, ariaLabel, role, inForm, isCTA, aboveFold, boundingArea, inputType };
  }

  function harvestPage() {
    const url      = location.href;
    const hostname = location.hostname;

    // ── Attribute-based finds ─────────────────────────────────────────────
    const attrs      = discoverStableAttributes();
    const attrResults = [];

    for (const { attrName } of attrs) {
      const scanResults = scanPageForAttribute(attrName);
      for (const result of scanResults) {
        let signals = {};
        // Re-find the element for signal enrichment (same walk, so it's fast)
        for (const el of walkDOMDeep(document)) {
          if (el.getAttribute(attrName) === result.attrValue) {
            signals = getElementSignals(el);
            break;
          }
        }
        attrResults.push({
          ...result,
          sourceUrl:       url,
          sourceHostname:  hostname,
          source:          "attribute",
          ...signals,
        });
      }
    }

    // ── Interactive candidates ────────────────────────────────────────────
    const seenInteractive      = new Set();
    const interactiveCandidates = [];

    for (const el of walkDOMDeep(document)) {
      const tag  = el.tagName.toLowerCase();
      const role = el.getAttribute("role");

      const isInteractive =
        tag === "button" ||
        (tag === "a" && el.hasAttribute("href")) ||
        (tag === "input" && ["submit", "button"].includes((el.getAttribute("type") || "").toLowerCase())) ||
        tag === "form" ||
        role === "button";

      if (!isInteractive) continue;

      const fragments = buildFragmentsFromElement(el);
      const output    = buildOutputSelectors(fragments);
      if (!output) continue;

      const sel = output.fullstorySelector;
      if (seenInteractive.has(sel)) continue;
      seenInteractive.add(sel);

      interactiveCandidates.push({
        fullstorySelector: sel,
        debugPath:         output.debugPath,
        segments:          output.segments,
        sourceUrl:         url,
        sourceHostname:    hostname,
        source:            "interactive",
        count:             1,
        tagName:           tag,
        inShadow:          fragments.length > 1,
        ...getElementSignals(el),
      });
    }

    return {
      url,
      hostname,
      pageTitle:             document.title,
      attrResults,
      interactiveCandidates,
      harvestedAt:           Date.now(),
    };
  }

  // ─── Early Event Registration ────────────────────────────────────────────
  //
  // Listeners are registered immediately at script load (document_start), which
  // puts them first in the capture-phase queue — before FullStory's React app
  // has had any chance to register its own handlers. Each handler returns early
  // when the picker is not active, so there is no overhead during normal use.
  //
  // We deliberately do NOT removeEventListener when the picker is deactivated;
  // the pickerActive guard makes them no-ops, and keeping them registered
  // ensures ordering is preserved if the picker is toggled multiple times.

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);

  // ─── Message Bus ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ACTIVATE_PICKER") {
      // #region agent log H2 – which frames receive ACTIVATE_PICKER?
      fetch('http://127.0.0.1:7579/ingest/1421809b-91be-4ff2-897d-20c9e8a58039',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d914fa'},body:JSON.stringify({sessionId:'d914fa',runId:'run2',hypothesisId:'H2',location:'content.js:onMessage-ACTIVATE',message:'ACTIVATE_PICKER received',data:{frameHref:location.href,isTopFrame:window===window.top},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
    } else if (msg.type === "HARVEST_PAGE") {
      try {
        const payload = harvestPage();
        sendResponse({ ok: true, payload });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    }
    return true; // keep channel open for async response
  });
})();
