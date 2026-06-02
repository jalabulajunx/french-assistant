// Content Script for French Assistant

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
      console.warn("French Assistant content script: Cannot read iframe contents (cross-origin or blocked):", e);
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
  const isBlock = ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "section", "article"].includes(tagName);
  return parts.join(isBlock ? "\n" : " ");
}

// Helper to get text selection from main page or any same-origin iframe
function getSelectedText() {
  let selected = window.getSelection().toString().trim();
  if (selected) return selected;
  
  // Check iframes
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

// --- Highlight & scroll to word ---

let activeHighlights = [];

function clearHighlights() {
  activeHighlights.forEach(el => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize(); // merge adjacent text nodes
    }
  });
  activeHighlights = [];
}

/**
 * Walk text nodes inside a root, find the French word/phrase, wrap first
 * occurrence in a <mark> and scroll to it.  Searches iframes too.
 */
function highlightAndScroll(word) {
  clearHighlights();
  const found = searchAndMark(document.body, word);
  if (!found) {
    // Try inside same-origin iframes
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

  // Split and wrap
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

// Listen for messages from the service worker or side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ success: true });
    return false; // Close channel immediately for synchronous response
  } else if (request.action === "extract_text") {
    const textContent = extractText(document.body);
    sendResponse({ text: textContent });
  } else if (request.action === "get_selected_text") {
    const selection = getSelectedText();
    sendResponse({ text: selection });
  } else if (request.action === "highlight_word") {
    highlightAndScroll(request.word);
    sendResponse({ success: true });
  } else if (request.action === "clear_highlights") {
    clearHighlights();
    sendResponse({ success: true });
  }
  return true; // Keep message channel open for async response
});
