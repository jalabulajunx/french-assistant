// Options Script — Manage settings & credentials
import { clearCache } from '../lib/audio_cache.js';

// DOM Elements
const geminiKeyInput = document.getElementById('gemini-key');
const geminiModelSelect = document.getElementById('gemini-model-select');
const geminiModelCustom = document.getElementById('gemini-model-custom');

const elevenlabsKeyInput = document.getElementById('elevenlabs-key');

const frenchVoiceSelect = document.getElementById('elevenlabs-french-voice-select');
const frenchVoiceCustom = document.getElementById('elevenlabs-french-voice-custom');

const englishVoiceSelect = document.getElementById('elevenlabs-english-voice-select');
const englishVoiceCustom = document.getElementById('elevenlabs-english-voice-custom');

const cacheSizeSpan = document.getElementById('cache-size');
const clearCacheBtn = document.getElementById('btn-clear-cache');
const saveBtn = document.getElementById('btn-save');
const statusMessage = document.getElementById('status-message');

// Toggle Password Visibility
document.querySelectorAll('.btn-toggle-visibility').forEach(button => {
  button.addEventListener('click', (e) => {
    const input = e.target.previousElementSibling;
    if (input.type === 'password') {
      input.type = 'text';
      e.target.textContent = '🙈';
    } else {
      input.type = 'password';
      e.target.textContent = '👁️';
    }
  });
});

// Manage Voice Select dropdowns (custom vs predefined)
function setupVoiceSelect(selectEl, customInputEl) {
  selectEl.addEventListener('change', () => {
    if (selectEl.value === 'custom') {
      customInputEl.classList.remove('hidden');
      customInputEl.focus();
    } else {
      customInputEl.classList.add('hidden');
    }
  });
}

setupVoiceSelect(geminiModelSelect, geminiModelCustom);
setupVoiceSelect(frenchVoiceSelect, frenchVoiceCustom);
setupVoiceSelect(englishVoiceSelect, englishVoiceCustom);

// Populate Select values
function setSelectValue(selectEl, customInputEl, savedValue) {
  if (!savedValue) return;

  // Check if saved value is one of the dropdown options
  const options = Array.from(selectEl.options).map(opt => opt.value);
  if (options.includes(savedValue)) {
    selectEl.value = savedValue;
    customInputEl.classList.add('hidden');
  } else {
    selectEl.value = 'custom';
    customInputEl.value = savedValue;
    customInputEl.classList.remove('hidden');
  }
}

// Load settings from storage
async function loadSettings() {
  chrome.storage.sync.get([
    'geminiApiKey',
    'geminiModel',
    'elevenlabsApiKey',
    'elevenlabsFrenchVoiceId',
    'elevenlabsEnglishVoiceId'
  ], (items) => {
    if (items.geminiApiKey) geminiKeyInput.value = items.geminiApiKey;
    if (items.elevenlabsApiKey) elevenlabsKeyInput.value = items.elevenlabsApiKey;

    setSelectValue(geminiModelSelect, geminiModelCustom, items.geminiModel || 'gemini-2.5-flash');
    setSelectValue(frenchVoiceSelect, frenchVoiceCustom, items.elevenlabsFrenchVoiceId);
    setSelectValue(englishVoiceSelect, englishVoiceCustom, items.elevenlabsEnglishVoiceId);
  });

  updateCacheSizeDisplay();
}

// Update cache size status
function updateCacheSizeDisplay() {
  const DB_NAME = 'FrenchAssistantAudioCache';
  const STORE_NAME = 'audio_blobs';
  
  const request = indexedDB.open(DB_NAME, 1);
  
  request.onsuccess = (event) => {
    const db = event.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      cacheSizeSpan.textContent = '0 items (empty)';
      return;
    }
    
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const countRequest = store.count();
    
    countRequest.onsuccess = () => {
      const count = countRequest.result;
      cacheSizeSpan.textContent = `${count} audio clip${count !== 1 ? 's' : ''} cached`;
    };
  };

  request.onerror = () => {
    cacheSizeSpan.textContent = 'Error loading status';
  };
}

// Save Settings
saveBtn.addEventListener('click', () => {
  const geminiApiKey = geminiKeyInput.value.trim();
  const elevenlabsApiKey = elevenlabsKeyInput.value.trim();

  // Get Gemini Model ID
  let geminiModel = geminiModelSelect.value;
  if (geminiModel === 'custom') {
    geminiModel = geminiModelCustom.value.trim();
  }

  // Get French Voice ID
  let elevenlabsFrenchVoiceId = frenchVoiceSelect.value;
  if (elevenlabsFrenchVoiceId === 'custom') {
    elevenlabsFrenchVoiceId = frenchVoiceCustom.value.trim();
  }

  // Get English Voice ID
  let elevenlabsEnglishVoiceId = englishVoiceSelect.value;
  if (elevenlabsEnglishVoiceId === 'custom') {
    elevenlabsEnglishVoiceId = englishVoiceCustom.value.trim();
  }

  // Validate basic fields
  if (!geminiApiKey) {
    showStatus('Please enter a Gemini API Key', 'error');
    return;
  }

  chrome.storage.sync.set({
    geminiApiKey,
    geminiModel,
    elevenlabsApiKey,
    elevenlabsFrenchVoiceId,
    elevenlabsEnglishVoiceId
  }, () => {
    showStatus('Settings saved successfully!', 'success');
    loadSettings(); // Reload to refresh custom inputs layout
  });
});

// Clear Cache
clearCacheBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to delete all cached audio clips?')) {
    try {
      await clearCache();
      showStatus('Cache cleared!', 'success');
      updateCacheSizeDisplay();
    } catch (err) {
      console.error(err);
      showStatus('Failed to clear cache: ' + err.message, 'error');
    }
  }
});

// Helper to show status message
function showStatus(text, type) {
  statusMessage.textContent = text;
  statusMessage.className = 'status-msg';
  
  if (type === 'success') {
    statusMessage.classList.add('status-success');
  } else {
    statusMessage.classList.add('status-error');
  }
  
  setTimeout(() => {
    statusMessage.textContent = '';
    statusMessage.className = 'status-msg';
  }, 4000);
}

// Run on startup
document.addEventListener('DOMContentLoaded', loadSettings);
