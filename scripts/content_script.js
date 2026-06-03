// Content Script for French Assistant

// ─── Accumulated text buffer ───
// The MHE reader virtualizes iframe content — only the visible portion exists
// in the DOM at any time. We continuously capture text as the user scrolls,
// accumulating everything seen so far so "Analyze Page" gets the full picture.

const seenParagraphs = new Set();  // dedup: store normalized strings we've already captured
let accumulatedParagraphs = [];    // ordered list of unique paragraphs seen so far
let observersAttached = false;

// Helper to extract text from a node recursively
function extractText(node) {
  if (!node) return "";

  const tagName = node.tagName ? node.tagName.toLowerCase() : "";

  // Handle same-origin iframes recursively
  if (tagName === "iframe") {
    try {
      const doc = node.contentDocument || node.contentWindow.document;
      if (doc && doc.body) {
        return extractText(doc.body);
      }
    } catch (e) {
      // cross-origin — silently skip
    }
    return "";
  }

  // Skip script, style, and meta elements
  if (["script", "style", "noscript", "head", "meta", "link", "svg", "canvas", "button", "input", "select", "textarea"].includes(tagName)) {
    return "";
  }

  // Skip elements explicitly marked as English
  if (node.getAttribute && node.getAttribute("lang")) {
    const lang = node.getAttribute("lang").toLowerCase();
    if (lang.startsWith("en")) {
      return "";
    }
  }

  // If it's a text node, return its content
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue.trim();
  }

  // Iterate children
  let parts = [];
  for (let child of node.childNodes) {
    const childText = extractText(child);
    if (childText) {
      parts.push(childText);
    }
  }

  // Use newlines for block elements, spaces for inline
  const isBlock = ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "td", "th",
                   "section", "article", "figcaption", "caption", "blockquote", "dt", "dd"].includes(tagName);
  return parts.join(isBlock ? "\n" : " ");
}

/**
 * Harvest text from a root element into the accumulated buffer.
 * Splits into paragraphs and deduplicates against what we've already seen.
 */
function harvestText(root) {
  if (!root) return;
  const rawText = extractText(root);
  if (!rawText) return;

  const paragraphs = rawText.split("\n").map(p => p.trim()).filter(p => p.length > 0);
  let added = 0;
  for (const para of paragraphs) {
    const key = para.toLowerCase();
    if (!seenParagraphs.has(key)) {
      seenParagraphs.add(key);
      accumulatedParagraphs.push(para);
      added++;
    }
  }
  if (added > 0) {
    console.log(`French Assistant: harvested ${added} new paragraph(s), total: ${accumulatedParagraphs.length}`);
  }
}

/**
 * Scan the current visible DOM — main page + any accessible iframes.
 */
function harvestCurrentView() {
  // Harvest from main document
  if (document.body) {
    harvestText(document.body);
  }
  // Harvest from same-origin iframes
  const iframes = document.querySelectorAll("iframe");
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (doc && doc.body) {
        harvestText(doc.body);
      }
    } catch (e) { /* cross-origin */ }
  }
}

/**
 * Attach scroll listeners and MutationObservers to capture content
 * as the user scrolls through virtualized content.
 */
function attachObservers() {
  if (observersAttached) return;
  observersAttached = true;

  // Harvest what's visible right now
  harvestCurrentView();

  // --- Scroll listener on main document ---
  let scrollTimer = null;
  let visionScrollTimer = null;
  document.addEventListener("scroll", () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => harvestCurrentView(), 300);

    // Notify service worker for vision screenshot capture (throttled)
    if (visionScrollTimer) clearTimeout(visionScrollTimer);
    visionScrollTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'vision_scroll_tick' }, () => {});
    }, 800);
  }, { passive: true, capture: true });

  // --- MutationObserver on main body ---
  if (document.body) {
    const bodyObserver = new MutationObserver(() => {
      harvestCurrentView();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // --- Attach to same-origin iframes ---
  function observeIframe(iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc || !doc.body) return;

      // Scroll inside iframe
      let iframeScrollTimer = null;
      let iframeVisionTimer = null;
      (doc.defaultView || iframe.contentWindow).addEventListener("scroll", () => {
        if (iframeScrollTimer) clearTimeout(iframeScrollTimer);
        iframeScrollTimer = setTimeout(() => harvestText(doc.body), 300);

        if (iframeVisionTimer) clearTimeout(iframeVisionTimer);
        iframeVisionTimer = setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'vision_scroll_tick' }, () => {});
        }, 800);
      }, { passive: true, capture: true });

      // DOM mutations inside iframe
      const iframeObserver = new MutationObserver(() => {
        harvestText(doc.body);
      });
      iframeObserver.observe(doc.body, { childList: true, subtree: true });

      // Initial harvest
      harvestText(doc.body);
    } catch (e) { /* cross-origin */ }
  }

  // Observe existing iframes
  document.querySelectorAll("iframe").forEach(observeIframe);

  // Watch for new iframes being added
  const iframeWatcher = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          if (node.tagName && node.tagName.toLowerCase() === "iframe") {
            // Wait for iframe to load
            node.addEventListener("load", () => observeIframe(node));
            observeIframe(node); // try immediately too
          }
          // Check children for iframes
          node.querySelectorAll && node.querySelectorAll("iframe").forEach(iframe => {
            iframe.addEventListener("load", () => observeIframe(iframe));
            observeIframe(iframe);
          });
        }
      }
    }
  });
  iframeWatcher.observe(document.documentElement, { childList: true, subtree: true });

  console.log("French Assistant: scroll capture & mutation observers attached");
}

// Start observing as soon as the content script loads
attachObservers();

// ─── Auto-scroll engine ───
// Programmatically scrolls the page (or the main iframe) top-to-bottom,
// harvesting text and triggering screenshot captures at each step.

let autoScrolling = false;

async function autoScrollAndCapture() {
  if (autoScrolling) return { success: false, error: 'Auto-scroll already running' };
  autoScrolling = true;

  // Reset accumulated text for a fresh capture
  seenParagraphs.clear();
  accumulatedParagraphs = [];

  try {
    // Find the best scrollable target: the main iframe's inner document, or the page itself
    let scrollTarget = null;   // the element/window to scroll
    let scrollBody = null;     // the body to measure scroll height

    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && doc.body && doc.body.scrollHeight > 500) {
          scrollTarget = doc.defaultView || iframe.contentWindow;
          scrollBody = doc.documentElement || doc.body;
          break;
        }
      } catch (e) { /* cross-origin */ }
    }

    // Fallback to main page
    if (!scrollTarget) {
      scrollTarget = window;
      scrollBody = document.documentElement;
    }

    // Scroll to top first
    scrollTarget.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(400);

    const viewportHeight = scrollTarget === window
      ? window.innerHeight
      : (scrollBody.clientHeight || 600);
    const stepSize = Math.floor(viewportHeight * 0.75); // 75% overlap for thorough capture
    let currentPos = 0;
    let stepCount = 0;
    const maxSteps = 100; // safety limit

    while (stepCount < maxSteps) {
      // Harvest text at current position
      harvestCurrentView();

      // Notify service worker to capture screenshot (if vision mode is on)
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'vision_scroll_tick' }, () => resolve());
      });

      // Report progress
      chrome.runtime.sendMessage({
        action: 'auto_scroll_progress',
        step: stepCount + 1,
        paragraphs: accumulatedParagraphs.length,
        position: currentPos,
        totalHeight: scrollBody.scrollHeight
      }, () => {});

      // Scroll down
      const prevPos = scrollBody.scrollTop;
      scrollTarget.scrollBy({ top: stepSize, behavior: 'instant' });
      await sleep(400); // wait for content render after instant scroll

      // Wait a bit more for lazy/virtualized content to render
      await sleep(300);

      // Check if we've reached the bottom
      const newPos = scrollBody.scrollTop;
      if (newPos <= prevPos && stepCount > 0) {
        // Didn't move — we're at the bottom
        break;
      }
      currentPos = newPos;
      stepCount++;
    }

    // Final harvest at the bottom
    harvestCurrentView();
    await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'vision_scroll_tick' }, () => resolve());
    });

    autoScrolling = false;
    console.log(`French Assistant: auto-scroll complete. ${stepCount + 1} steps, ${accumulatedParagraphs.length} paragraphs captured.`);
    return {
      success: true,
      steps: stepCount + 1,
      paragraphs: accumulatedParagraphs.length
    };

  } catch (e) {
    autoScrolling = false;
    console.error('Auto-scroll error:', e);
    return { success: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Text selection helper ───

function getSelectedText() {
  let selected = window.getSelection().toString().trim();
  if (selected) return selected;

  const iframes = document.querySelectorAll("iframe");
  for (let iframe of iframes) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (doc) {
        selected = doc.getSelection().toString().trim();
        if (selected) return selected;
      }
    } catch (e) {
      // Ignore cross-origin errors
    }
  }
  return "";
}

// ─── Highlight & scroll to word ───

let activeHighlights = [];

function clearHighlights() {
  activeHighlights.forEach(el => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    }
  });
  activeHighlights = [];
}

function highlightAndScroll(word) {
  clearHighlights();
  const found = searchAndMark(document.body, word);
  if (!found) {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && doc.body && searchAndMark(doc.body, word)) break;
      } catch (e) { /* cross-origin */ }
    }
  }
}

function searchAndMark(root, word) {
  const lower = word.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;
      if (node.nodeValue && node.nodeValue.toLowerCase().includes(lower)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    }
  });

  const textNode = walker.nextNode();
  if (!textNode) return false;

  const idx = textNode.nodeValue.toLowerCase().indexOf(lower);
  if (idx === -1) return false;

  const before = textNode.nodeValue.substring(0, idx);
  const match = textNode.nodeValue.substring(idx, idx + word.length);
  const after = textNode.nodeValue.substring(idx + word.length);

  const mark = document.createElement("mark");
  mark.textContent = match;
  mark.style.cssText = "background:#6366f1;color:#fff;padding:2px 4px;border-radius:3px;scroll-margin:80px;";

  const parent = textNode.parentNode;
  if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling);
  parent.insertBefore(mark, textNode.nextSibling);
  textNode.nodeValue = before;

  activeHighlights.push(mark);
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

// ─── Message handler ───

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ success: true });
    return false;
  } else if (request.action === "extract_text") {
    // Do a final harvest, then return everything accumulated
    harvestCurrentView();
    sendResponse({ text: accumulatedParagraphs.join("\n") });
  } else if (request.action === "get_accumulated_text") {
    // Return the accumulated buffer (used by service worker for analysis)
    harvestCurrentView();
    const numbered = accumulatedParagraphs
      .map((p, i) => `[${i + 1}] ${p}`)
      .join("\n");
    sendResponse({ text: numbered, paragraphCount: accumulatedParagraphs.length });
  } else if (request.action === "get_selected_text") {
    const selection = getSelectedText();
    sendResponse({ text: selection });
  } else if (request.action === "highlight_word") {
    highlightAndScroll(request.word);
    sendResponse({ success: true });
  } else if (request.action === "clear_highlights") {
    clearHighlights();
    sendResponse({ success: true });
  } else if (request.action === "reset_accumulated") {
    seenParagraphs.clear();
    accumulatedParagraphs = [];
    sendResponse({ success: true });
  } else if (request.action === "auto_scroll") {
    autoScrollAndCapture().then(result => sendResponse(result));
    return true; // keep channel open for async
  } else if (request.action === "is_auto_scrolling") {
    sendResponse({ scrolling: autoScrolling });
  }
  return true;
});
