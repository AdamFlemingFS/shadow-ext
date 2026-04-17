"use strict";

// ─── CTA keyword list ────────────────────────────────────────────────────────
// Used in both scoring and naming. Keep lower-case for case-insensitive match.

const CRAWL_CTA_KEYWORDS = [
  "checkout", "buy now", "buy", "add to cart", "add to bag",
  "sign up", "signup", "sign-up", "subscribe", "submit",
  "continue", "proceed", "pay now", "pay", "book now", "book",
  "reserve", "register", "get started", "start free", "try free",
  "free trial", "download", "install", "claim", "redeem",
  "upgrade", "purchase", "place order", "confirm", "apply",
  "enroll", "join now", "join", "next", "complete order",
];

// ─── Naming rules ─────────────────────────────────────────────────────────────
// Evaluated in order; first match wins. An SE can prepend site-specific entries:
//   CRAWL_NAMING_RULES.unshift({ match: e => /pdp/.test(e.fullstorySelector),
//                                 name:  e => `PDP — ${e.attrValue}` });

const CRAWL_NAMING_RULES = [
  // example slot — empty by default; add site-specific rules here
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _toTitleCase(str) {
  return str
    .replace(/[-_\/]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 60);
}

function _ctaMatch(entry) {
  const text  = (entry.textContent || "").toLowerCase();
  const label = (entry.ariaLabel   || "").toLowerCase();
  const combined = `${text} ${label}`;
  return CRAWL_CTA_KEYWORDS.some((kw) => combined.includes(kw));
}

function _normaliseTag(entry) {
  return (entry.tag || entry.tagName || "").toLowerCase();
}

// ─── Scorer ───────────────────────────────────────────────────────────────────
// Returns { score: number 0-100, reasons: string[] }.
// Deliberately structured as data so an AI layer can replace or augment it.

function scoreEntry(entry) {
  let score = 0;
  const reasons = [];

  // +30  CTA keyword match
  if (_ctaMatch(entry)) {
    score += 30;
    reasons.push("CTA keyword");
  }

  // +20  interactive element type
  const tag  = _normaliseTag(entry);
  const role = (entry.role || "").toLowerCase();
  const isInteractive =
    tag === "button" ||
    tag === "a" ||
    (tag === "input" && (entry.inputType === "submit" || entry.inputType === "button")) ||
    role === "button";
  if (isInteractive) {
    score += 20;
    reasons.push("interactive element");
  }

  // +15  inside or is a form
  if (entry.inForm) {
    score += 15;
    reasons.push("inside form");
  }

  // +10  appears on 3+ pages
  if ((entry.seenOn || []).length >= 3) {
    score += 10;
    reasons.push("sitewide element");
  }

  // +10  large bounding area (2 000 px² = roughly a 50×40 button)
  if ((entry.boundingArea || 0) > 2000) {
    score += 10;
    reasons.push("large element");
  }

  // +10  above the fold on at least one page
  if (entry.aboveFold) {
    score += 10;
    reasons.push("above fold");
  }

  // +10  test-id / qa / cy style attribute anchor
  const sel = entry.fullstorySelector || "";
  if (/data-(testid|test-id|qa|cy|test|automation|e2e)/.test(sel)) {
    score += 10;
    reasons.push("test-id anchor");
  }

  // −20  empty component: no text, no label, tiny area
  if (!entry.textContent && !entry.ariaLabel && (entry.boundingArea || 0) < 400) {
    score -= 20;
    reasons.push("empty component");
  }

  // −15  low-specificity selector: tag-only or single bare class with no qualifier
  if (sel && !sel.includes("[") && !sel.includes("#") && !sel.includes(" ")) {
    // Matches "button", "div", ".my-class" — all low specificity
    if (/^[a-z][a-z0-9-]*$/.test(sel) || /^\.[a-z]/.test(sel)) {
      score -= 15;
      reasons.push("low-specificity selector");
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ─── Deduper ──────────────────────────────────────────────────────────────────
// Merges entries with the same fullstorySelector across pages.
// Returns a flat array of merged entries (source URL info in seenOn[]).

function dedupeAndMerge(entries) {
  const map = new Map(); // fullstorySelector → merged entry

  for (const entry of entries) {
    const key = entry.fullstorySelector;
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        ...entry,
        seenOn: entry.sourceUrl ? [entry.sourceUrl] : [],
        count:  entry.count || 1,
      });
    } else {
      const existing = map.get(key);

      // Accumulate page visits
      if (entry.sourceUrl && !existing.seenOn.includes(entry.sourceUrl)) {
        existing.seenOn.push(entry.sourceUrl);
      }
      existing.count += (entry.count || 1);

      // Keep richest metadata
      if ((entry.ariaLabel || "").length > (existing.ariaLabel || "").length) {
        existing.ariaLabel = entry.ariaLabel;
      }
      if ((entry.textContent || "").length > (existing.textContent || "").length) {
        existing.textContent = entry.textContent;
      }
      if ((entry.boundingArea || 0) > (existing.boundingArea || 0)) {
        existing.boundingArea = entry.boundingArea;
        existing.aboveFold    = entry.aboveFold;
      }
    }
  }

  return Array.from(map.values());
}

// ─── Auto-namer ───────────────────────────────────────────────────────────────
// Priority: custom rules → aria-label → visible text → attr value → tag+role.
// Disambiguates collisions by appending (2), (3) …

function autoName(entry, existingNames) {
  existingNames = existingNames || new Set();
  let name = "";

  // 1. Site-specific rules
  for (const rule of CRAWL_NAMING_RULES) {
    if (rule.match(entry)) {
      name = rule.name(entry);
      break;
    }
  }

  // 2. aria-label
  if (!name && entry.ariaLabel) {
    name = _toTitleCase(entry.ariaLabel);
  }

  // 3. Visible text (interactive elements only)
  const tag = _normaliseTag(entry);
  if (!name && entry.textContent) {
    const interactive = ["button", "a", "input", "label", "summary"];
    if (interactive.includes(tag) || (entry.role || "").toLowerCase() === "button") {
      name = _toTitleCase(entry.textContent.slice(0, 60));
    }
  }

  // 4. Attribute value (e.g. data-testid="checkout-submit" → "Checkout Submit")
  if (!name && entry.attrValue) {
    name = _toTitleCase(entry.attrValue);
  }

  // 5. Tag + role fallback
  if (!name) {
    const roleStr = entry.role ? ` [${entry.role}]` : "";
    name = `${_toTitleCase(tag || "element")}${roleStr}`;
  }

  // Disambiguate
  if (existingNames.has(name)) {
    let i = 2;
    while (existingNames.has(`${name} (${i})`)) i++;
    name = `${name} (${i})`;
  }

  existingNames.add(name);
  return name;
}

// ─── Full crawl processor ─────────────────────────────────────────────────────
// Accepts the flat array of all attrResults + interactiveCandidates from all
// crawled pages, merges, scores, names, and splits into two sorted arrays.

function processCrawlResults(allEntries) {
  const merged       = dedupeAndMerge(allEntries);
  const existingNames = new Set();

  const scored = merged.map((entry) => {
    const { score, reasons } = scoreEntry(entry);
    const name = autoName(entry, existingNames);
    return { ...entry, score, reasons, name };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    attributeFinds:       scored.filter((e) => e.source === "attribute"),
    interactiveCandidates: scored.filter((e) => e.source === "interactive"),
  };
}
