// Service Worker (Background Script) for French Assistant

import { getAudio, saveAudio } from '../lib/audio_cache.js';
import { analyzeText, analyzeTextChunked, analyzeWithVisionChunked, analyzePdfChunked } from './gemini_client.js';
import { synthesizeSpeech } from './elevenlabs_client.js';

// Open options page on installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ─── Vision Mode: screenshot accumulation ───
let capturedScreenshots = [];    // base64 data URLs
let visionModeEnabled = false;
let captureTimer = null;
const MAX_SCREENSHOTS = 20;      // cap to keep Gemini payload reasonable

async function captureScreenshot() {
  if (!visionModeEnabled) return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'jpeg',
      quality: 60  // lower quality = smaller payload, still readable
    });
    if (capturedScreenshots.length >= MAX_SCREENSHOTS) {
      // Drop oldest to make room
      capturedScreenshots.shift();
    }
    capturedScreenshots.push(dataUrl);
    console.log(`Vision: captured screenshot ${capturedScreenshots.length}/${MAX_SCREENSHOTS}`);
  } catch (e) {
    console.warn('Vision: screenshot capture failed:', e.message);
  }
}

// Helper to get active tab
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Helper to ensure content script is injected
async function ensureContentScriptActive(tabId) {
  try {
    // Send a test message to see if content script responds
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch (error) {
    console.log("Content script not active, injecting dynamically...", error);
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ["scripts/content_script.js"]
    });
    // Wait a brief moment for injection to complete
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyze_page') {
    handlePageAnalysis(sendResponse);
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'lookup_selected') {
    handleWordLookup(sendResponse);
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'get_audio') {
    handleGetAudio(message.text, message.voiceType, sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.action === 'highlight_word' || message.action === 'clear_highlights') {
    forwardToContentScript(message, sendResponse);
    return true;
  }

  if (message.action === 'set_vision_mode') {
    visionModeEnabled = message.enabled;
    if (!visionModeEnabled) {
      capturedScreenshots = [];
    } else {
      // Capture initial screenshot immediately
      captureScreenshot();
    }
    console.log(`Vision mode: ${visionModeEnabled ? 'ON' : 'OFF'}`);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'vision_scroll_tick') {
    // Content script detected a scroll — capture a screenshot
    if (visionModeEnabled) {
      captureScreenshot().then(() => {
        sendResponse({ success: true, count: capturedScreenshots.length });
      });
      return true;
    }
    sendResponse({ success: true, count: 0 });
    return true;
  }

  if (message.action === 'get_vision_status') {
    sendResponse({
      enabled: visionModeEnabled,
      screenshotCount: capturedScreenshots.length
    });
    return true;
  }

  if (message.action === 'auto_scroll_progress') {
    // Forward progress to all extension views (sidepanel)
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }
});

// Forward a message to the content script on the active tab
async function forwardToContentScript(message, sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      sendResponse({ success: false, error: 'No active tab' });
      return;
    }
    await ensureContentScriptActive(tab.id);
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      sendResponse(response || { success: true });
    });
  } catch (e) {
    console.error('Forward to content script failed:', e);
    sendResponse({ success: false, error: e.message });
  }
}

// Detect if a URL points to a PDF
function isPdfUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

// Detect if the active tab is showing a PDF (Chrome's built-in viewer or embedded)
async function detectPdfInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        // Check for Chrome's PDF viewer embed
        const embed = document.querySelector('embed[type="application/pdf"]');
        if (embed) return embed.src || window.location.href;
        // Check for object embeds
        const obj = document.querySelector('object[type="application/pdf"]');
        if (obj) return obj.data;
        // Check for iframe pointing to a PDF
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          if (iframe.src && iframe.src.toLowerCase().endsWith('.pdf')) return iframe.src;
        }
        return null;
      }
    });
    for (const r of results) {
      if (r.result) return r.result;
    }
  } catch (e) {
    console.warn('PDF detection in tab failed:', e.message);
  }
  return null;
}

// Estimate PDF page count from file size (rough heuristic: ~5KB per page for text-heavy,
// ~50KB per page for image-heavy). We use a middle estimate of ~20KB/page.
// This is just for chunking — not critical to be exact.
function estimatePageCount(byteSize) {
  const estimate = Math.max(1, Math.round(byteSize / 20000));
  return estimate;
}

// Handle full page text extraction and Gemini analysis
async function handlePageAnalysis(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active tab found.');
    }

    // Broadcast progress updates to sidepanel
    function broadcastProgress(message) {
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    // Get API key and model from storage
    const settings = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
    const apiKey = settings.geminiApiKey;
    const modelName = settings.geminiModel || 'gemini-2.5-flash-lite';

    if (!apiKey) {
      throw new Error('Gemini API Key is missing. Open extension options to set it.');
    }

    // ─── Check if this is a PDF ───
    let pdfUrl = isPdfUrl(tab.url) ? tab.url : null;
    if (!pdfUrl) {
      // Check for embedded PDFs in the page
      pdfUrl = await detectPdfInTab(tab.id);
    }

    if (pdfUrl) {
      // ─── PDF mode: fetch PDF bytes and send directly to Gemini ───
      console.log(`PDF detected: ${pdfUrl}`);
      broadcastProgress({
        action: 'analysis_progress',
        stage: 'analyzing',
        detail: 'Downloading PDF...'
      });

      const pdfResponse = await fetch(pdfUrl);
      if (!pdfResponse.ok) {
        throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
      }
      const pdfBuffer = await pdfResponse.arrayBuffer();
      const totalPages = estimatePageCount(pdfBuffer.byteLength);
      console.log(`PDF downloaded: ${(pdfBuffer.byteLength / 1024).toFixed(0)}KB, ~${totalPages} pages estimated`);

      broadcastProgress({
        action: 'analysis_progress',
        stage: 'analyzing',
        detail: `Analyzing PDF (~${totalPages} pages)...`
      });

      const data = await analyzePdfChunked(pdfBuffer, totalPages, apiKey, modelName, (chunkIdx, totalChunks) => {
        broadcastProgress({
          action: 'analysis_progress',
          stage: 'analyzing',
          detail: `Analyzing PDF batch ${chunkIdx + 1} of ${totalChunks}...`
        });
      });

      sendResponse({ success: true, data });
      return;
    }

    // ─── Not a PDF — proceed with normal page analysis ───
    await ensureContentScriptActive(tab.id);

    // Clear previous vision screenshots for a fresh capture
    if (visionModeEnabled) {
      capturedScreenshots = [];
    }

    // Auto-scroll the page to capture all content
    console.log('Starting auto-scroll...');
    const scrollResult = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: 'auto_scroll' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

    if (!scrollResult || !scrollResult.success) {
      throw new Error(scrollResult?.error || 'Auto-scroll failed.');
    }

    console.log(`Auto-scroll complete: ${scrollResult.steps} steps, ${scrollResult.paragraphs} paragraphs`);

    let data;
    if (visionModeEnabled && capturedScreenshots.length > 0) {
      // ─── Vision mode: screenshots only, no DOM text ───
      console.log(`Vision analysis: ${capturedScreenshots.length} screenshots captured`);
      data = await analyzeWithVisionChunked(capturedScreenshots, apiKey, modelName, (chunkIdx, totalChunks) => {
        broadcastProgress({
          action: 'analysis_progress',
          stage: 'analyzing',
          detail: `Analyzing screenshot batch ${chunkIdx + 1} of ${totalChunks}...`
        });
      });
    } else {
      // ─── Text mode: DOM-extracted paragraphs, chunked ───
      const allText = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'get_accumulated_text' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.text && response.text.trim()) {
            console.log(`Analyzing ${response.paragraphCount} accumulated paragraphs`);
            resolve(response.text);
          } else {
            reject(new Error('No text content found on this page.'));
          }
        });
      });

      data = await analyzeTextChunked(allText, apiKey, modelName, (chunkIdx, totalChunks) => {
        broadcastProgress({
          action: 'analysis_progress',
          stage: 'analyzing',
          detail: `Analyzing text batch ${chunkIdx + 1} of ${totalChunks}...`
        });
      });
    }
    sendResponse({ success: true, data });
  } catch (error) {
    console.error('Analysis error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// Handle selected text lookup and Gemini analysis
async function handleWordLookup(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active tab found.');
    }

    // Query selections from all frames using executeScript
    const executionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        return window.getSelection() ? window.getSelection().toString().trim() : "";
      }
    });

    if (!executionResults || executionResults.length === 0) {
      throw new Error('No selection found.');
    }

    // Find the first frame that returned a non-empty selection
    let selectedText = "";
    for (const frameResult of executionResults) {
      if (frameResult.result && frameResult.result.trim()) {
        selectedText = frameResult.result.trim();
        break;
      }
    }

    if (!selectedText) {
      throw new Error('No text selected. Please highlight some French text first.');
    }

    // Get API key and model from storage
    const settings = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
    const apiKey = settings.geminiApiKey;
    const modelName = settings.geminiModel || 'gemini-2.5-flash-lite';
    
    if (!apiKey) {
      throw new Error('Gemini API Key is missing. Open extension options to set it.');
    }

    const data = await analyzeText(selectedText, 'word_lookup', apiKey, modelName);
    sendResponse({ success: true, data });
  } catch (error) {
    console.error('Word lookup error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// Handle speech synthesis via ElevenLabs with caching
async function handleGetAudio(text, voiceType, sendResponse) {
  try {
    // Get voice and api settings from storage
    const settings = await chrome.storage.sync.get([
      'elevenlabsApiKey',
      'elevenlabsFrenchVoiceId',
      'elevenlabsEnglishVoiceId'
    ]);

    const apiKey = settings.elevenlabsApiKey;
    if (!apiKey) {
      throw new Error('ElevenLabs API Key is missing. Open extension options to set it.');
    }

    // Assign appropriate voice ID
    let voiceId = '';
    if (voiceType === 'french') {
      // Default: Rachel — multilingual_v2 model speaks French with any voice
      voiceId = settings.elevenlabsFrenchVoiceId || '21m00Tcm4TlvDq8ikWAM';
    } else if (voiceType === 'english') {
      // Default: Rachel (English Female) - "21m00Tcm4TlvDq8ikWAM"
      voiceId = settings.elevenlabsEnglishVoiceId || '21m00Tcm4TlvDq8ikWAM';
    } else {
      throw new Error(`Unsupported voice type: ${voiceType}`);
    }

    // Check IndexedDB cache first
    const cachedBlob = await getAudio(text, voiceId);
    if (cachedBlob) {
      console.log(`Audio Cache Hit for "${text}" with voice ${voiceId}`);
      const arrayBuffer = await cachedBlob.arrayBuffer();
      sendResponse({ success: true, audioData: Array.from(new Uint8Array(arrayBuffer)), fromCache: true });
      return;
    }

    console.log(`Audio Cache Miss. Fetching from ElevenLabs for "${text}"...`);
    const blob = await synthesizeSpeech(text, voiceId, apiKey);

    // Save to cache asynchronously
    saveAudio(text, voiceId, blob).catch(err => {
      console.error('Failed to cache audio:', err);
    });

    const arrayBuffer = await blob.arrayBuffer();
    sendResponse({ success: true, audioData: Array.from(new Uint8Array(arrayBuffer)), fromCache: false });
  } catch (error) {
    console.error('Speech synthesis error:', error);
    sendResponse({ success: false, error: error.message });
  }
}
