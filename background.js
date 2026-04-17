importScripts("crawler.js");

"use strict";

/**
 * Service worker for the Shadow DOM Selector extension.
 *
 * Responsibilities:
 * - Open the side panel when the toolbar icon is clicked.
 * - Relay ACTIVATE / DEACTIVATE messages from the side panel to the content script.
 * - Forward SELECTOR_RESULT and PICKER_CANCELLED messages from the content
 *   script to the side panel port.
 * - Track picker state per tab so the side panel reflects the correct status
 *   when it connects.
 *
 * Tab state is persisted in chrome.storage.session so results survive service
 * worker restarts within the same browser session.
 */

// Long-lived connection from the side panel
let panelPort = null;

// ─── Tab state helpers (chrome.storage.session) ───────────────────────────────

const TAB_STATE_KEY = "tabStates";

async function getTabState(tabId) {
  const data = await chrome.storage.session.get(TAB_STATE_KEY);
  const all  = data[TAB_STATE_KEY] || {};
  return all[String(tabId)] || { active: false, results: [] };
}

async function setTabState(tabId, patch) {
  const data     = await chrome.storage.session.get(TAB_STATE_KEY);
  const all      = data[TAB_STATE_KEY] || {};
  const existing = all[String(tabId)] || { active: false, results: [] };
  all[String(tabId)] = { ...existing, ...patch };
  await chrome.storage.session.set({ [TAB_STATE_KEY]: all });
}

async function deleteTabState(tabId) {
  const data = await chrome.storage.session.get(TAB_STATE_KEY);
  const all  = data[TAB_STATE_KEY] || {};
  delete all[String(tabId)];
  await chrome.storage.session.set({ [TAB_STATE_KEY]: all });
}

async function getAllTabStates() {
  const data = await chrome.storage.session.get(TAB_STATE_KEY);
  return data[TAB_STATE_KEY] || {};
}

// ─── Crawl state machine ──────────────────────────────────────────────────────

let crawlQueue   = [];
let crawlRunning = false;
let crawlDone    = 0;
let crawlTotal   = 0;
let crawlTabId   = null;
let crawlAllEntries = [];
let crawlOptions = {};

function _sendToPanel(msg) {
  if (panelPort) panelPort.postMessage(msg);
}

async function startCrawl(urls, options) {
  if (crawlRunning) return;
  crawlQueue      = urls.filter((u) => u && u.trim());
  crawlTotal      = crawlQueue.length;
  crawlDone       = 0;
  crawlRunning    = true;
  crawlAllEntries = [];
  crawlOptions    = options || {};

  await chrome.storage.session.set({
    crawlState: { running: true, total: crawlTotal, done: 0 },
  });

  _processCrawlQueue();
}

async function stopCrawl() {
  crawlRunning = false;
  crawlQueue   = [];
  if (crawlTabId !== null) {
    chrome.tabs.remove(crawlTabId).catch(() => {});
    crawlTabId = null;
  }
  await chrome.storage.session.set({
    crawlState: { running: false, total: crawlTotal, done: crawlDone, stopped: true },
  });
  _sendToPanel({ type: "CRAWL_STOPPED", payload: { done: crawlDone, total: crawlTotal } });
}

async function _processCrawlQueue() {
  if (!crawlRunning || crawlQueue.length === 0) {
    await _finishCrawl();
    return;
  }

  const url             = crawlQueue.shift();
  const hydrationDelay  = crawlOptions.hydrationDelay || 1500;

  _sendToPanel({
    type: "CRAWL_PROGRESS",
    payload: { done: crawlDone, total: crawlTotal, currentUrl: url, running: true },
  });

  let tabId = null;

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId      = tab.id;
    crawlTabId = tabId;

    // Wait for tab to reach "complete" status (30 s timeout)
    await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("load timeout"));
      }, 30000);

      function listener(updatedId, changeInfo) {
        if (updatedId === tabId && changeInfo.status === "complete") {
          clearTimeout(giveUp);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Give the page extra time for hydration / JS frameworks
    await new Promise((r) => setTimeout(r, hydrationDelay));

    if (!crawlRunning) {
      chrome.tabs.remove(tabId).catch(() => {});
      return;
    }

    // Ask the content script to harvest the page
    const resp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "HARVEST_PAGE" }, { frameId: 0 }, (r) => {
        if (chrome.runtime.lastError) {
          // Inject content script if it wasn't already there (e.g. extension-restricted pages)
          chrome.scripting
            .executeScript({ target: { tabId }, files: ["content.js"] })
            .then(() =>
              new Promise((res) =>
                setTimeout(
                  () => chrome.tabs.sendMessage(tabId, { type: "HARVEST_PAGE" }, { frameId: 0 }, res),
                  600
                )
              )
            )
            .then(resolve)
            .catch(() => resolve(null));
        } else {
          resolve(r || null);
        }
      });
    });

    if (resp && resp.ok && resp.payload) {
      const entries = [
        ...(resp.payload.attrResults         || []),
        ...(resp.payload.interactiveCandidates || []),
      ];
      crawlAllEntries.push(...entries);
      _sendToPanel({
        type: "CRAWL_PAGE_RESULT",
        payload: {
          url,
          pageTitle:       resp.payload.pageTitle || url,
          attrCount:       (resp.payload.attrResults         || []).length,
          interactiveCount:(resp.payload.interactiveCandidates || []).length,
        },
      });
    }
  } catch (err) {
    _sendToPanel({ type: "CRAWL_PAGE_ERROR", payload: { url, error: String(err) } });
  } finally {
    if (tabId !== null) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    crawlTabId = null;
  }

  crawlDone++;
  _sendToPanel({
    type: "CRAWL_PROGRESS",
    payload: { done: crawlDone, total: crawlTotal, currentUrl: null, running: crawlQueue.length > 0 },
  });

  _processCrawlQueue();
}

async function _finishCrawl() {
  crawlRunning = false;

  const processed = processCrawlResults(crawlAllEntries);

  await chrome.storage.session.set({
    crawlState:   { running: false, total: crawlTotal, done: crawlDone },
    crawlResults: processed,
  });

  _sendToPanel({
    type: "CRAWL_COMPLETE",
    payload: { total: crawlTotal, done: crawlDone, ...processed },
  });
}

// ─── Live scan state machine ─────────────────────────────────────────────────
//
// A "live scan" latches onto a single tab and re-runs SCAN_PAGE for a chosen
// attribute every time that tab finishes a navigation (both full page loads
// and SPA history state changes). Results are merged by attrValue with a list
// of URLs the value was seen on, and streamed to the side panel as they come in.

const LIVE_SCAN_KEY          = "liveScanState";
const LIVE_SCAN_HYDRATION_MS = 1500;
const LIVE_SCAN_DEBOUNCE_MS  = 350;

let liveScan = {
  running:      false,
  attrName:     null,
  tabId:        null,
  entries:      new Map(), // attrValue → merged entry
  urlsSeen:     new Set(),
  currentUrl:   null,
  pagesScanned: 0,
  _scanTimer:   null,
  _lastTrigger: 0,
};

async function _persistLiveScan() {
  await chrome.storage.session.set({
    [LIVE_SCAN_KEY]: {
      running:      liveScan.running,
      attrName:     liveScan.attrName,
      tabId:        liveScan.tabId,
      currentUrl:   liveScan.currentUrl,
      pagesScanned: liveScan.pagesScanned,
      urlsSeen:     Array.from(liveScan.urlsSeen),
      entries:      Array.from(liveScan.entries.values()),
    },
  });
}

function _liveScanPayload() {
  return {
    running:      liveScan.running,
    attrName:     liveScan.attrName,
    tabId:        liveScan.tabId,
    currentUrl:   liveScan.currentUrl,
    pagesScanned: liveScan.pagesScanned,
    urls:         Array.from(liveScan.urlsSeen),
    entries:      Array.from(liveScan.entries.values()),
  };
}

async function startLiveScan(attrName, tabId) {
  if (!attrName || !tabId) return { ok: false, error: "missing attrName or tabId" };

  stopLiveScanListeners();

  liveScan = {
    running:      true,
    attrName,
    tabId,
    entries:      new Map(),
    urlsSeen:     new Set(),
    currentUrl:   null,
    pagesScanned: 0,
    _scanTimer:   null,
    _lastTrigger: 0,
  };

  startLiveScanListeners();
  await _persistLiveScan();

  _sendToPanel({ type: "LIVE_SCAN_STARTED", payload: _liveScanPayload() });

  // Kick off an immediate scan on the currently loaded page
  _scheduleLiveScan(0);
  return { ok: true };
}

async function stopLiveScan() {
  if (!liveScan.running) return;
  stopLiveScanListeners();
  liveScan.running = false;
  if (liveScan._scanTimer) {
    clearTimeout(liveScan._scanTimer);
    liveScan._scanTimer = null;
  }
  await _persistLiveScan();
  _sendToPanel({ type: "LIVE_SCAN_STOPPED", payload: _liveScanPayload() });
}

function _scheduleLiveScan(delay) {
  if (!liveScan.running) return;
  if (liveScan._scanTimer) clearTimeout(liveScan._scanTimer);
  const d = typeof delay === "number" ? delay : (LIVE_SCAN_HYDRATION_MS + LIVE_SCAN_DEBOUNCE_MS);
  liveScan._scanTimer = setTimeout(_runLiveScan, d);
}

async function _runLiveScan() {
  if (!liveScan.running || liveScan.tabId === null) return;
  liveScan._scanTimer = null;

  // Read the current URL from the tab
  let tab;
  try {
    tab = await chrome.tabs.get(liveScan.tabId);
  } catch {
    // Tab is gone — stop
    await stopLiveScan();
    return;
  }
  const url = tab.url || "";
  liveScan.currentUrl = url;

  const attrName = liveScan.attrName;

  const resp = await new Promise((resolve) => {
    chrome.tabs.sendMessage(
      liveScan.tabId,
      { type: "SCAN_PAGE", attrName },
      { frameId: 0 },
      (r) => {
        if (chrome.runtime.lastError) {
          chrome.scripting
            .executeScript({ target: { tabId: liveScan.tabId }, files: ["content.js"] })
            .then(() =>
              new Promise((res) =>
                setTimeout(
                  () => chrome.tabs.sendMessage(
                    liveScan.tabId,
                    { type: "SCAN_PAGE", attrName },
                    { frameId: 0 },
                    res,
                  ),
                  400,
                ),
              ),
            )
            .then(resolve)
            .catch(() => resolve(null));
        } else {
          resolve(r || null);
        }
      },
    );
  });

  if (!resp || !resp.ok) return;

  const results = resp.results || [];
  const newKeys = [];

  for (const item of results) {
    const key = item.attrValue;
    if (!key) continue;

    if (!liveScan.entries.has(key)) {
      liveScan.entries.set(key, {
        ...item,
        seenOn:    url ? [url] : [],
        count:     item.count || 1,
        firstSeen: url,
      });
      newKeys.push(key);
    } else {
      const existing = liveScan.entries.get(key);
      if (url && !existing.seenOn.includes(url)) existing.seenOn.push(url);
      existing.count = Math.max(existing.count, item.count || 1);
      // Keep richer metadata if new scan exposes longer debug/segments
      if ((item.debugPath || "").length > (existing.debugPath || "").length) {
        existing.debugPath = item.debugPath;
        existing.segments  = item.segments;
      }
    }
  }

  if (url) liveScan.urlsSeen.add(url);
  liveScan.pagesScanned += 1;

  await _persistLiveScan();

  _sendToPanel({
    type: "LIVE_SCAN_UPDATE",
    payload: {
      pageUrl:      url,
      pagesScanned: liveScan.pagesScanned,
      urls:         Array.from(liveScan.urlsSeen),
      entries:      Array.from(liveScan.entries.values()),
      newKeys,
    },
  });
}

function _onLiveTabUpdated(tabId, changeInfo /*, tab */) {
  if (!liveScan.running || tabId !== liveScan.tabId) return;
  if (changeInfo.status === "complete") {
    _scheduleLiveScan();
  }
}

function _onLiveHistoryStateUpdated(details) {
  if (!liveScan.running) return;
  if (details.tabId !== liveScan.tabId) return;
  if (details.frameId !== 0) return;
  _scheduleLiveScan();
}

function _onLiveTabRemoved(tabId) {
  if (liveScan.running && tabId === liveScan.tabId) {
    stopLiveScan();
  }
}

function startLiveScanListeners() {
  chrome.tabs.onUpdated.addListener(_onLiveTabUpdated);
  chrome.tabs.onRemoved.addListener(_onLiveTabRemoved);
  if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(_onLiveHistoryStateUpdated);
  }
}

function stopLiveScanListeners() {
  chrome.tabs.onUpdated.removeListener(_onLiveTabUpdated);
  chrome.tabs.onRemoved.removeListener(_onLiveTabRemoved);
  if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.removeListener(_onLiveHistoryStateUpdated);
  }
}

async function restoreLiveScanFromStorage() {
  const data = await chrome.storage.session.get(LIVE_SCAN_KEY);
  const saved = data[LIVE_SCAN_KEY];
  if (!saved) return;
  liveScan = {
    running:      !!saved.running,
    attrName:     saved.attrName || null,
    tabId:        saved.tabId    || null,
    entries:      new Map((saved.entries || []).map((e) => [e.attrValue, e])),
    urlsSeen:     new Set(saved.urlsSeen || []),
    currentUrl:   saved.currentUrl || null,
    pagesScanned: saved.pagesScanned || 0,
    _scanTimer:   null,
    _lastTrigger: 0,
  };
  if (liveScan.running) startLiveScanListeners();
}

// Attempt to rehydrate on each service worker wake
restoreLiveScanFromStorage();

// ─── Live harvest state machine ───────────────────────────────────────────────
//
// When the Crawl tab is used without any URLs, "Start Crawl" latches onto the
// active tab and runs HARVEST_PAGE (all attrs + interactive candidates) on every
// navigation — full loads AND SPA history-state changes — then merges, scores,
// and streams the growing result set back to the side panel in real-time.
//
// This reuses the existing CRAWL_PAGE_RESULT message for the log rows, and
// introduces LIVE_HARVEST_STARTED / _UPDATE / _STOPPED / _STATE for lifecycle.

const LIVE_HARVEST_KEY          = "liveHarvestState";
const LIVE_HARVEST_HYDRATION_MS = 1500;
const LIVE_HARVEST_DEBOUNCE_MS  = 350;

let liveHarvest = {
  running:      false,
  tabId:        null,
  allEntries:   [],    // flat raw entries across all visited pages
  pagesScanned: 0,
  urlsSeen:     new Set(),
  currentUrl:   null,
  _scanTimer:   null,
};

async function _persistLiveHarvest() {
  let results = null;
  if (liveHarvest.allEntries.length > 0) {
    try { results = processCrawlResults(dedupeAndMerge(liveHarvest.allEntries)); } catch {}
  }
  await chrome.storage.session.set({
    [LIVE_HARVEST_KEY]: {
      running:      liveHarvest.running,
      tabId:        liveHarvest.tabId,
      pagesScanned: liveHarvest.pagesScanned,
      currentUrl:   liveHarvest.currentUrl,
      urlsSeen:     Array.from(liveHarvest.urlsSeen),
      // Cap stored raw entries so session storage stays small
      allEntries:   liveHarvest.allEntries.slice(-600),
      results,
    },
  });
}

function _liveHarvestPayload(processed) {
  return {
    running:      liveHarvest.running,
    tabId:        liveHarvest.tabId,
    pagesScanned: liveHarvest.pagesScanned,
    currentUrl:   liveHarvest.currentUrl,
    urls:         Array.from(liveHarvest.urlsSeen),
    ...(processed || {}),
  };
}

async function startLiveHarvest(tabId) {
  if (!tabId) return { ok: false, error: "No tabId" };

  stopLiveHarvestListeners();

  liveHarvest = {
    running:      true,
    tabId,
    allEntries:   [],
    pagesScanned: 0,
    urlsSeen:     new Set(),
    currentUrl:   null,
    _scanTimer:   null,
  };

  startLiveHarvestListeners();
  await _persistLiveHarvest();

  _sendToPanel({ type: "LIVE_HARVEST_STARTED", payload: _liveHarvestPayload() });

  // Immediately harvest the currently loaded page
  _scheduleLiveHarvest(0);
  return { ok: true };
}

async function stopLiveHarvest() {
  if (!liveHarvest.running && liveHarvest.pagesScanned === 0) return;
  stopLiveHarvestListeners();
  liveHarvest.running = false;
  if (liveHarvest._scanTimer) {
    clearTimeout(liveHarvest._scanTimer);
    liveHarvest._scanTimer = null;
  }
  let processed = null;
  if (liveHarvest.allEntries.length > 0) {
    try { processed = processCrawlResults(dedupeAndMerge(liveHarvest.allEntries)); } catch {}
  }
  await _persistLiveHarvest();
  _sendToPanel({ type: "LIVE_HARVEST_STOPPED", payload: _liveHarvestPayload(processed) });
}

async function clearLiveHarvest() {
  await stopLiveHarvest();
  liveHarvest.allEntries   = [];
  liveHarvest.pagesScanned = 0;
  liveHarvest.urlsSeen     = new Set();
  liveHarvest.currentUrl   = null;
  await chrome.storage.session.remove(LIVE_HARVEST_KEY);
  _sendToPanel({ type: "LIVE_HARVEST_STATE", payload: _liveHarvestPayload() });
}

function _scheduleLiveHarvest(delay) {
  if (!liveHarvest.running) return;
  if (liveHarvest._scanTimer) clearTimeout(liveHarvest._scanTimer);
  const d = typeof delay === "number" ? delay : (LIVE_HARVEST_HYDRATION_MS + LIVE_HARVEST_DEBOUNCE_MS);
  liveHarvest._scanTimer = setTimeout(_runLiveHarvest, d);
}

async function _runLiveHarvest() {
  if (!liveHarvest.running || liveHarvest.tabId === null) return;
  liveHarvest._scanTimer = null;

  let tab;
  try {
    tab = await chrome.tabs.get(liveHarvest.tabId);
  } catch {
    await stopLiveHarvest();
    return;
  }

  const url = tab.url || "";
  liveHarvest.currentUrl = url;

  // Skip extension/chrome pages that can't be scripted
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    _sendToPanel({
      type: "CRAWL_PAGE_ERROR",
      payload: { url: url || "(unknown)", error: "Page cannot be scripted" },
    });
    return;
  }

  const resp = await new Promise((resolve) => {
    chrome.tabs.sendMessage(
      liveHarvest.tabId,
      { type: "HARVEST_PAGE" },
      { frameId: 0 },
      (r) => {
        if (chrome.runtime.lastError) {
          chrome.scripting
            .executeScript({ target: { tabId: liveHarvest.tabId }, files: ["content.js"] })
            .then(() =>
              new Promise((res) =>
                setTimeout(
                  () => chrome.tabs.sendMessage(
                    liveHarvest.tabId,
                    { type: "HARVEST_PAGE" },
                    { frameId: 0 },
                    res,
                  ),
                  400,
                ),
              ),
            )
            .then(resolve)
            .catch(() => resolve(null));
        } else {
          resolve(r || null);
        }
      },
    );
  });

  if (!resp || !resp.ok || !resp.payload) {
    _sendToPanel({ type: "CRAWL_PAGE_ERROR", payload: { url, error: "Harvest returned no data" } });
    return;
  }

  const payload     = resp.payload;
  const newEntries  = [
    ...(payload.attrResults           || []),
    ...(payload.interactiveCandidates || []),
  ];
  liveHarvest.allEntries.push(...newEntries);
  if (url) liveHarvest.urlsSeen.add(url);
  liveHarvest.pagesScanned += 1;

  // Log line — reuses the existing CRAWL_PAGE_RESULT handler in the side panel
  _sendToPanel({
    type: "CRAWL_PAGE_RESULT",
    payload: {
      url,
      pageTitle:        payload.pageTitle || url,
      attrCount:        (payload.attrResults           || []).length,
      interactiveCount: (payload.interactiveCandidates || []).length,
    },
  });

  // Merge, score, stream full updated results
  let processed = null;
  try { processed = processCrawlResults(dedupeAndMerge(liveHarvest.allEntries)); } catch {}

  await _persistLiveHarvest();

  _sendToPanel({
    type: "LIVE_HARVEST_UPDATE",
    payload: _liveHarvestPayload(processed),
  });
}

function _onLiveHarvestTabUpdated(tabId, changeInfo) {
  if (!liveHarvest.running || tabId !== liveHarvest.tabId) return;
  if (changeInfo.status === "complete") _scheduleLiveHarvest();
}

function _onLiveHarvestHistoryStateUpdated(details) {
  if (!liveHarvest.running) return;
  if (details.tabId !== liveHarvest.tabId || details.frameId !== 0) return;
  _scheduleLiveHarvest();
}

function _onLiveHarvestTabRemoved(tabId) {
  if (liveHarvest.running && tabId === liveHarvest.tabId) stopLiveHarvest();
}

function startLiveHarvestListeners() {
  chrome.tabs.onUpdated.addListener(_onLiveHarvestTabUpdated);
  chrome.tabs.onRemoved.addListener(_onLiveHarvestTabRemoved);
  if (chrome.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(_onLiveHarvestHistoryStateUpdated);
  }
}

function stopLiveHarvestListeners() {
  chrome.tabs.onUpdated.removeListener(_onLiveHarvestTabUpdated);
  chrome.tabs.onRemoved.removeListener(_onLiveHarvestTabRemoved);
  if (chrome.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.removeListener(_onLiveHarvestHistoryStateUpdated);
  }
}

async function restoreLiveHarvestFromStorage() {
  const data  = await chrome.storage.session.get(LIVE_HARVEST_KEY);
  const saved = data[LIVE_HARVEST_KEY];
  if (!saved) return;
  liveHarvest = {
    running:      false,   // Never auto-resume after SW restart
    tabId:        saved.tabId        || null,
    allEntries:   saved.allEntries   || [],
    pagesScanned: saved.pagesScanned || 0,
    urlsSeen:     new Set(saved.urlsSeen || []),
    currentUrl:   saved.currentUrl   || null,
    _scanTimer:   null,
  };
}

// Rehydrate on each service worker wake
restoreLiveHarvestFromStorage();

// ─── Open side panel when toolbar icon is clicked ─────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Long-lived side panel connection ────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;

  panelPort = port;

  port.onDisconnect.addListener(() => {
    panelPort = null;
  });

  // When the panel connects, send current state for the active tab
  getCurrentTab().then(async (tab) => {
    if (!tab) return;
    const state = await getTabState(tab.id);
    port.postMessage({ type: "TAB_STATE", payload: state });
  });

  // Also restore any crawl state / results so the panel can show them after reconnect
  chrome.storage.session.get(["crawlState", "crawlResults"], (data) => {
    if (data.crawlState || data.crawlResults) {
      port.postMessage({
        type: "CRAWL_STATE",
        payload: { state: data.crawlState || null, results: data.crawlResults || null },
      });
    }
  });

  // Push live-scan state if a session is in progress (or has accumulated results)
  if (liveScan.running || liveScan.entries.size > 0) {
    port.postMessage({ type: "LIVE_SCAN_STATE", payload: _liveScanPayload() });
  }

  // Push live-harvest state so the Crawl tab can show accumulated results
  if (liveHarvest.running || liveHarvest.pagesScanned > 0) {
    let processed = null;
    if (liveHarvest.allEntries.length > 0) {
      try { processed = processCrawlResults(dedupeAndMerge(liveHarvest.allEntries)); } catch {}
    }
    port.postMessage({ type: "LIVE_HARVEST_STATE", payload: _liveHarvestPayload(processed) });
  }
});

// ─── One-shot messages ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    // ── From side panel → content script ─────────────────────────────────
    case "ACTIVATE_PICKER": {
      getCurrentTab().then(async (tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab" });
        await setTabState(tab.id, { active: true });
        chrome.tabs.sendMessage(tab.id, { type: "ACTIVATE_PICKER" }, (resp) => {
          if (chrome.runtime.lastError) {
            chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
              .then(() => chrome.tabs.sendMessage(tab.id, { type: "ACTIVATE_PICKER" }))
              .catch(console.error);
          }
          sendResponse(resp || { ok: true });
        });
      });
      return true;
    }

    case "DEACTIVATE_PICKER": {
      getCurrentTab().then(async (tab) => {
        const allStates   = await getAllTabStates();
        const activeEntry = Object.entries(allStates).find(([, s]) => s.active);
        const targetTabId = activeEntry ? Number(activeEntry[0]) : tab?.id;

        if (!targetTabId) return sendResponse({ ok: false, error: "No active tab" });

        await setTabState(targetTabId, { active: false });

        chrome.tabs.sendMessage(targetTabId, { type: "DEACTIVATE_PICKER" }, (resp) => {
          if (chrome.runtime.lastError) {
            chrome.scripting
              .executeScript({
                target: { tabId: targetTabId },
                func: () => {
                  document.body.style.cursor = "";
                  document.getElementById("__fs-shadow-picker-overlay__")?.remove();
                  document.getElementById("__fs-shadow-picker-tooltip__")?.remove();
                },
              })
              .catch(() => {});
          }
          sendResponse(resp || { ok: true });
        });
      });
      return true;
    }

    case "GET_TAB_STATE": {
      getCurrentTab().then(async (tab) => {
        if (!tab) return sendResponse({ active: false, results: [] });
        sendResponse(await getTabState(tab.id));
      });
      return true;
    }

    case "CLEAR_RESULTS": {
      getCurrentTab().then(async (tab) => {
        if (!tab) return;
        await setTabState(tab.id, { results: [] });
        sendResponse({ ok: true });
      });
      return true;
    }

    case "DISCOVER_ATTRIBUTES": {
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab", attrs: [] });
        chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_ATTRIBUTES" }, { frameId: 0 }, (resp) => {
          if (chrome.runtime.lastError) {
            chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
              .then(() =>
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "DISCOVER_ATTRIBUTES" },
                  { frameId: 0 },
                  (r) => sendResponse(r || { ok: false, attrs: [] })
                )
              )
              .catch((err) => sendResponse({ ok: false, error: String(err), attrs: [] }));
            return;
          }
          sendResponse(resp || { ok: false, attrs: [] });
        });
      });
      return true;
    }

    case "SCAN_PAGE": {
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab", results: [] });
        const tabUrl = tab.url || "";
        const addUrl = (resp) => {
          if (resp && resp.results) {
            resp.results = resp.results.map((r) => ({ ...r, sourceUrl: tabUrl }));
          }
          return resp;
        };
        chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE", attrName: msg.attrName }, { frameId: 0 }, (resp) => {
          if (chrome.runtime.lastError) {
            chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
              .then(() =>
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "SCAN_PAGE", attrName: msg.attrName },
                  { frameId: 0 },
                  (r) => sendResponse(addUrl(r) || { ok: false, results: [] })
                )
              )
              .catch((err) => sendResponse({ ok: false, error: String(err), results: [] }));
            return;
          }
          sendResponse(addUrl(resp) || { ok: false, results: [] });
        });
      });
      return true;
    }

    case "HIGHLIGHT_ELEMENT": {
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ ok: false });
        chrome.tabs.sendMessage(
          tab.id,
          { type: "HIGHLIGHT_ELEMENT", attrName: msg.attrName, attrValue: msg.attrValue },
          { frameId: 0 },
          (resp) => {
            if (chrome.runtime.lastError) {
              chrome.scripting
                .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
                .then(() =>
                  chrome.tabs.sendMessage(tab.id, {
                    type: "HIGHLIGHT_ELEMENT",
                    attrName: msg.attrName,
                    attrValue: msg.attrValue,
                  }, { frameId: 0 })
                )
                .catch(console.error);
              return;
            }
            sendResponse(resp || { ok: true });
          }
        );
      });
      return true;
    }

    // ── From content script → side panel ─────────────────────────────────
    case "SELECTOR_RESULT": {
      (async () => {
        const enrichedPayload = { ...msg.payload, sourceUrl: sender.tab?.url || "" };
        if (tabId !== null) {
          const state   = await getTabState(tabId);
          const results = [enrichedPayload, ...state.results].slice(0, 50);
          await setTabState(tabId, { ...state, results });
        }
        if (panelPort) {
          panelPort.postMessage({ type: "SELECTOR_RESULT", payload: enrichedPayload });
        }
      })();
      break;
    }

    case "PICKER_CANCELLED": {
      (async () => {
        if (tabId !== null) {
          await setTabState(tabId, { active: false });
        }
        if (panelPort) {
          panelPort.postMessage({ type: "PICKER_CANCELLED" });
        }
      })();
      break;
    }

    case "START_CRAWL": {
      startCrawl(msg.urls || [], msg.options || {});
      sendResponse({ ok: true });
      return true;
    }

    case "STOP_CRAWL": {
      stopCrawl();
      sendResponse({ ok: true });
      return true;
    }

    case "START_LIVE_SCAN": {
      getCurrentTab().then(async (tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab" });
        const res = await startLiveScan(msg.attrName, tab.id);
        sendResponse(res);
      });
      return true;
    }

    case "STOP_LIVE_SCAN": {
      stopLiveScan().then(() => sendResponse({ ok: true }));
      return true;
    }

    case "GET_LIVE_SCAN_STATE": {
      sendResponse({ ok: true, state: _liveScanPayload() });
      return true;
    }

    case "CLEAR_LIVE_SCAN": {
      (async () => {
        await stopLiveScan();
        liveScan.entries      = new Map();
        liveScan.urlsSeen     = new Set();
        liveScan.pagesScanned = 0;
        liveScan.currentUrl   = null;
        await chrome.storage.session.remove(LIVE_SCAN_KEY);
        _sendToPanel({ type: "LIVE_SCAN_STATE", payload: _liveScanPayload() });
        sendResponse({ ok: true });
      })();
      return true;
    }

    case "START_LIVE_HARVEST": {
      getCurrentTab().then(async (tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab" });
        const res = await startLiveHarvest(tab.id);
        sendResponse(res);
      });
      return true;
    }

    case "STOP_LIVE_HARVEST": {
      stopLiveHarvest().then(() => sendResponse({ ok: true }));
      return true;
    }

    case "CLEAR_LIVE_HARVEST": {
      clearLiveHarvest().then(() => sendResponse({ ok: true }));
      return true;
    }

    case "GET_CRAWL_RESULTS": {
      chrome.storage.session.get(["crawlState", "crawlResults"], (data) => {
        sendResponse({
          ok:      true,
          state:   data.crawlState   || null,
          results: data.crawlResults || null,
        });
      });
      return true;
    }

    default:
      break;
  }
});

// ─── Sync picker state when the active tab changes ───────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!panelPort) return;
  const state = await getTabState(tabId);
  panelPort.postMessage({ type: "TAB_STATE", payload: state });
});

// ─── Clean up state when a tab is closed ─────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  deleteTabState(tabId);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentTab() {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => tabs[0] || null);
}
