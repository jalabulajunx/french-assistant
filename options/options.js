// Options Script — Manage settings & credentials
import { clearCache } from '../lib/audio_cache.js';
import { authenticate, getRedirectUrl } from '../lib/drive_sync.js';

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

// Drive sync elements
const driveClientIdInput = document.getElementById('drive-client-id');
const driveFolderIdInput = document.getElementById('drive-folder-id');
const driveRedirectUri = document.getElementById('drive-redirect-uri');
const btnDriveAuth = document.getElementById('btn-drive-auth');
const btnDriveSync = document.getElementById('btn-drive-sync');
const driveStatus = document.getElementById('drive-status');

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
    'elevenlabsEnglishVoiceId',
    'driveClientId',
    'driveFolderId'
  ], (items) => {
    if (items.geminiApiKey) geminiKeyInput.value = items.geminiApiKey;
    if (items.elevenlabsApiKey) elevenlabsKeyInput.value = items.elevenlabsApiKey;
    if (items.driveClientId) driveClientIdInput.value = items.driveClientId;
    if (items.driveFolderId) driveFolderIdInput.value = items.driveFolderId;

    setSelectValue(geminiModelSelect, geminiModelCustom, items.geminiModel || 'gemini-2.5-flash');
    setSelectValue(frenchVoiceSelect, frenchVoiceCustom, items.elevenlabsFrenchVoiceId);
    setSelectValue(englishVoiceSelect, englishVoiceCustom, items.elevenlabsEnglishVoiceId);
  });

  // Show redirect URI for OAuth setup
  try {
    driveRedirectUri.textContent = getRedirectUrl();
  } catch (e) {
    driveRedirectUri.textContent = '(will be shown after extension loads)';
  }

  // Check Drive auth status
  chrome.storage.local.get(['driveTokenExpiresAt'], (items) => {
    if (items.driveTokenExpiresAt && items.driveTokenExpiresAt > Date.now()) {
      driveStatus.textContent = '✅ Authenticated';
      driveStatus.className = 'drive-status status-success';
    } else if (items.driveTokenExpiresAt) {
      driveStatus.textContent = '⚠️ Token expired — click Authenticate';
      driveStatus.className = 'drive-status status-error';
    }
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

  // Drive settings
  const driveClientId = driveClientIdInput.value.trim();
  let driveFolderId = driveFolderIdInput.value.trim();
  // Extract folder ID from a full Drive URL if pasted
  const folderMatch = driveFolderId.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    driveFolderId = folderMatch[1];
    driveFolderIdInput.value = driveFolderId;
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
    elevenlabsEnglishVoiceId,
    driveClientId,
    driveFolderId
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

// Drive: Authenticate
btnDriveAuth.addEventListener('click', async () => {
  const clientId = driveClientIdInput.value.trim();
  if (!clientId) {
    showStatus('Please enter a Google OAuth Client ID first', 'error');
    return;
  }

  // Save the client ID first
  await chrome.storage.sync.set({ driveClientId: clientId });

  try {
    driveStatus.textContent = '🔄 Authenticating...';
    driveStatus.className = 'drive-status';
    await authenticate(clientId, true);
    driveStatus.textContent = '✅ Authenticated successfully!';
    driveStatus.className = 'drive-status status-success';
    showStatus('Google Drive authenticated!', 'success');
  } catch (err) {
    console.error('Drive auth error:', err);
    driveStatus.textContent = '❌ Authentication failed';
    driveStatus.className = 'drive-status status-error';
    showStatus('Authentication failed: ' + err.message, 'error');
  }
});

// Drive: Sync Now
btnDriveSync.addEventListener('click', async () => {
  const clientId = driveClientIdInput.value.trim();
  const folderId = driveFolderIdInput.value.trim();

  if (!clientId || !folderId) {
    showStatus('Please configure Drive Client ID and Folder ID first', 'error');
    return;
  }

  try {
    driveStatus.textContent = '🔄 Syncing...';
    driveStatus.className = 'drive-status';
    btnDriveSync.disabled = true;

    // Listen for progress updates
    const progressListener = (message) => {
      if (message.action === 'sync_progress') {
        driveStatus.textContent = `🔄 ${message.detail}`;
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'drive_sync' }, resolve);
    });

    chrome.runtime.onMessage.removeListener(progressListener);
    btnDriveSync.disabled = false;

    if (response && response.success) {
      const s = response.stats;
      driveStatus.textContent = `✅ Synced! Words: ${s.wordsPushed} total, Audio: ↑${s.audioPushed} ↓${s.audioPulled}`;
      driveStatus.className = 'drive-status status-success';
      showStatus('Drive sync complete!', 'success');
    } else {
      driveStatus.textContent = '❌ Sync failed';
      driveStatus.className = 'drive-status status-error';
      showStatus('Sync failed: ' + (response?.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    btnDriveSync.disabled = false;
    driveStatus.textContent = '❌ Sync failed';
    driveStatus.className = 'drive-status status-error';
    showStatus('Sync failed: ' + err.message, 'error');
  }
});

// Run on startup
document.addEventListener('DOMContentLoaded', loadSettings);
