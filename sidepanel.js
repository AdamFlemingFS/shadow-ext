"use strict";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_SAVED   = 200;
const STORAGE_KEY = "savedElements";

// ─── DOM refs ────────────────────────────────────────────────────────────────

const btnPick      = document.getElementById("btn-pick");
const btnPickLabel = document.getElementById("btn-pick-label");
const btnClear     = document.getElementById("btn-clear");
const statusBar    = document.getElementById("status-bar");
const statusText   = document.getElementById("status-text");
const historyEl    = document.getElementById("history");
const emptyEl      = document.getElementById("empty-state");
const tplResult    = document.getElementById("tpl-result");

// Tab refs
const tabBtnSel    = document.getElementById("tab-btn-selection");
const tabBtnScan   = document.getElementById("tab-btn-scan");
const tabBtnSaved  = document.getElementById("tab-btn-saved");
const tabPanelSel  = document.getElementById("tab-selection");
const tabPanelScan = document.getElementById("tab-scan");
const tabPanelSvd  = document.getElementById("tab-saved");
const savedBadge   = document.getElementById("saved-badge");
const savedCountEl = document.getElementById("saved-count");
const savedListEl  = document.getElementById("saved-list");
const savedEmptyEl = document.getElementById("saved-empty");
const btnClearDone = document.getElementById("btn-clear-done");
const tplSavedItem = document.getElementById("tpl-saved-item");

// Crawl refs
const tabBtnCrawl         = document.getElementById("tab-btn-crawl");
const tabPanelCrawl       = document.getElementById("tab-crawl");
const crawlBadge          = document.getElementById("crawl-badge");
const crawlUrlInput       = document.getElementById("crawl-url-input");
const crawlHydrationSel   = document.getElementById("crawl-hydration-select");
const btnStartCrawl       = document.getElementById("btn-start-crawl");
const btnStopCrawl        = document.getElementById("btn-stop-crawl");
const crawlInputSection   = document.getElementById("crawl-input-section");
const crawlProgressSection = document.getElementById("crawl-progress-section");
const crawlProgressText   = document.getElementById("crawl-progress-text");
const crawlProgressCount  = document.getElementById("crawl-progress-count");
const crawlProgressBar    = document.getElementById("crawl-progress-bar");
const crawlLiveBadge      = document.getElementById("crawl-live-badge");
const crawlCurrentUrl     = document.getElementById("crawl-current-url");
const crawlLiveCount      = document.getElementById("crawl-live-count");
const crawlCandTotal      = document.getElementById("crawl-cand-total");
const crawlLog            = document.getElementById("crawl-log");
const crawlResultsSection = document.getElementById("crawl-results-section");
const crawlSearch         = document.getElementById("crawl-search");
const crawlSelectAll      = document.getElementById("crawl-select-all");
const crawlAttrList       = document.getElementById("crawl-attr-list");
const crawlAttrCount      = document.getElementById("crawl-attr-count");
const crawlInteractiveList = document.getElementById("crawl-interactive-list");
const crawlInteractiveCount = document.getElementById("crawl-interactive-count");
const crawlSelectedCount  = document.getElementById("crawl-selected-count");
const btnSaveCrawlSelected  = document.getElementById("btn-save-crawl-selected");
const btnSaveCrawlLabel     = document.getElementById("btn-save-crawl-label");
const btnClearCrawl       = document.getElementById("btn-clear-crawl");
const crawlEmptyEl        = document.getElementById("crawl-empty");

// Discover refs
const btnDiscover           = document.getElementById("btn-discover");
const btnDiscoverLabel      = document.getElementById("btn-discover-label");
const discoverResultsSection = document.getElementById("discover-results-section");
const discoverResultsCount  = document.getElementById("discover-results-count");
const discoverList          = document.getElementById("discover-list");
const btnClearDiscover      = document.getElementById("btn-clear-discover");
const discoverEmptyEl       = document.getElementById("discover-empty");
const scanDetailDivider     = document.getElementById("scan-detail-divider");
const scanControlsWrap      = document.getElementById("scan-controls-wrap");

// Scan refs
const scanAttrInput      = document.getElementById("scan-attr-input");
const btnScan            = document.getElementById("btn-scan");
const btnScanLabel       = document.getElementById("btn-scan-label");
const scanResultsSection = document.getElementById("scan-results-section");
const scanResultsCount   = document.getElementById("scan-results-count");
const scanList           = document.getElementById("scan-list");
const btnClearScan       = document.getElementById("btn-clear-scan");
const scanEmptyEl        = document.getElementById("scan-empty");

// Live-scan refs
const liveScanCheckbox   = document.getElementById("live-scan-checkbox");
const liveScanBanner     = document.getElementById("live-scan-banner");
const liveScanAttrEl     = document.getElementById("live-scan-attr");
const liveScanPagesEl    = document.getElementById("live-scan-pages");
const liveScanUrlEl      = document.getElementById("live-scan-url");
const btnStopLiveScan    = document.getElementById("btn-stop-live-scan");

// ─── URL helpers ──────────────────────────────────────────────────────────────

function shortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return u.hostname + path;
  } catch {
    return url;
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

let pickerActive = false;
let port         = null;
let resultCount  = 0;
let savedItems   = [];

// Registered callbacks to refresh the save button state on result cards.
// Entries are removed when a card is deleted so there is no unbounded growth.
const saveButtonRefreshers = new Set();

// ─── Tab switching ────────────────────────────────────────────────────────────

let activeTab = "selection";

function switchTab(tab) {
  activeTab = tab;

  tabBtnSel.classList.toggle("tab-active",    tab === "selection");
  tabBtnScan.classList.toggle("tab-active",   tab === "scan");
  tabBtnSaved.classList.toggle("tab-active",  tab === "saved");
  tabBtnCrawl.classList.toggle("tab-active",  tab === "crawl");

  tabPanelSel.classList.toggle("tab-active",  tab === "selection");
  tabPanelScan.classList.toggle("tab-active", tab === "scan");
  tabPanelSvd.classList.toggle("tab-active",  tab === "saved");
  tabPanelCrawl.classList.toggle("tab-active", tab === "crawl");

  // The header "Clear all" button only applies to the Selection tab
  btnClear.style.visibility = tab === "selection" ? "" : "hidden";
}

tabBtnSel.addEventListener("click",   () => switchTab("selection"));
tabBtnScan.addEventListener("click",  () => switchTab("scan"));
tabBtnSaved.addEventListener("click", () => switchTab("saved"));
tabBtnCrawl.addEventListener("click", () => switchTab("crawl"));

// ─── Port connection ─────────────────────────────────────────────────────────

function connectPort() {
  port = chrome.runtime.connect({ name: "sidepanel" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "TAB_STATE":
        applyTabState(msg.payload);
        break;
      case "SELECTOR_RESULT":
        prependResult(msg.payload);
        setStatus("success", "Element captured — click another or press Escape to stop");
        break;
      case "PICKER_CANCELLED":
        setPickerActive(false);
        setStatus("cancelled", "Picker cancelled — press Pick Element to start again");
        break;
      case "CRAWL_PROGRESS":
        onCrawlProgress(msg.payload);
        break;
      case "CRAWL_PAGE_RESULT":
        onCrawlPageResult(msg.payload);
        break;
      case "CRAWL_PAGE_ERROR":
        onCrawlPageError(msg.payload);
        break;
      case "CRAWL_COMPLETE":
        onCrawlComplete(msg.payload);
        break;
      case "CRAWL_STOPPED":
        onCrawlStopped(msg.payload);
        break;
      case "CRAWL_STATE":
        onCrawlStateRestore(msg.payload);
        break;
      case "LIVE_HARVEST_STARTED":
        onLiveHarvestStarted(msg.payload);
        break;
      case "LIVE_HARVEST_UPDATE":
        onLiveHarvestUpdate(msg.payload);
        break;
      case "LIVE_HARVEST_STOPPED":
        onLiveHarvestStopped(msg.payload);
        break;
      case "LIVE_HARVEST_STATE":
        onLiveHarvestStateRestore(msg.payload);
        break;
      case "LIVE_SCAN_STARTED":
        onLiveScanStarted(msg.payload);
        break;
      case "LIVE_SCAN_UPDATE":
        onLiveScanUpdate(msg.payload);
        break;
      case "LIVE_SCAN_STOPPED":
        onLiveScanStopped(msg.payload);
        break;
      case "LIVE_SCAN_STATE":
        onLiveScanStateRestore(msg.payload);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 500);
  });
}

function applyTabState(state) {
  clearHistoryUI();
  resultCount = 0;

  setPickerActive(!!state.active);

  if (state.active) {
    setStatus("active", "Picker active — hover and click an element on the page");
  } else {
    setStatus("idle", "Click \"Pick Element\", then click any element on the page");
  }

  if (state.results && state.results.length > 0) {
    state.results.slice().reverse().forEach((r) => prependResult(r, true));
    setStatus(
      state.active ? "active" : "success",
      state.active
        ? "Picker active — hover and click an element on the page"
        : `${state.results.length} element${state.results.length > 1 ? "s" : ""} captured`
    );
  }
}

// ─── Picker toggle ────────────────────────────────────────────────────────────

btnPick.addEventListener("click", () => {
  if (pickerActive) {
    chrome.runtime.sendMessage({ type: "DEACTIVATE_PICKER" });
    setPickerActive(false);
    setStatus("idle", "Picker stopped");
  } else {
    chrome.runtime.sendMessage({ type: "ACTIVATE_PICKER" });
    setPickerActive(true);
    setStatus("active", "Picker active — hover and click an element on the page");
  }
});

function setPickerActive(active) {
  pickerActive = active;
  btnPick.classList.toggle("active", active);
  btnPickLabel.textContent = active ? "Stop Picking" : "Pick Element";
}

// ─── Clear all (Tab 1) ────────────────────────────────────────────────────────

btnClear.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
  clearHistoryUI();
  resultCount = 0;
  setStatus("idle", "Results cleared — click \"Pick Element\" to start again");
});

function clearHistoryUI() {
  historyEl.innerHTML = "";
  saveButtonRefreshers.clear();
  emptyEl.style.display = "";
  btnClear.disabled = true;
}

// ─── Attribute Discovery ──────────────────────────────────────────────────────

btnDiscover.addEventListener("click", () => {
  btnDiscover.disabled = true;
  btnDiscoverLabel.textContent = "Discovering…";

  chrome.runtime.sendMessage({ type: "DISCOVER_ATTRIBUTES" }, (resp) => {
    btnDiscover.disabled = false;
    btnDiscoverLabel.textContent = "Discover Attributes";

    if (chrome.runtime.lastError || !resp || !resp.ok) {
      renderDiscoveryResults([]);
      return;
    }
    renderDiscoveryResults(resp.attrs || []);
  });
});

btnClearDiscover.addEventListener("click", () => {
  discoverList.innerHTML = "";
  discoverResultsSection.hidden = true;
  discoverEmptyEl.style.display = "";
  // Also hide the scan detail section
  scanDetailDivider.hidden = true;
  scanControlsWrap.hidden = true;
  scanResultsSection.hidden = true;
  scanEmptyEl.hidden = true;
  scanSaveRefreshers.clear();
});

function renderDiscoveryResults(attrs) {
  discoverList.innerHTML = "";

  const n = attrs.length;
  discoverResultsCount.textContent = n === 0
    ? "No stable attributes found"
    : `${n} attribute${n === 1 ? "" : "s"} found`;

  discoverResultsSection.hidden = false;
  discoverEmptyEl.style.display = "none";

  attrs.forEach((item) => {
    const row = document.createElement("div");
    row.className = "discover-row";
    row.title = `Click to scan values for ${item.attrName}`;

    const nameEl = document.createElement("span");
    nameEl.className = "discover-attr-name";
    nameEl.textContent = item.attrName;

    const countEl = document.createElement("span");
    countEl.className = "discover-count-badge";
    countEl.textContent = `${item.valueCount} value${item.valueCount === 1 ? "" : "s"}`;

    const scanBtn = document.createElement("button");
    scanBtn.className = "btn-discover-scan";
    scanBtn.title = `Scan values for ${item.attrName}`;
    scanBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`;

    const triggerDetailScan = () => {
      // Mark this row as active
      discoverList.querySelectorAll(".discover-row").forEach((r) => r.classList.remove("discover-row-active"));
      row.classList.add("discover-row-active");

      // Reveal and populate the detail scan section
      scanDetailDivider.hidden = false;
      scanControlsWrap.hidden = false;
      scanAttrInput.value = item.attrName;

      // Auto-trigger the scan
      btnScan.click();

      // Scroll detail into view
      scanDetailDivider.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    row.addEventListener("click", triggerDetailScan);
    scanBtn.addEventListener("click", (e) => { e.stopPropagation(); triggerDetailScan(); });

    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(scanBtn);
    discoverList.appendChild(row);
  });
}

// ─── Page Scanner ─────────────────────────────────────────────────────────────

let scanSaveRefreshers = new Set();

// Map of attrValue → DOM row, used by live scan to update rows in place.
let scanRowIndex = new Map();
// Tracks whether the current scan list was produced by live scan (so a
// subsequent one-shot scan knows to reset the view).
let scanListMode = "idle"; // "idle" | "oneshot" | "live"

btnScan.addEventListener("click", () => {
  const attrName = scanAttrInput.value.trim();
  if (!attrName) return;

  // Live mode: start a streaming session instead of a one-shot scan.
  if (liveScanCheckbox.checked) {
    btnScan.disabled = true;
    btnScanLabel.textContent = "Starting…";
    chrome.runtime.sendMessage({ type: "START_LIVE_SCAN", attrName }, (resp) => {
      btnScan.disabled = false;
      btnScanLabel.textContent = "Scan Values";
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        renderScanResults([], attrName);
      }
      // The BG worker will push LIVE_SCAN_STARTED + subsequent LIVE_SCAN_UPDATE
      // messages with the results; the handlers render them into scanList.
    });
    return;
  }

  btnScan.disabled = true;
  btnScanLabel.textContent = "Scanning…";

  chrome.runtime.sendMessage({ type: "SCAN_PAGE", attrName }, (resp) => {
    btnScan.disabled = false;
    btnScanLabel.textContent = "Scan Values";

    if (chrome.runtime.lastError || !resp || !resp.ok) {
      renderScanResults([], attrName);
      return;
    }
    renderScanResults(resp.results || [], attrName);
  });
});

btnClearScan.addEventListener("click", () => {
  scanSaveRefreshers.clear();
  scanRowIndex.clear();
  scanList.innerHTML = "";
  scanResultsSection.hidden = true;
  scanEmptyEl.hidden = true;
  scanListMode = "idle";
  // If a live session is tracked in the background, clear it too so the
  // accumulated entries don't come back on reconnect.
  chrome.runtime.sendMessage({ type: "CLEAR_LIVE_SCAN" }, () => {});
});

function renderScanResults(results, attrName) {
  scanSaveRefreshers.clear();
  scanRowIndex.clear();
  scanList.innerHTML = "";
  scanListMode = "oneshot";

  const n = results.length;
  scanResultsCount.textContent = n === 0
    ? `No [${attrName}] found`
    : `${n} unique value${n === 1 ? "" : "s"} found`;

  scanResultsSection.hidden = false;
  scanEmptyEl.hidden = true;

  results.forEach((item) => {
    const row = createScanRow(item);
    scanRowIndex.set(item.attrValue, row);
    scanList.appendChild(row);
  });
}

function createScanRow(item) {
  const row = document.createElement("div");
  row.className = "scan-row";
  row.dataset.attrValue = item.attrValue;

  // Value + shadow badge
  const valueWrap = document.createElement("span");
  valueWrap.className = "scan-value";
  valueWrap.textContent = item.attrValue;
  valueWrap.title = item.fullstorySelector;

  if (item.inShadow) {
    const shadowBadge = document.createElement("span");
    shadowBadge.className = "scan-shadow-badge";
    shadowBadge.textContent = "shadow";
    valueWrap.appendChild(shadowBadge);
  }

  // Tag + count
  const meta = document.createElement("span");
  meta.className = "scan-meta";
  meta.textContent = `<${item.tagName}>`;
  if (item.count > 1) {
    const countBadge = document.createElement("span");
    countBadge.className = "scan-count-badge";
    countBadge.textContent = `×${item.count}`;
    meta.appendChild(countBadge);
  }

  const seenCount = (item.seenOn || []).length;
  if (seenCount > 0) {
    const seenBadge = document.createElement("span");
    seenBadge.className = "scan-seen-badge";
    seenBadge.textContent = `${seenCount} page${seenCount === 1 ? "" : "s"}`;
    seenBadge.title = (item.seenOn || []).join("\n");
    meta.appendChild(seenBadge);
  } else if (item.sourceUrl) {
    const urlBadge = document.createElement("span");
    urlBadge.className = "scan-seen-badge";
    urlBadge.textContent = shortUrl(item.sourceUrl);
    urlBadge.title = item.sourceUrl;
    meta.appendChild(urlBadge);
  }

  // Save button
  const btnSaveRow = document.createElement("button");
  btnSaveRow.className = "btn-scan-save";
  btnSaveRow.title = "Save to Saved tab";
  btnSaveRow.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;

  const refreshScanSaveBtn = () => {
    const full = savedItems.length >= MAX_SAVED;
    btnSaveRow.disabled = full;
    btnSaveRow.title = full
      ? "Saved list is full — clear done items to make space"
      : "Save to Saved tab";
  };
  refreshScanSaveBtn();
  scanSaveRefreshers.add(refreshScanSaveBtn);

  btnSaveRow.addEventListener("click", (e) => {
    e.stopPropagation();
    if (savedItems.length >= MAX_SAVED) return;
    addToSaved(item.fullstorySelector, "", item.sourceUrl || (item.seenOn || [])[0] || "");
    btnSaveRow.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    btnSaveRow.classList.add("saved");
    btnSaveRow.title = "Saved!";
    btnSaveRow.disabled = true;
    scanSaveRefreshers.delete(refreshScanSaveBtn);
  });

  row.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type:      "HIGHLIGHT_ELEMENT",
      attrName:  item.attrName,
      attrValue: item.attrValue,
    });
    row.classList.add("scan-row-flash");
    setTimeout(() => row.classList.remove("scan-row-flash"), 600);
  });

  row.appendChild(valueWrap);
  row.appendChild(meta);
  row.appendChild(btnSaveRow);
  return row;
}

// ─── Live Scan ───────────────────────────────────────────────────────────────

btnStopLiveScan.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_LIVE_SCAN" });
  liveScanCheckbox.checked = false;
});

// Uncheck the toggle should stop any in-flight live session; keep accumulated
// results visible so the user can still save them.
liveScanCheckbox.addEventListener("change", () => {
  if (!liveScanCheckbox.checked && !liveScanBanner.hidden) {
    chrome.runtime.sendMessage({ type: "STOP_LIVE_SCAN" });
  }
});

function _setLiveScanBanner({ attrName, pagesScanned, currentUrl, visible }) {
  if (!visible) {
    liveScanBanner.hidden = true;
    return;
  }
  liveScanBanner.hidden = false;
  liveScanAttrEl.textContent = attrName ? `[${attrName}]` : "";
  liveScanPagesEl.textContent = `${pagesScanned || 0} page${pagesScanned === 1 ? "" : "s"}`;
  if (currentUrl) {
    liveScanUrlEl.textContent = currentUrl;
    liveScanUrlEl.title = currentUrl;
  } else {
    liveScanUrlEl.textContent = "waiting for navigation…";
  }
}

function _upsertLiveScanRow(item, isNew) {
  const key = item.attrValue;
  const existing = scanRowIndex.get(key);

  if (existing) {
    // Update meta badges in place (tag + count + seen-on)
    const meta = existing.querySelector(".scan-meta");
    meta.textContent = `<${item.tagName}>`;
    if (item.count > 1) {
      const countBadge = document.createElement("span");
      countBadge.className = "scan-count-badge";
      countBadge.textContent = `×${item.count}`;
      meta.appendChild(countBadge);
    }
    const seenCount = (item.seenOn || []).length;
    if (seenCount > 0) {
      const seenBadge = document.createElement("span");
      seenBadge.className = "scan-seen-badge";
      seenBadge.textContent = `${seenCount} page${seenCount === 1 ? "" : "s"}`;
      seenBadge.title = (item.seenOn || []).join("\n");
      meta.appendChild(seenBadge);
    }
    return;
  }

  const row = createScanRow(item);
  scanRowIndex.set(key, row);
  // Prepend new discoveries so they're easy to spot
  scanList.insertBefore(row, scanList.firstChild);
  if (isNew) {
    row.classList.add("scan-row-new");
    setTimeout(() => row.classList.remove("scan-row-new"), 1200);
  }
}

function _renderLiveScanFull(payload) {
  scanSaveRefreshers.clear();
  scanRowIndex.clear();
  scanList.innerHTML = "";
  scanListMode = "live";

  const entries = payload.entries || [];
  const n = entries.length;
  const attrName = payload.attrName || "";
  scanResultsCount.textContent = n === 0
    ? `No [${attrName}] found yet — navigate the page`
    : `${n} unique value${n === 1 ? "" : "s"} across ${payload.pagesScanned || 0} page${payload.pagesScanned === 1 ? "" : "s"}`;

  scanResultsSection.hidden = false;
  scanEmptyEl.hidden = true;

  // Sort: values seen on more pages first
  entries
    .slice()
    .sort((a, b) => (b.seenOn || []).length - (a.seenOn || []).length)
    .forEach((item) => {
      const row = createScanRow(item);
      scanRowIndex.set(item.attrValue, row);
      scanList.appendChild(row);
    });
}

function onLiveScanStarted(payload) {
  scanListMode = "live";
  liveScanCheckbox.checked = true;
  _setLiveScanBanner({
    attrName:     payload.attrName,
    pagesScanned: payload.pagesScanned || 0,
    currentUrl:   payload.currentUrl,
    visible:      true,
  });
  // Reset scan list for a fresh live session
  _renderLiveScanFull(payload);
}

function onLiveScanUpdate(payload) {
  scanListMode = "live";
  liveScanCheckbox.checked = true;
  _setLiveScanBanner({
    attrName:     liveScanAttrEl.textContent.replace(/^\[|\]$/g, "") || scanAttrInput.value.trim(),
    pagesScanned: payload.pagesScanned,
    currentUrl:   payload.pageUrl,
    visible:      true,
  });

  const newKeys = new Set(payload.newKeys || []);
  const attrName = scanAttrInput.value.trim();
  const n = (payload.entries || []).length;

  scanResultsSection.hidden = false;
  scanEmptyEl.hidden = true;
  scanResultsCount.textContent = n === 0
    ? `No [${attrName}] found yet — navigate the page`
    : `${n} unique value${n === 1 ? "" : "s"} across ${payload.pagesScanned} page${payload.pagesScanned === 1 ? "" : "s"}`;

  for (const entry of payload.entries || []) {
    _upsertLiveScanRow(entry, newKeys.has(entry.attrValue));
  }
}

function onLiveScanStopped(payload) {
  liveScanCheckbox.checked = false;
  _setLiveScanBanner({ visible: false });
  const n = (payload && payload.entries || []).length;
  if (n > 0) {
    const attrName = payload.attrName || scanAttrInput.value.trim();
    scanResultsCount.textContent = `${n} unique value${n === 1 ? "" : "s"} across ${payload.pagesScanned || 0} page${payload.pagesScanned === 1 ? "" : "s"} (stopped)`;
    scanAttrInput.value = attrName;
  }
}

function onLiveScanStateRestore(payload) {
  if (!payload) return;
  const hasData = (payload.entries || []).length > 0;
  if (!hasData && !payload.running) {
    _setLiveScanBanner({ visible: false });
    return;
  }
  if (payload.attrName) scanAttrInput.value = payload.attrName;
  liveScanCheckbox.checked = !!payload.running;
  _setLiveScanBanner({
    attrName:     payload.attrName,
    pagesScanned: payload.pagesScanned || 0,
    currentUrl:   payload.currentUrl,
    visible:      !!payload.running,
  });
  if (hasData) {
    // Reveal scan detail section even if discover hasn't been run yet this session
    scanDetailDivider.hidden = false;
    scanControlsWrap.hidden  = false;
    _renderLiveScanFull(payload);
  }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function setStatus(type, text) {
  statusBar.className = `status-bar status-${type}`;
  statusText.textContent = text;
}

// ─── Render a result card ─────────────────────────────────────────────────────

function prependResult(result, suppressAnimation = false) {
  if (!result) return;

  resultCount++;
  const index = resultCount;

  const card = tplResult.content.cloneNode(true).querySelector(".result-card");

  if (suppressAnimation) card.style.animation = "none";

  // Header metadata
  card.querySelector(".result-index").textContent = `#${index}`;

  const topSel = result.fullstorySelector || "";
  const topTag = topSel.split(/[\s\[#.]/)[0] || "element";
  card.querySelector(".result-tag-badge").textContent = `<${topTag}>`;

  const now = new Date();
  card.querySelector(".result-timestamp").textContent =
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Source URL
  if (result.sourceUrl) {
    const urlBar = card.querySelector(".result-url-bar");
    const urlEl  = card.querySelector(".result-url");
    urlEl.textContent = shortUrl(result.sourceUrl);
    urlEl.title = result.sourceUrl;
    urlBar.removeAttribute("hidden");
  }

  // FullStory selector
  const fsValueEl = card.querySelector(".fs-value");
  fsValueEl.textContent = result.fullstorySelector || "";

  // Debug path
  card.querySelector(".debug-value").textContent = result.debugPath || "";

  // Fragment breakdown
  const segContainer = card.querySelector(".segments-container");
  renderSegments(segContainer, result.segments || []);

  // Copy buttons
  card.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const field = btn.dataset.field;
      const text  = field === "fs" ? fsValueEl.textContent : result.debugPath;
      copyToClipboard(btn, text);
    });
  });

  // Save button — saves the FS selector to the Saved tab
  const btnSaveItem = card.querySelector(".btn-save-item");

  const refreshSaveBtn = () => {
    const full = savedItems.length >= MAX_SAVED;
    btnSaveItem.disabled = full;
    btnSaveItem.title = full
      ? "Saved list is full — clear done items to make space"
      : "Save to list";
  };
  refreshSaveBtn();
  saveButtonRefreshers.add(refreshSaveBtn);

  btnSaveItem.addEventListener("click", () => {
    if (savedItems.length >= MAX_SAVED) return;
    addToSaved(fsValueEl.textContent || "", "", result.sourceUrl || "");
    // Visual feedback: fill the bookmark icon
    btnSaveItem.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    btnSaveItem.classList.add("saved");
    btnSaveItem.title = "Saved!";
    btnSaveItem.disabled = true;
    // No longer needs to participate in refresh cycles
    saveButtonRefreshers.delete(refreshSaveBtn);
  });

  // Remove button
  card.querySelector(".btn-remove").addEventListener("click", () => {
    saveButtonRefreshers.delete(refreshSaveBtn);
    card.style.transition = "opacity 0.15s, transform 0.15s";
    card.style.opacity = "0";
    card.style.transform = "translateY(-4px)";
    setTimeout(() => {
      card.remove();
      if (historyEl.children.length === 0) {
        emptyEl.style.display = "";
        btnClear.disabled = true;
      }
    }, 160);
  });

  historyEl.prepend(card);
  emptyEl.style.display = "none";
  btnClear.disabled = false;
}

function renderSegments(container, segments) {
  segments.forEach((seg, i) => {
    const div = document.createElement("div");
    div.className = "segment";

    const header = document.createElement("div");
    header.className = "segment-header";
    header.innerHTML = `
      <span>Fragment ${i + 1}</span>
      <span class="frag-label ${seg.isShadowFragment ? "frag-shadow" : "frag-document"}">
        ${seg.isShadowFragment ? "shadow root" : "document"}
      </span>
    `;

    const body = document.createElement("div");
    body.className = "segment-body";

    seg.elements.forEach((el) => {
      const row = document.createElement("div");
      row.className = "element-row";

      const tagSpan = document.createElement("span");
      tagSpan.className = "el-tag";
      tagSpan.textContent = `<${el.tag}>`;

      const selSpan = document.createElement("span");
      selSpan.className = "el-sel";
      selSpan.textContent = el.selector;
      selSpan.title = el.selector;

      const attrSpan = document.createElement("span");
      attrSpan.className = "el-attr";
      attrSpan.textContent = el.attributes.slice(0, 2).join("  ");
      attrSpan.title = el.attributes.join("\n");

      row.appendChild(tagSpan);
      row.appendChild(selSpan);
      row.appendChild(attrSpan);
      body.appendChild(row);
    });

    div.appendChild(header);
    div.appendChild(body);
    container.appendChild(div);
  });
}

// ─── Copy helpers ─────────────────────────────────────────────────────────────

// For text+icon buttons (Tab 1 copy buttons)
function copyToClipboard(btn, text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const prev = btn.innerHTML;
    btn.classList.add("copied");
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = prev;
    }, 1500);
  });
}

// For icon-only copy buttons (Tab 2 saved rows)
function copyIconToClipboard(btn, text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const prev      = btn.innerHTML;
    const prevTitle = btn.title;
    btn.classList.add("copied");
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    btn.title = "Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = prev;
      btn.title = prevTitle;
    }, 1500);
  });
}

// ─── Saved Elements: persistence ──────────────────────────────────────────────

function persistSaved() {
  chrome.storage.local.set({ [STORAGE_KEY]: savedItems });
}

function initSaved() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    savedItems = data[STORAGE_KEY] || [];
    renderSavedList();
    updateSavedMeta();
  });
}

// ─── Saved Elements: rendering ────────────────────────────────────────────────

function renderSavedList() {
  savedListEl.innerHTML = "";

  if (savedItems.length === 0) {
    savedEmptyEl.style.display = "";
    return;
  }

  savedEmptyEl.style.display = "none";
  savedItems.forEach((item) => savedListEl.appendChild(createSavedRow(item)));
}

function createSavedRow(item) {
  const frag = tplSavedItem.content.cloneNode(true);
  const row  = frag.querySelector(".saved-item");

  const nameInput     = row.querySelector(".saved-name");
  const selectorInput = row.querySelector(".saved-selector");
  const btnDone       = row.querySelector(".btn-mark-done");
  const doneLabel     = row.querySelector(".done-label");
  const btnDel        = row.querySelector(".btn-delete-saved");
  const btnCopyName   = row.querySelector(".saved-copy-name");
  const btnCopySel    = row.querySelector(".saved-copy-selector");
  const urlRow        = row.querySelector(".saved-url-row");
  const urlText       = row.querySelector(".saved-url-text");
  const btnCopyUrl    = row.querySelector(".saved-copy-url");

  nameInput.value     = item.name || "";
  selectorInput.value = item.selector || "";

  if (item.sourceUrl) {
    urlText.textContent = shortUrl(item.sourceUrl);
    urlText.title = item.sourceUrl;
    urlRow.removeAttribute("hidden");
    btnCopyUrl.addEventListener("click", () => copyIconToClipboard(btnCopyUrl, item.sourceUrl));
  }

  if (item.done) {
    row.classList.add("saved-item-done");
    btnDone.classList.add("done-active");
    doneLabel.textContent = "Done";
  }

  nameInput.addEventListener("input", () => {
    item.name = nameInput.value;
    persistSaved();
  });

  selectorInput.addEventListener("input", () => {
    item.selector = selectorInput.value;
    persistSaved();
  });

  btnCopyName.addEventListener("click", () => copyIconToClipboard(btnCopyName, nameInput.value));
  btnCopySel.addEventListener("click",  () => copyIconToClipboard(btnCopySel, selectorInput.value));

  btnDone.addEventListener("click", () => {
    item.done = !item.done;
    row.classList.toggle("saved-item-done", item.done);
    btnDone.classList.toggle("done-active", item.done);
    doneLabel.textContent = item.done ? "Done" : "Mark done";
    persistSaved();
    updateSavedMeta();
  });

  btnDel.addEventListener("click", () => {
    row.style.transition = "opacity 0.15s, transform 0.15s";
    row.style.opacity    = "0";
    row.style.transform  = "translateY(-4px)";
    setTimeout(() => {
      savedItems = savedItems.filter((i) => i.id !== item.id);
      persistSaved();
      renderSavedList();
      updateSavedMeta();
      // Re-enable save buttons on result cards that were blocked by a full list
      saveButtonRefreshers.forEach((fn) => fn());
    }, 160);
  });

  return row;
}

// ─── Saved Elements: add & metadata ──────────────────────────────────────────

function addToSaved(fsSelector, name, sourceUrl) {
  if (savedItems.length >= MAX_SAVED) return false;
  const id   = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const item = { id, name: name || "", selector: fsSelector, sourceUrl: sourceUrl || "", done: false, savedAt: Date.now() };
  savedItems.unshift(item);
  persistSaved();
  renderSavedList();
  updateSavedMeta();
  return true;
}

function updateSavedMeta() {
  const count     = savedItems.length;
  const doneCount = savedItems.filter((i) => i.done).length;

  // Badge on the Saved tab button
  savedBadge.textContent = count;
  if (count > 0) {
    savedBadge.removeAttribute("hidden");
  } else {
    savedBadge.setAttribute("hidden", "");
  }

  // Count label in the toolbar
  savedCountEl.textContent = `${count} saved`;

  // Clear done button
  btnClearDone.disabled  = doneCount === 0;
  btnClearDone.textContent = doneCount > 0 ? `Clear done (${doneCount})` : "Clear done";

  // Refresh scan row save buttons whenever saved list capacity changes
  scanSaveRefreshers.forEach((fn) => fn());
}

// ─── Saved search filter ─────────────────────────────────────────────────────

const savedSearchInput = document.getElementById("saved-search");

savedSearchInput.addEventListener("input", () => {
  const q = savedSearchInput.value.toLowerCase();
  savedListEl.querySelectorAll(".saved-item").forEach((row) => {
    const name = row.querySelector(".saved-name").value.toLowerCase();
    const sel  = row.querySelector(".saved-selector").value.toLowerCase();
    const url  = (row.querySelector(".saved-url-text")?.textContent || "").toLowerCase();
    row.style.display = (name.includes(q) || sel.includes(q) || url.includes(q)) ? "" : "none";
  });
});

// ─── Clear done (Tab 2) ───────────────────────────────────────────────────────

btnClearDone.addEventListener("click", () => {
  savedItems = savedItems.filter((i) => !i.done);
  persistSaved();
  renderSavedList();
  updateSavedMeta();
  // Clearing done items may free space — refresh result-card save buttons
  saveButtonRefreshers.forEach((fn) => fn());
});

// ─── Crawl tab ────────────────────────────────────────────────────────────────

let crawlTotalCandidates = 0;
let crawlResultsData     = null; // { attributeFinds, interactiveCandidates }
let crawlSelectedIds     = new Set();
let crawlIsLive          = false; // true when running in live-harvest mode (no URLs)

// ── Start / Stop buttons ──────────────────────────────────────────────────────

btnStartCrawl.addEventListener("click", () => {
  const raw  = crawlUrlInput.value.trim();
  const urls = raw.split("\n").map((u) => u.trim()).filter((u) => u.startsWith("http"));

  if (urls.length === 0) {
    // No URLs → live harvest on the current tab
    crawlIsLive = true;
    chrome.runtime.sendMessage({ type: "START_LIVE_HARVEST" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        crawlIsLive = false;
        // Fall back to showing empty state
      }
    });
    _startLiveHarvestUI();
    return;
  }

  crawlIsLive = false;
  const hydrationDelay = parseInt(crawlHydrationSel.value, 10) || 1500;
  chrome.runtime.sendMessage({ type: "START_CRAWL", urls, options: { hydrationDelay } });
  _startCrawlUI(urls.length);
});

btnStopCrawl.addEventListener("click", () => {
  if (crawlIsLive) {
    chrome.runtime.sendMessage({ type: "STOP_LIVE_HARVEST" });
  } else {
    chrome.runtime.sendMessage({ type: "STOP_CRAWL" });
  }
});

function _startCrawlUI(total) {
  crawlTotalCandidates = 0;
  crawlSelectedIds.clear();
  crawlResultsData = null;

  btnStartCrawl.hidden   = true;
  btnStopCrawl.hidden    = false;
  crawlInputSection.classList.add("crawl-input-collapsed");

  crawlProgressSection.hidden = false;
  crawlProgressSection.classList.remove("crawl-progress-live");
  crawlLiveBadge.hidden       = true;
  crawlResultsSection.hidden  = true;
  crawlEmptyEl.style.display  = "none";

  crawlProgressCount.textContent = `0 / ${total}`;
  crawlProgressBar.style.width   = "0%";
  crawlProgressText.textContent  = "Crawling…";
  crawlCurrentUrl.textContent    = "";
  crawlCandTotal.textContent     = "0";
  crawlLog.innerHTML             = "";

  // Update badge
  crawlBadge.textContent = "";
  crawlBadge.setAttribute("hidden", "");
}

function _startLiveHarvestUI() {
  crawlTotalCandidates = 0;
  crawlSelectedIds.clear();
  crawlResultsData = null;

  btnStartCrawl.hidden   = true;
  btnStopCrawl.hidden    = false;
  crawlInputSection.classList.add("crawl-input-collapsed");

  crawlProgressSection.hidden = false;
  crawlProgressSection.classList.add("crawl-progress-live");
  crawlLiveBadge.hidden       = false;
  crawlResultsSection.hidden  = true;
  crawlEmptyEl.style.display  = "none";

  crawlProgressCount.textContent = "0 pages";
  crawlProgressBar.style.width   = "100%"; // pulsing via CSS animation
  crawlProgressText.textContent  = "Live harvest…";
  crawlCurrentUrl.textContent    = "waiting for navigation…";
  crawlCandTotal.textContent     = "0";
  crawlLog.innerHTML             = "";

  crawlBadge.textContent = "";
  crawlBadge.setAttribute("hidden", "");
}

// ── Live harvest event handlers ───────────────────────────────────────────────

function onLiveHarvestStarted(payload) {
  crawlIsLive = true;
  _startLiveHarvestUI();
}

function onLiveHarvestUpdate(payload) {
  crawlIsLive = true;

  // Update progress counters
  crawlProgressCount.textContent = `${payload.pagesScanned} page${payload.pagesScanned === 1 ? "" : "s"}`;
  if (payload.currentUrl) {
    crawlCurrentUrl.textContent = payload.currentUrl;
  }

  // Merge results into the crawl results section
  const hasResults =
    (payload.attributeFinds        || []).length > 0 ||
    (payload.interactiveCandidates || []).length > 0;

  if (hasResults) {
    crawlResultsData = {
      attributeFinds:        payload.attributeFinds        || [],
      interactiveCandidates: payload.interactiveCandidates || [],
    };

    const total = crawlResultsData.attributeFinds.length + crawlResultsData.interactiveCandidates.length;
    crawlBadge.textContent = total;
    crawlBadge.removeAttribute("hidden");

    crawlResultsSection.hidden = false;
    crawlEmptyEl.style.display = "none";
    renderCrawlResults();
  }
}

function onLiveHarvestStopped(payload) {
  crawlIsLive = false;
  btnStartCrawl.hidden = false;
  btnStopCrawl.hidden  = true;
  crawlInputSection.classList.remove("crawl-input-collapsed");
  crawlProgressSection.classList.remove("crawl-progress-live");
  crawlLiveBadge.hidden = true;
  crawlProgressText.textContent = `Stopped — ${payload.pagesScanned || 0} page${payload.pagesScanned === 1 ? "" : "s"} harvested`;

  if (payload.attributeFinds || payload.interactiveCandidates) {
    crawlResultsData = {
      attributeFinds:        payload.attributeFinds        || [],
      interactiveCandidates: payload.interactiveCandidates || [],
    };
    const total = crawlResultsData.attributeFinds.length + crawlResultsData.interactiveCandidates.length;
    if (total > 0) {
      crawlBadge.textContent = total;
      crawlBadge.removeAttribute("hidden");
      crawlResultsSection.hidden = false;
      crawlEmptyEl.style.display = "none";
      renderCrawlResults();
    }
  }
}

function onLiveHarvestStateRestore(payload) {
  if (!payload) return;
  crawlIsLive = !!payload.running;

  const hasResults =
    (payload.attributeFinds        || []).length > 0 ||
    (payload.interactiveCandidates || []).length > 0;

  if (payload.running) {
    _startLiveHarvestUI();
    crawlProgressCount.textContent = `${payload.pagesScanned || 0} pages`;
    if (payload.currentUrl) crawlCurrentUrl.textContent = payload.currentUrl;
  }

  if (hasResults) {
    crawlResultsData = {
      attributeFinds:        payload.attributeFinds        || [],
      interactiveCandidates: payload.interactiveCandidates || [],
    };
    const total = crawlResultsData.attributeFinds.length + crawlResultsData.interactiveCandidates.length;
    crawlBadge.textContent = total;
    crawlBadge.removeAttribute("hidden");
    crawlResultsSection.hidden = false;
    crawlEmptyEl.style.display = "none";
    renderCrawlResults();
  }
}

// ── Progress handlers ─────────────────────────────────────────────────────────

function onCrawlProgress(payload) {
  const pct = payload.total > 0 ? Math.round((payload.done / payload.total) * 100) : 0;
  crawlProgressBar.style.width   = `${pct}%`;
  crawlProgressCount.textContent = `${payload.done} / ${payload.total}`;
  crawlProgressText.textContent  = payload.running ? "Crawling…" : "Finishing…";
  if (payload.currentUrl) {
    crawlCurrentUrl.textContent = payload.currentUrl;
  }
}

function onCrawlPageResult(payload) {
  const total = (payload.attrCount || 0) + (payload.interactiveCount || 0);
  crawlTotalCandidates += total;
  crawlCandTotal.textContent = String(crawlTotalCandidates);

  // Append a log line
  const line = document.createElement("div");
  line.className = "crawl-log-line";
  const short = payload.pageTitle || payload.url;
  line.textContent = `✓ ${short.slice(0, 45)} — ${total} candidates`;
  crawlLog.appendChild(line);
  crawlLog.scrollTop = crawlLog.scrollHeight;
}

function onCrawlPageError(payload) {
  const line = document.createElement("div");
  line.className = "crawl-log-line crawl-log-error";
  line.textContent = `✗ ${payload.url} — ${payload.error}`;
  crawlLog.appendChild(line);
  crawlLog.scrollTop = crawlLog.scrollHeight;
}

function onCrawlComplete(payload) {
  crawlResultsData = {
    attributeFinds:        payload.attributeFinds        || [],
    interactiveCandidates: payload.interactiveCandidates || [],
  };

  btnStartCrawl.hidden = false;
  btnStopCrawl.hidden  = true;
  crawlInputSection.classList.remove("crawl-input-collapsed");
  crawlProgressSection.hidden = true;
  crawlProgressText.textContent = "Done";

  const total = crawlResultsData.attributeFinds.length + crawlResultsData.interactiveCandidates.length;
  if (crawlBadge) {
    crawlBadge.textContent = total;
    crawlBadge.removeAttribute("hidden");
  }

  renderCrawlResults();
}

function onCrawlStopped(payload) {
  btnStartCrawl.hidden = false;
  btnStopCrawl.hidden  = true;
  crawlInputSection.classList.remove("crawl-input-collapsed");
  crawlProgressText.textContent = `Stopped at ${payload.done} / ${payload.total} pages`;
}

function onCrawlStateRestore(payload) {
  if (payload.results) {
    crawlResultsData = payload.results;
    const total = (crawlResultsData.attributeFinds || []).length +
                  (crawlResultsData.interactiveCandidates || []).length;
    if (total > 0) {
      crawlResultsSection.hidden = false;
      crawlEmptyEl.style.display = "none";
      crawlBadge.textContent = total;
      crawlBadge.removeAttribute("hidden");
      renderCrawlResults();
    }
  }
  if (payload.state && payload.state.running) {
    // Crawl was still going — show progress UI
    _startCrawlUI(payload.state.total || 0);
    crawlProgressCount.textContent = `${payload.state.done} / ${payload.state.total}`;
  }
}

// ── Result rendering ──────────────────────────────────────────────────────────

function renderCrawlResults() {
  if (!crawlResultsData) return;

  crawlSelectedIds.clear();
  crawlResultsSection.hidden = false;
  crawlEmptyEl.style.display = "none";

  const query = (crawlSearch.value || "").toLowerCase();

  const attrItems = (crawlResultsData.attributeFinds || []).filter((e) =>
    !query || _crawlEntryMatchesQuery(e, query)
  );
  const intItems = (crawlResultsData.interactiveCandidates || []).filter((e) =>
    !query || _crawlEntryMatchesQuery(e, query)
  );

  crawlAttrCount.textContent       = `${attrItems.length}`;
  crawlInteractiveCount.textContent = `${intItems.length}`;

  crawlAttrList.innerHTML       = "";
  crawlInteractiveList.innerHTML = "";

  attrItems.forEach((e) => crawlAttrList.appendChild(createCrawlRow(e)));
  intItems.forEach((e) => crawlInteractiveList.appendChild(createCrawlRow(e)));

  _updateCrawlSaveButton();
}

function _crawlEntryMatchesQuery(entry, q) {
  return (
    (entry.name || "").toLowerCase().includes(q) ||
    (entry.fullstorySelector || "").toLowerCase().includes(q) ||
    (entry.textContent || "").toLowerCase().includes(q) ||
    (entry.ariaLabel || "").toLowerCase().includes(q) ||
    (entry.attrValue || "").toLowerCase().includes(q)
  );
}

function createCrawlRow(entry) {
  const row = document.createElement("div");
  row.className = "crawl-row";
  row.dataset.id = entry.fullstorySelector;

  // Score badge
  const scoreBadge = document.createElement("span");
  scoreBadge.className = `crawl-score ${
    entry.score >= 70 ? "score-high" : entry.score >= 40 ? "score-mid" : "score-low"
  }`;
  scoreBadge.textContent = entry.score;
  scoreBadge.title = (entry.reasons || []).join(", ") || "Score";

  // Checkbox
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "crawl-checkbox";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      crawlSelectedIds.add(entry.fullstorySelector);
    } else {
      crawlSelectedIds.delete(entry.fullstorySelector);
    }
    _updateCrawlSaveButton();
    _syncSelectAll();
  });

  // Name (editable)
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "crawl-name-input";
  nameInput.value = entry.name || "";
  nameInput.title = "Auto-generated name — click to edit";
  nameInput.addEventListener("input", () => { entry.name = nameInput.value; });

  // Selector (readonly monospace)
  const selSpan = document.createElement("span");
  selSpan.className = "crawl-selector";
  selSpan.textContent = entry.fullstorySelector;
  selSpan.title = entry.fullstorySelector;

  // Meta row: seen-on count + source badge
  const meta = document.createElement("span");
  meta.className = "crawl-meta";
  const seenCount = (entry.seenOn || []).length || 1;
  meta.innerHTML = `
    <span class="crawl-seen-badge" title="${(entry.seenOn || []).join('\n')}">
      ${seenCount} page${seenCount !== 1 ? "s" : ""}
    </span>
    <span class="crawl-source-badge crawl-source-${entry.source}">${entry.source}</span>
  `;
  if (entry.inShadow) {
    meta.innerHTML += `<span class="scan-shadow-badge">shadow</span>`;
  }

  row.appendChild(checkbox);
  row.appendChild(scoreBadge);
  row.appendChild(nameInput);
  row.appendChild(selSpan);
  row.appendChild(meta);

  return row;
}

function _updateCrawlSaveButton() {
  const n = crawlSelectedIds.size;
  crawlSelectedCount.textContent  = `${n} selected`;
  btnSaveCrawlSelected.disabled   = n === 0;
  btnSaveCrawlLabel.textContent   = n > 0 ? `Save ${n} Selected` : "Save Selected";
}

function _syncSelectAll() {
  const all = Array.from(
    document.querySelectorAll("#crawl-attr-list .crawl-checkbox, #crawl-interactive-list .crawl-checkbox")
  );
  crawlSelectAll.checked = all.length > 0 && all.every((cb) => cb.checked);
}

// ── Select-all ────────────────────────────────────────────────────────────────

crawlSelectAll.addEventListener("change", () => {
  const checked = crawlSelectAll.checked;
  document.querySelectorAll("#crawl-attr-list .crawl-checkbox, #crawl-interactive-list .crawl-checkbox")
    .forEach((cb) => {
      cb.checked = checked;
      const id = cb.closest(".crawl-row").dataset.id;
      if (checked) crawlSelectedIds.add(id);
      else crawlSelectedIds.delete(id);
    });
  _updateCrawlSaveButton();
});

// ── Search / filter ───────────────────────────────────────────────────────────

crawlSearch.addEventListener("input", () => renderCrawlResults());

// ── Save selected ─────────────────────────────────────────────────────────────

btnSaveCrawlSelected.addEventListener("click", () => {
  if (crawlSelectedIds.size === 0 || !crawlResultsData) return;

  const allEntries = [
    ...(crawlResultsData.attributeFinds || []),
    ...(crawlResultsData.interactiveCandidates || []),
  ];

  let saved = 0;
  for (const entry of allEntries) {
    if (!crawlSelectedIds.has(entry.fullstorySelector)) continue;
    if (savedItems.length >= MAX_SAVED) break;
    addToSaved(entry.fullstorySelector, entry.name || "", entry.sourceUrl || (entry.seenOn || [])[0] || "");
    saved++;
  }

  if (saved > 0) {
    // Flash the Saved tab badge
    switchTab("saved");
  }

  crawlSelectedIds.clear();
  document.querySelectorAll("#crawl-attr-list .crawl-checkbox, #crawl-interactive-list .crawl-checkbox")
    .forEach((cb) => { cb.checked = false; });
  crawlSelectAll.checked = false;
  _updateCrawlSaveButton();
});

// ── Clear results ─────────────────────────────────────────────────────────────

btnClearCrawl.addEventListener("click", () => {
  crawlResultsData = null;
  crawlSelectedIds.clear();
  crawlResultsSection.hidden = true;
  crawlEmptyEl.style.display = "";
  crawlBadge.textContent     = "";
  crawlBadge.setAttribute("hidden", "");
  crawlProgressSection.classList.remove("crawl-progress-live");
  chrome.storage.session.remove(["crawlState", "crawlResults"]);
  chrome.runtime.sendMessage({ type: "CLEAR_LIVE_HARVEST" }, () => {});
  crawlIsLive = false;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

connectPort();
initSaved();

chrome.runtime.sendMessage({ type: "GET_TAB_STATE" }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state) applyTabState(state);
});
