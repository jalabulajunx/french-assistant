// Service Worker (Background Script) for French Assistant

import { getAudio, saveAudio, getAllKeys, getAudioByKey, saveAudioByKey } from '../lib/audio_cache.js';
import { getValidToken, fullSync, pushVocabulary, pushAudioFile } from '../lib/drive_sync.js';
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

  if (message.action === 'drive_sync') {
    handleDriveSync(sendResponse);
    return true;
  }

  if (message.action === 'drive_push_vocabulary') {
    handleDrivePushVocabulary(message.words, sendResponse);
    return true;
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

    // Save to cache asynchronously, then push to Drive if configured
    saveAudio(text, voiceId, blob).then(() => {
      backgroundDrivePushAudio(text, voiceId, blob);
    }).catch(err => {
      console.error('Failed to cache audio:', err);
    });

    const arrayBuffer = await blob.arrayBuffer();
    sendResponse({ success: true, audioData: Array.from(new Uint8Array(arrayBuffer)), fromCache: false });
  } catch (error) {
    console.error('Speech synthesis error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// ─── Google Drive Sync ───

/**
 * Get Drive sync settings.
 * @returns {Promise<{clientId: string, folderId: string}|null>}
 */
async function getDriveSyncSettings() {
  const settings = await chrome.storage.sync.get(['driveClientId', 'driveFolderId']);
  if (settings.driveClientId && settings.driveFolderId) {
    return { clientId: settings.driveClientId, folderId: settings.driveFolderId };
  }
  return null;
}

/**
 * Full two-way sync triggered by user or on startup.
 */
async function handleDriveSync(sendResponse) {
  try {
    const driveSettings = await getDriveSyncSettings();
    if (!driveSettings) {
      throw new Error('Google Drive sync is not configured. Set it up in Settings.');
    }

    const token = await getValidToken(driveSettings.clientId);
    if (!token) {
      throw new Error('Google Drive authentication expired. Please re-authenticate in Settings.');
    }

    function broadcastProgress(detail) {
      chrome.runtime.sendMessage({ action: 'sync_progress', detail }).catch(() => {});
    }

    const stats = await fullSync(driveSettings.folderId, token, {
      getLocalWords: async () => {
        const result = await chrome.storage.local.get(['analyzedWords']);
        return result.analyzedWords || [];
      },
      setLocalWords: async (words) => {
        await chrome.storage.local.set({ analyzedWords: words });
      },
      getLocalAudio: async (key) => {
        return await getAudioByKey(key);
      },
      saveLocalAudio: async (key, blob) => {
        await saveAudioByKey(key, blob);
      },
      getAllLocalAudioKeys: async () => {
        return await getAllKeys();
      },
      onProgress: broadcastProgress
    });

    sendResponse({ success: true, stats });
  } catch (error) {
    console.error('Drive sync error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Push vocabulary to Drive after analysis (called from sidepanel).
 */
async function handleDrivePushVocabulary(words, sendResponse) {
  try {
    const driveSettings = await getDriveSyncSettings();
    if (!driveSettings) {
      sendResponse({ success: false, error: 'Drive not configured' });
      return;
    }

    const token = await getValidToken(driveSettings.clientId);
    if (!token) {
      sendResponse({ success: false, error: 'Drive auth expired' });
      return;
    }

    await pushVocabulary(words, driveSettings.folderId, token);
    sendResponse({ success: true });
  } catch (error) {
    console.error('Drive push vocabulary error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Background push of a single audio file to Drive (fire-and-forget).
 */
async function backgroundDrivePushAudio(text, voiceId, blob) {
  try {
    const driveSettings = await getDriveSyncSettings();
    if (!driveSettings) return;

    const token = await getValidToken(driveSettings.clientId);
    if (!token) return;

    const audioFolderId = await findOrCreateAudioFolder(driveSettings.folderId, token);
    const key = `${text.trim().toLowerCase()}_${voiceId}`;
    await pushAudioFile(key, blob, audioFolderId, token);
    console.log(`Drive: pushed audio for "${text}"`);
  } catch (e) {
    // Non-critical — just log it
    console.warn('Drive: background audio push failed:', e.message);
  }
}

/**
 * Find or create the audio subfolder in the user's Drive sync folder.
 */
async function findOrCreateAudioFolder(parentFolderId, token) {
  const DRIVE_API = 'https://www.googleapis.com/drive/v3';
  const AUDIO_FOLDER_NAME = 'french-assistant-audio';

  const query = `name='${AUDIO_FOLDER_NAME}' and '${parentFolderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
  const response = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  const createResponse = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: AUDIO_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    })
  });
  const created = await createResponse.json();
  return created.id;
}
