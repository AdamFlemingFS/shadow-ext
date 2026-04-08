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
 */

// tabId → { active: boolean, results: object[] }
const tabState = new Map();

// Long-lived connection from the side panel
let panelPort = null;

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
  getCurrentTab().then((tab) => {
    if (!tab) return;
    const state = tabState.get(tab.id) || { active: false, results: [] };
    port.postMessage({ type: "TAB_STATE", payload: state });
  });
});

// ─── One-shot messages ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    // ── From side panel → content script ─────────────────────────────────
    case "ACTIVATE_PICKER": {
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab" });
        setTabState(tab.id, { active: true });
        chrome.tabs.sendMessage(tab.id, { type: "ACTIVATE_PICKER" }, (resp) => {
          if (chrome.runtime.lastError) {
            // Content script not yet ready — inject it, then retry
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
      // Prefer the tab actually marked active in our state map; fall back to
      // the current active tab so we don't miss the right tab.
      const activeTabEntry = [...tabState.entries()].find(([, s]) => s.active);

      getCurrentTab().then((tab) => {
        const targetTabId = activeTabEntry ? activeTabEntry[0] : tab?.id;
        if (!targetTabId) return sendResponse({ ok: false, error: "No active tab" });

        setTabState(targetTabId, { active: false });

        chrome.tabs.sendMessage(targetTabId, { type: "DEACTIVATE_PICKER" }, (resp) => {
          if (chrome.runtime.lastError) {
            // Content script unreachable — force-clean the page DOM directly.
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
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ active: false, results: [] });
        sendResponse(tabState.get(tab.id) || { active: false, results: [] });
      });
      return true;
    }

    case "CLEAR_RESULTS": {
      getCurrentTab().then((tab) => {
        if (!tab) return;
        setTabState(tab.id, { results: [] });
        sendResponse({ ok: true });
      });
      return true;
    }

    case "DISCOVER_ATTRIBUTES": {
      getCurrentTab().then((tab) => {
        if (!tab) return sendResponse({ ok: false, error: "No active tab", attrs: [] });
        chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_ATTRIBUTES" }, (resp) => {
          if (chrome.runtime.lastError) {
            chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
              .then(() =>
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "DISCOVER_ATTRIBUTES" },
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
        chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE", attrName: msg.attrName }, (resp) => {
          if (chrome.runtime.lastError) {
            // Content script not yet injected — inject it then retry once
            chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
              .then(() =>
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "SCAN_PAGE", attrName: msg.attrName },
                  (r) => sendResponse(r || { ok: false, results: [] })
                )
              )
              .catch((err) => sendResponse({ ok: false, error: String(err), results: [] }));
            return;
          }
          sendResponse(resp || { ok: false, results: [] });
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
          (resp) => {
            if (chrome.runtime.lastError) {
              chrome.scripting
                .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
                .then(() =>
                  chrome.tabs.sendMessage(tab.id, {
                    type: "HIGHLIGHT_ELEMENT",
                    attrName: msg.attrName,
                    attrValue: msg.attrValue,
                  })
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
      if (tabId !== null) {
        const state = tabState.get(tabId) || { active: true, results: [] };
        const results = [msg.payload, ...state.results].slice(0, 50); // cap history
        tabState.set(tabId, { ...state, results });
      }
      if (panelPort) {
        panelPort.postMessage({ type: "SELECTOR_RESULT", payload: msg.payload });
      }
      break;
    }

    case "PICKER_CANCELLED": {
      if (tabId !== null) {
        setTabState(tabId, { active: false });
      }
      if (panelPort) {
        panelPort.postMessage({ type: "PICKER_CANCELLED" });
      }
      break;
    }

    default:
      break;
  }
});

// ─── Sync picker state when the active tab changes ───────────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!panelPort) return;
  const state = tabState.get(tabId) || { active: false, results: [] };
  panelPort.postMessage({ type: "TAB_STATE", payload: state });
});

// ─── Clean up state when a tab is closed ─────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setTabState(tabId, patch) {
  const existing = tabState.get(tabId) || { active: false, results: [] };
  tabState.set(tabId, { ...existing, ...patch });
}

function getCurrentTab() {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => tabs[0] || null);
}
