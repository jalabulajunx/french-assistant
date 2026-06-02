# French Assistant — Chrome Extension Plan

## Context

Sundar has registered for a French course using McGraw Hill's online ePub textbook reader ("Communication en direct"). The textbook renders content inside nested iframes with `srcdoc` attributes, mixing French text (`lang="fr"`) with English instructions (`lang="en"`). He wants a Chrome side panel that reads the page, extracts French words/phrases, and provides pronunciation guides from English AND Tamil perspectives, with ElevenLabs audio playback — similar to the Tamil Assistant he built for his son Skanda, but as a Chrome extension.

## Architecture

**Chrome Extension (Manifest V3)** — no backend server. All API calls happen from the extension context (service worker or side panel), which bypasses CORS restrictions.

```
content_script.js          → Injected into textbook pages
  ├─ Extracts French text from page (including iframes)
  ├─ Sends extracted text to service worker via chrome.runtime.sendMessage
  
service_worker.js          → Background orchestrator
  ├─ Receives text from content script
  ├─ Calls Gemini REST API for word analysis
  ├─ Calls ElevenLabs API for TTS (French + English pronunciation)
  ├─ Caches audio in IndexedDB
  ├─ Sends results to side panel
  
sidepanel.html/js          → User-facing UI
  ├─ "Analyze Page" button
  ├─ "Lookup Selected" button (for highlighted text)
  ├─ Word list (scrollable, clickable)
  ├─ Detail view per word
  ├─ Play buttons for audio
  
options.html/js            → Settings page for API keys
```

## File Structure

```
/home/radnus/Projects/French Assistant/
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js
├── options/
│   ├── options.html
│   └── options.js
├── scripts/
│   ├── service_worker.js
│   ├── content_script.js
│   ├── gemini_client.js
│   └── elevenlabs_client.js
├── prompts/
│   ├── page_analysis.txt
│   └── word_lookup.txt
└── lib/
    └── audio_cache.js
```

## Key Design Decisions

### 1. Content Extraction (content_script.js)

The MHE reader embeds content in `<iframe srcdoc="...">`. The content script must:
- Find the main iframe (`#clo-iframe`) and access its `contentDocument`
- Separate French text (elements without `lang="en"`) from English instructions
- Handle `lang` attributes to identify French vs English content
- Support text selection for "Lookup Selected" feature
- Listen for page navigation events (the reader is an SPA)

**Note:** Since the iframe uses `srcdoc` (same origin), the content script CAN access its DOM directly.

### 2. Gemini Integration (gemini_client.js)

Reuse the REST API pattern from Tamil Assistant:
- Model: `gemini-2.5-flash-lite` (same as Tamil Assistant — fast, cheap)
- Temperature: 0.2 for consistency
- Send extracted text (not images — this textbook has accessible HTML, unlike Tamil PDFs)

### 3. Prompt Design (prompts/page_analysis.txt)

Learner context (adapted from Tamil Assistant's prompt pattern):
```
Context:
1. Adult learner, Canadian, learning French at college level
2. Fluent in English and Tamil (native)
3. Beginner French (Chapitre 1 level)
4. Textbook: "Communication en direct" (McGraw Hill)
5. Wants pronunciation guides in BOTH English and Tamil phonetics

For each French word/phrase, return:
- french_word: the word in French
- english_meaning: translation
- english_pronunciation: phonetic guide using English sounds
  (e.g., "bonjour" → "bohn-ZHOOR")
- tamil_pronunciation: phonetic guide using Tamil sounds/transliteration
  (e.g., "bonjour" → "போன்ழூர்" with romanized "pōṉzhūr")
- contextual_meaning: how it's used in this specific text
- grammar_notes: verb form, gender, formality level, etc.
- formality: formal/informal/neutral
- example_sentence: a simple example using this word
```

### 4. ElevenLabs Integration (elevenlabs_client.js)

Adapted from RouteRules' `synthesize.py`:
- **Model:** `eleven_multilingual_v2` (NOT monolingual — need French)
- **French voice:** Use a French voice from ElevenLabs (e.g., "Charlotte" for French female, or let user pick)
- **English voice:** "Rachel" (same as RouteRules) for English pronunciation guides
- API: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
- Headers: `xi-api-key`, `Content-Type: application/json`
- Response: raw MP3 bytes → stored as Blob in IndexedDB

### 5. Audio Caching (lib/audio_cache.js)

IndexedDB store keyed by `{text}_{voice_id}`:
- Check cache before calling ElevenLabs
- Store MP3 blobs with metadata (word, language, timestamp)
- No expiry (words don't change pronunciation)

### 6. Side Panel UI (sidepanel/)

Layout (inspired by Tamil Assistant's GTK sidebar):

```
┌──────────────────────────────┐
│  🇫🇷 French Assistant         │
│  [Analyze Page] [Lookup Sel] │
├──────────────────────────────┤
│  Word List (scrollable)      │
│  ┌────────────────────────┐  │
│  │ bonjour    ▶ 🔊        │  │
│  │ hello / good day       │  │
│  ├────────────────────────┤  │
│  │ salut      ▶ 🔊        │  │
│  │ hi / bye (informal)    │  │
│  ├────────────────────────┤  │
│  │ madame     ▶ 🔊        │  │
│  │ ma'am / Mrs.           │  │
│  └────────────────────────┘  │
├──────────────────────────────┤
│  Detail View (on click)      │
│                              │
│  BONJOUR          ▶ Play FR  │
│                              │
│  English: "hello / good day" │
│                              │
│  🔊 English pronunciation:   │
│  "bohn-ZHOOR"     ▶ Play EN  │
│                              │
│  🔊 Tamil pronunciation:     │
│  போன்ழூர் (pōṉzhūr) ▶ Play  │
│                              │
│  Context: Greeting used      │
│  first time you see someone  │
│  during the day              │
│                              │
│  Formality: Formal/Neutral   │
│  Grammar: Interjection       │
│                              │
│  Example: "Bonjour, madame!" │
└──────────────────────────────┘
```

Each word card has a small play button. The detail view has separate play buttons for:
1. French word spoken in French (French ElevenLabs voice)
2. English pronunciation guide spoken in English (English ElevenLabs voice)
3. Tamil pronunciation guide (could use Tamil TTS or just display)

### 7. Settings (options/)

Simple form stored in `chrome.storage.sync`:
- Gemini API key
- ElevenLabs API key  
- ElevenLabs French voice ID (with dropdown of common French voices)
- ElevenLabs English voice ID (default: Rachel)
- Font size preference

## Implementation Order

1. **Scaffold:** manifest.json, icons, basic file structure
2. **Content script:** Extract French text from MHE reader (handle iframe)
3. **Service worker:** Message routing between content script ↔ side panel
4. **Gemini client:** REST API integration with French analysis prompt
5. **Side panel UI:** Word list + detail view (static mockup first, then wired)
6. **ElevenLabs client:** TTS synthesis with caching
7. **Options page:** API key management
8. **Polish:** Loading states, error handling, page navigation detection

## Verification

1. Load the extension in Chrome (`chrome://extensions` → Load unpacked)
2. Navigate to the MHE textbook reader
3. Open the side panel
4. Click "Analyze Page" — should extract French words from Chapitre 1
5. Click a word — should show detail with pronunciation guides
6. Click play buttons — should hear French pronunciation and English guide
7. Navigate to a different chapter page — should be able to re-analyze
8. Check that audio caching works (second play should be instant)
