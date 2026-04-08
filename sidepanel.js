"use strict";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_SAVED   = 20;
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

// Scan refs
const scanAttrInput      = document.getElementById("scan-attr-input");
const btnScan            = document.getElementById("btn-scan");
const btnScanLabel       = document.getElementById("btn-scan-label");
const scanResultsSection = document.getElementById("scan-results-section");
const scanResultsCount   = document.getElementById("scan-results-count");
const scanList           = document.getElementById("scan-list");
const btnClearScan       = document.getElementById("btn-clear-scan");
const scanEmptyEl        = document.getElementById("scan-empty");

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

  tabPanelSel.classList.toggle("tab-active",  tab === "selection");
  tabPanelScan.classList.toggle("tab-active", tab === "scan");
  tabPanelSvd.classList.toggle("tab-active",  tab === "saved");

  // The header "Clear all" button only applies to the Selection tab
  btnClear.style.visibility = tab === "selection" ? "" : "hidden";
}

tabBtnSel.addEventListener("click",   () => switchTab("selection"));
tabBtnScan.addEventListener("click",  () => switchTab("scan"));
tabBtnSaved.addEventListener("click", () => switchTab("saved"));

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

// ─── Page Scanner ─────────────────────────────────────────────────────────────

let scanSaveRefreshers = new Set();

btnScan.addEventListener("click", () => {
  const attrName = scanAttrInput.value.trim();
  if (!attrName) return;

  btnScan.disabled = true;
  btnScanLabel.textContent = "Scanning…";

  chrome.runtime.sendMessage({ type: "SCAN_PAGE", attrName }, (resp) => {
    btnScan.disabled = false;
    btnScanLabel.textContent = "Scan Page";

    if (chrome.runtime.lastError || !resp || !resp.ok) {
      renderScanResults([], attrName);
      return;
    }
    renderScanResults(resp.results || [], attrName);
  });
});

btnClearScan.addEventListener("click", () => {
  scanSaveRefreshers.clear();
  scanList.innerHTML = "";
  scanResultsSection.hidden = true;
  scanEmptyEl.style.display = "";
});

function renderScanResults(results, attrName) {
  scanSaveRefreshers.clear();
  scanList.innerHTML = "";

  const n = results.length;
  scanResultsCount.textContent = n === 0
    ? `No [${attrName}] found`
    : `${n} unique value${n === 1 ? "" : "s"} found`;

  scanResultsSection.hidden = false;
  scanEmptyEl.style.display = "none";

  results.forEach((item) => {
    const row = document.createElement("div");
    row.className = "scan-row";

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
      addToSaved(item.fullstorySelector);
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
    scanList.appendChild(row);
  });
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

  // FullStory selector
  card.querySelector(".fs-value").textContent = result.fullstorySelector || "";

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
      const text  = field === "fs" ? result.fullstorySelector : result.debugPath;
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
    addToSaved(result.fullstorySelector || "");
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

  nameInput.value     = item.name || "";
  selectorInput.value = item.selector || "";

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

function addToSaved(fsSelector) {
  if (savedItems.length >= MAX_SAVED) return false;
  const id   = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const item = { id, name: "", selector: fsSelector, done: false, savedAt: Date.now() };
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
  savedCountEl.textContent = `${count} / ${MAX_SAVED}`;

  // Clear done button
  btnClearDone.disabled  = doneCount === 0;
  btnClearDone.textContent = doneCount > 0 ? `Clear done (${doneCount})` : "Clear done";

  // Refresh scan row save buttons whenever saved list capacity changes
  scanSaveRefreshers.forEach((fn) => fn());
}

// ─── Clear done (Tab 2) ───────────────────────────────────────────────────────

btnClearDone.addEventListener("click", () => {
  savedItems = savedItems.filter((i) => !i.done);
  persistSaved();
  renderSavedList();
  updateSavedMeta();
  // Clearing done items may free space — refresh result-card save buttons
  saveButtonRefreshers.forEach((fn) => fn());
});

// ─── Init ─────────────────────────────────────────────────────────────────────

connectPort();
initSaved();

chrome.runtime.sendMessage({ type: "GET_TAB_STATE" }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state) applyTabState(state);
});
