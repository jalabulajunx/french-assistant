// Side Panel Controller Script

// DOM elements
const stateEmpty = document.getElementById('state-empty');
const stateLoading = document.getElementById('state-loading');
const stateList = document.getElementById('state-list');
const loadingTitle = document.getElementById('loading-title');

const wordsContainer = document.getElementById('words-container');
const wordCountSpan = document.getElementById('word-count');
const clearListBtn = document.getElementById('btn-clear-list');

const searchInput = document.getElementById('search-input');
const toggleVision = document.getElementById('toggle-vision');
const visionStatus = document.getElementById('vision-status');
const btnAnalyze = document.getElementById('btn-analyze');
const btnLookup = document.getElementById('btn-lookup');
const btnSettings = document.getElementById('btn-settings');

// Detail Panel Elements
const detailPanel = document.getElementById('detail-panel');
const btnBack = document.getElementById('btn-back');
const detailFrenchWord = document.getElementById('detail-french-word');
const detailEnglishMeaning = document.getElementById('detail-english-meaning');
const detailEnglishPron = document.getElementById('detail-english-pron');
const detailTamilPron = document.getElementById('detail-tamil-pron');
const detailAccentNotes = document.getElementById('detail-accent-notes');
const detailContextualMeaning = document.getElementById('detail-contextual-meaning');
const detailFormality = document.getElementById('detail-formality');
const detailGrammarNotes = document.getElementById('detail-grammar-notes');
const detailExampleFr = document.getElementById('detail-example-fr');
const detailExampleEn = document.getElementById('detail-example-en');

const btnPlayFrench = document.getElementById('btn-play-french');
const btnPlayExample = document.getElementById('btn-play-example');

// Current state variables
let currentWords = [];
let selectedWord = null;
let currentPlayingAudio = null;
let currentPlayingBtn = null;

// Capture status element
const captureStatus = document.getElementById('capture-status');

// Listen for progress updates from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'auto_scroll_progress') {
    const pct = Math.min(100, Math.round((message.position / message.totalHeight) * 100));
    loadingTitle.textContent = `Scrolling page... ${pct}% (${message.paragraphs} blocks captured)`;
  }
  if (message.action === 'analysis_progress') {
    loadingTitle.textContent = message.detail || 'Analyzing...';
  }
});

// Initialize Side Panel
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  loadSavedWords();
  startCaptureStatusPolling();
});

// Event Listeners setup
function setupEventListeners() {
  // Navigation & Settings
  btnSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  btnBack.addEventListener('click', () => {
    detailPanel.classList.remove('active');
    stopCurrentAudio();
    chrome.runtime.sendMessage({ action: 'clear_highlights' }, () => {});
  });

  // Action Buttons
  btnAnalyze.addEventListener('click', handlePageAnalysis);
  btnLookup.addEventListener('click', handleSelectionLookup);
  clearListBtn.addEventListener('click', handleClearList);

  // Vision mode toggle
  toggleVision.addEventListener('change', () => {
    const enabled = toggleVision.checked;
    chrome.runtime.sendMessage({ action: 'set_vision_mode', enabled }, () => {});
    if (!enabled) {
      visionStatus.textContent = '';
    }
  });

  // Search
  searchInput.addEventListener('input', () => {
    renderWordList(searchInput.value.trim());
  });

  // Detail Audio Playback
  btnPlayFrench.addEventListener('click', () => {
    if (selectedWord) {
      playTTS(selectedWord.french_word, 'french', btnPlayFrench);
    }
  });

  btnPlayExample.addEventListener('click', () => {
    if (selectedWord && selectedWord.example_sentence) {
      // Extract just the French part (before the parenthetical English translation)
      const frenchPart = selectedWord.example_sentence.split('(')[0].trim();
      playTTS(frenchPart, 'french', btnPlayExample);
    }
  });
}

// Load words persisted in local storage
function loadSavedWords() {
  chrome.storage.local.get(['analyzedWords'], (result) => {
    if (result.analyzedWords && result.analyzedWords.length > 0) {
      currentWords = result.analyzedWords;
      showState('list');
      renderWordList();
    } else {
      showState('empty');
    }
  });
}

// Toggle between UI states (empty, loading, list)
function showState(state, customTitle = '') {
  stateEmpty.classList.add('hidden');
  stateLoading.classList.add('hidden');
  stateList.classList.add('hidden');

  if (state === 'empty') {
    stateEmpty.classList.remove('hidden');
  } else if (state === 'loading') {
    if (customTitle) {
      loadingTitle.textContent = customTitle;
    } else {
      loadingTitle.textContent = "Analyzing page content...";
    }
    stateLoading.classList.remove('hidden');
  } else if (state === 'list') {
    stateList.classList.remove('hidden');
  }
}

// Handle complete page extraction and analysis
function handlePageAnalysis() {
  showState('loading', 'Analyzing page...');
  stopCurrentAudio();
  
  chrome.runtime.sendMessage({ action: 'analyze_page' }, (response) => {
    if (chrome.runtime.lastError) {
      alert(`Connection error: ${chrome.runtime.lastError.message}`);
      showState(currentWords.length > 0 ? 'list' : 'empty');
      return;
    }

    if (response && response.success) {
      // Merge results with existing words
      mergeNewWords(response.data);
      showState('list');
    } else {
      alert(`Analysis failed: ${response ? response.error : 'Unknown error'}`);
      showState(currentWords.length > 0 ? 'list' : 'empty');
    }
  });
}

// Handle lookup of currently highlighted text
function handleSelectionLookup() {
  showState('loading', 'Looking up selected phrase...');
  stopCurrentAudio();

  chrome.runtime.sendMessage({ action: 'lookup_selected' }, (response) => {
    if (chrome.runtime.lastError) {
      alert(`Connection error: ${chrome.runtime.lastError.message}`);
      showState(currentWords.length > 0 ? 'list' : 'empty');
      return;
    }

    if (response && response.success) {
      const newWord = response.data;
      mergeNewWords([newWord]);
      showState('list');
      
      // Auto open detail view for the looked-up word
      openDetailView(newWord);
    } else {
      alert(`Lookup failed: ${response ? response.error : 'No selection found. Highlight text on page first.'}`);
      showState(currentWords.length > 0 ? 'list' : 'empty');
    }
  });
}

// Merge new words into existing list, avoiding duplicate keys
function mergeNewWords(newWordsList) {
  if (!Array.isArray(newWordsList)) return;
  
  newWordsList.forEach(newEntry => {
    // Check for duplicates (case insensitive)
    const idx = currentWords.findIndex(
      item => item.french_word.toLowerCase() === newEntry.french_word.toLowerCase()
    );
    
    if (idx !== -1) {
      // Replace existing entry with updated/better details
      currentWords[idx] = newEntry;
    } else {
      // Add to front of the list
      currentWords.unshift(newEntry);
    }
  });

  // Save to local storage
  chrome.storage.local.set({ analyzedWords: currentWords }, () => {
    renderWordList();
  });
}

// Render the scrollable list of word cards
function renderWordList(filter = '') {
  wordsContainer.innerHTML = '';
  const query = filter.toLowerCase();
  const filtered = query
    ? currentWords.filter(w =>
        w.french_word.toLowerCase().includes(query) ||
        w.english_meaning.toLowerCase().includes(query))
    : currentWords;

  wordCountSpan.textContent = query
    ? `${filtered.length} of ${currentWords.length} words`
    : `${currentWords.length} word${currentWords.length !== 1 ? 's' : ''} found`;

  filtered.forEach(word => {
    const card = document.createElement('div');
    card.className = 'word-card';
    
    // Main info block (clicks to open detail)
    const info = document.createElement('div');
    info.className = 'word-info';
    info.innerHTML = `
      <div class="french-term">${escapeHtml(word.french_word)}</div>
      <div class="english-term">${escapeHtml(word.english_meaning)}</div>
    `;
    info.addEventListener('click', () => openDetailView(word));
    card.appendChild(info);

    // Audio shortcut button
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const audioBtn = document.createElement('button');
    audioBtn.className = 'btn-card-audio';
    audioBtn.innerHTML = '🔊';
    audioBtn.title = 'Pronounce';
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Avoid opening detail page
      playTTS(word.french_word, 'french', audioBtn);
    });
    actions.appendChild(audioBtn);
    card.appendChild(actions);

    wordsContainer.appendChild(card);
  });
}

// Open and populate the details panel
function openDetailView(word) {
  selectedWord = word;
  stopCurrentAudio();

  // Populate fields
  detailFrenchWord.textContent = word.french_word;
  detailEnglishMeaning.textContent = word.english_meaning;
  detailEnglishPron.textContent = word.english_pronunciation || 'N/A';
  detailTamilPron.textContent = word.tamil_pronunciation || 'N/A';
  detailAccentNotes.textContent = word.accent_notes || 'No accent marks.';
  detailContextualMeaning.textContent = word.contextual_meaning || 'N/A';
  detailGrammarNotes.textContent = word.grammar_notes || 'N/A';
  detailExampleFr.textContent = word.example_sentence ? word.example_sentence.split('(')[0].trim() : 'N/A';
  
  // Extract English meaning from parentheses in the example sentence if present
  if (word.example_sentence && word.example_sentence.includes('(')) {
    const start = word.example_sentence.indexOf('(');
    const end = word.example_sentence.lastIndexOf(')');
    detailExampleEn.textContent = word.example_sentence.substring(start, end + 1);
  } else {
    detailExampleEn.textContent = '';
  }

  // Setup Formality Badge
  detailFormality.className = 'badge';
  const formality = (word.formality || 'neutral').toLowerCase();
  detailFormality.textContent = formality;
  if (formality === 'formal') {
    detailFormality.classList.add('badge-formal');
  } else if (formality === 'informal') {
    detailFormality.classList.add('badge-informal');
  } else {
    detailFormality.classList.add('badge-neutral');
  }

  // Slide-in animation
  detailPanel.classList.add('active');

  // Highlight and scroll to the word on the page
  chrome.runtime.sendMessage(
    { action: 'highlight_word', word: word.french_word },
    () => { /* best-effort */ }
  );
}

// Clear local word list and storage
function handleClearList() {
  if (confirm('Clear all words from your current session?')) {
    currentWords = [];
    chrome.storage.local.remove(['analyzedWords'], () => {
      stopCurrentAudio();
      detailPanel.classList.remove('active');
      showState('empty');
    });
  }
}

// Stop any audio currently playing
function stopCurrentAudio() {
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    currentPlayingAudio = null;
  }
  if (currentPlayingBtn) {
    currentPlayingBtn.classList.remove('playing');
    if (currentPlayingBtn.classList.contains('btn-card-audio')) {
      currentPlayingBtn.innerHTML = '🔊';
    }
    currentPlayingBtn = null;
  }
}

// Request and play TTS audio from ElevenLabs (or cache)
function playTTS(text, voiceType, buttonElement) {
  // If clicking the same button that is already playing, stop it
  if (currentPlayingBtn === buttonElement) {
    stopCurrentAudio();
    return;
  }

  // Stop previous audio
  stopCurrentAudio();

  // Set visual playing state
  currentPlayingBtn = buttonElement;
  buttonElement.classList.add('playing');
  if (buttonElement.classList.contains('btn-card-audio')) {
    buttonElement.innerHTML = '⚡';
  }

  chrome.runtime.sendMessage({ action: 'get_audio', text, voiceType }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      stopCurrentAudio();
      alert('Failed to connect to service worker.');
      return;
    }

    if (response && response.success && response.audioData) {
      // Check if button changed while loading
      if (currentPlayingBtn !== buttonElement) return;

      try {
        const blob = new Blob([new Uint8Array(response.audioData)], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio(url);
        currentPlayingAudio = audio;
        
        audio.addEventListener('ended', () => {
          if (currentPlayingBtn === buttonElement) {
            stopCurrentAudio();
          }
        });

        audio.addEventListener('error', (e) => {
          console.error('Audio playback error:', e);
          stopCurrentAudio();
        });

        audio.play().catch(err => {
          console.error('Playback failed:', err);
          stopCurrentAudio();
        });

      } catch (err) {
        console.error('Failed to create audio blob:', err);
        stopCurrentAudio();
      }
    } else {
      stopCurrentAudio();
      alert(`TTS synthesis failed: ${response ? response.error : 'Unknown API error'}`);
    }
  });
}

// Poll the content script for how many paragraphs have been captured
function startCaptureStatusPolling() {
  let lastCount = 0;

  async function poll() {
    try {
      const tab = await getActiveTabFromSidePanel();
      if (!tab) return;

      chrome.tabs.sendMessage(tab.id, { action: 'get_accumulated_text' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        const count = response.paragraphCount || 0;
        if (count !== lastCount) {
          lastCount = count;
          if (captureStatus) {
            captureStatus.textContent = `📡 ${count} text block${count !== 1 ? 's' : ''} captured`;
          }
        }

        // Also poll vision status
        chrome.runtime.sendMessage({ action: 'get_vision_status' }, (vResponse) => {
          if (chrome.runtime.lastError || !vResponse) return;
          if (vResponse.enabled && vResponse.screenshotCount > 0) {
            visionStatus.textContent = `📸 ${vResponse.screenshotCount} screenshot${vResponse.screenshotCount !== 1 ? 's' : ''}`;
          }
        });
      });
    } catch (e) { /* tab not ready */ }
  }

  setInterval(poll, 2000);
  poll();
}

async function getActiveTabFromSidePanel() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// Simple HTML escaping helper
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
