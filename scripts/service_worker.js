// Service Worker (Background Script) for French Assistant

import { getAudio, saveAudio } from '../lib/audio_cache.js';
import { analyzeText } from './gemini_client.js';
import { synthesizeSpeech } from './elevenlabs_client.js';

// Open options page on installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

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

// Handle full page text extraction and Gemini analysis
async function handlePageAnalysis(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active tab found.');
    }

    // Extract text from all frames using executeScript
    const executionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        function extract(node) {
          if (!node) return "";
          const tagName = node.tagName ? node.tagName.toLowerCase() : "";
          if (tagName === "iframe") return "";
          if (["script", "style", "noscript", "head", "meta", "link", "svg", "canvas", "button", "input", "select", "textarea"].includes(tagName)) {
            return "";
          }
          if (node.nodeType === 3) { // TEXT_NODE
            const parent = node.parentElement;
            if (parent && parent.getAttribute) {
              const lang = parent.getAttribute("lang");
              if (lang && lang.toLowerCase().startsWith("en")) {
                return "";
              }
            }
            return node.nodeValue.trim();
          }
          let parts = [];
          for (let child of node.childNodes) {
            const childText = extract(child);
            if (childText) {
              parts.push(childText);
            }
          }
          const isBlock = ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "section", "article"].includes(tagName);
          return parts.join(isBlock ? "\n" : " ");
        }
        return document.body ? extract(document.body) : "";
      }
    });

    if (!executionResults || executionResults.length === 0) {
      throw new Error('No text content could be extracted from this page. Make sure you are on a valid webpage.');
    }

    // Combine text from all frames
    const allText = executionResults
      .map(r => r.result)
      .filter(text => text && text.trim().length > 0)
      .join("\n\n");

    if (!allText || !allText.trim()) {
      throw new Error('No text content could be extracted from this page. Make sure you are on a valid webpage.');
    }

    // Get API key and model from storage
    const settings = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
    const apiKey = settings.geminiApiKey;
    const modelName = settings.geminiModel || 'gemini-2.5-flash-lite';
    
    if (!apiKey) {
      throw new Error('Gemini API Key is missing. Open extension options to set it.');
    }

    const data = await analyzeText(allText, 'page_analysis', apiKey, modelName);
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
