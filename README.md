# 🇫🇷 French Assistant — Chrome Extension

A premium Chrome Extension designed to help English-and-Tamil-speaking students learn French while reading textbooks on any online reader or any webpage with French content. 

It auto-scrolls and scans the active webpage, traverses same-origin `srcdoc` iframes, filters out English instructions, extracts key French vocabulary using Gemini, generates custom pronunciation guides in English and Tamil phonetics, explains accent marks and diacritics, and synthesizes speech using ElevenLabs with automatic local audio caching. For pages with text embedded in images, **Vision Mode** captures screenshots and uses Gemini Vision to read directly from the images.

---

## 📸 Screenshots

### Word List View
Open any page with French content, click **Analyze Page**, and the side panel extracts vocabulary with translations. Each card shows the French word and its English meaning, with a quick-play 🔊 button for instant pronunciation.

![Word list showing extracted French vocabulary from a textbook page](Screenshot.png)

### Detail View
Click any word to expand its full breakdown — pronunciation guides in both English and Tamil phonetics, accent mark explanations (e.g., what the circumflex in *hôtel* does to the vowel), contextual usage, grammar notes, formality level, and an example sentence with a **Play** button to hear it spoken in French.

![Detail view showing pronunciation guides, accent notes, and example sentence](Screenshot2.png)

---

## ✨ Features

-   **Auto-Scroll Page Capture**: Clicking **Analyze Page** automatically scrolls the entire page (or iframe) top-to-bottom, harvesting all text as it goes — no manual scrolling needed. Handles virtualized/lazy-loaded content that only exists in the DOM while visible.
-   **Deep Content Scanning**: Extracts French text recursively from nested same-origin `srcdoc` iframes while intelligently skipping English headings and instructions (`lang="en"`).
-   **Native PDF Support**: Automatically detects PDFs — whether opened directly in Chrome or embedded in a page via `<embed>`, `<object>`, or `<iframe>`. The PDF is fetched and sent directly to Gemini as a native PDF document (no screenshots needed). Large PDFs are analyzed in 10-page batches with running summaries.
-   **Vision Mode**: Toggle on to capture screenshots during auto-scroll instead of relying on DOM text extraction. Gemini Vision reads French text directly from the images — essential for pages where text is embedded in diagrams, illustrations, or infographics.
-   **Chunked Analysis with Running Context**: Large pages and PDFs are automatically split into manageable batches. Each batch is analyzed by Gemini, which also generates a cumulative running summary. That summary is fed into the next batch so Gemini maintains full thematic context across the entire document — no vocabulary is analyzed in isolation.
-   **Gemini-Powered Vocabulary Extraction**: Uses `gemini-2.5-flash-lite` (text mode) or `gemini-2.5-flash` (vision/PDF mode) to extract key French words, verb forms, and expressions, providing contextual meanings, formality levels, and grammatical details.
-   **French Number Handling**: Chapters teaching numbers/counting are detected and numerals are extracted with both the French word and numeral form (e.g., "vingt et un (21)"), including silent letter and liaison rules.
-   **Dual-Phonetics Pronunciation Guides**:
    -   **English Phonetics**: High-quality English transliterations (e.g., `bonjour` ➔ `"bohn-ZHOOR"`).
    -   **Tamil Phonetics**: Phonetically accurate Tamil script transliterations along with romanized forms (e.g., `bonjour` ➔ `"போன்ழூர் (pōṉzhūr)"`).
-   **Premium Text-to-Speech (TTS)**: Plays French pronunciation using ElevenLabs Multilingual v2 model with language-aware synthesis at 0.8x speed for clearer learning.
-   **Accent & Diacritics Guide**: Explains every accent mark (é, è, ê, ç, ô, etc.) and how it changes pronunciation — including historical context (e.g., circumflex replacing a dropped 's').
-   **Article & Contraction Preservation**: Always includes the correct article with nouns (le, la, l', les, un, une) and preserves contractions (l', d', n', qu', j') so learners see how French is actually spoken.
-   **In-Page Highlighting**: Clicking a word scrolls the textbook page to its occurrence and highlights it.
-   **Search**: Filter your vocabulary list by French word or English meaning.
-   **Offline Audio Caching**: Caches synthesized MP3 clips in IndexedDB to minimize API usage and ensure instantaneous playback on repeat clicks. Includes stale-handle recovery for service worker lifecycle resilience.
-   **Google Drive Sync**: Two-way sync of vocabulary and audio cache to a user-specified Google Drive folder. Vocabulary pushes automatically after each analysis; audio files sync incrementally. Works across devices with the same Google account.
-   **Persistent Session Memory**: Saves currently analyzed words in local browser storage (`chrome.storage.local`) so your session isn't lost when closing the side panel.
-   **Text Selection Lookup**: Highlight any word or sentence on the page and click "Lookup Selected" to instantly translate and slide open its detail card.

---

## 📂 File Structure

```
French Assistant/
├── manifest.json            # Extension Manifest V3 configuration
├── README.md                # Project documentation & guides
├── The Plan.md              # Original architecture and strategy draft
├── icons/                   # Resized branding icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── audio_cache.js       # IndexedDB manager for audio caching
├── prompts/                 # Gemini API system prompts
│   ├── page_analysis.txt    # Prompts for full page scanning
│   └── word_lookup.txt      # Prompts for highlighting a specific word
├── scripts/
│   ├── service_worker.js    # Background orchestrator & routing
│   ├── content_script.js    # DOM parser (iframe traversal & text extraction)
│   ├── gemini_client.js     # Rest API wrapper for Gemini API
│   └── elevenlabs_client.js # Rest API wrapper for ElevenLabs TTS
├── sidepanel/               # Main panel interface
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js
└── options/                 # Configuration options page
    ├── options.html
    ├── options.css
    └── options.js
```

---

## 🚀 Installation & Setup

### 1. Load the Extension into Google Chrome
1.  Open **Google Chrome** and navigate to `chrome://extensions`.
2.  In the top-right corner, turn on **Developer mode**.
3.  In the top-left corner, click the **Load unpacked** button.
4.  Select the project directory:
    the cloned/downloaded project directory
5.  The extension is now installed! The settings configuration page will open automatically.

### 2. Configure Credentials & Settings
You will need your own API keys. Configure them on the settings page:
-   **Gemini API Key**: Obtain a free API key from [Google AI Studio](https://aistudio.google.com/).
-   **Gemini Model**: Choose between `Gemini 2.5 Flash Lite` (default for text mode), `Gemini 2.5 Flash` (used automatically for Vision mode), `Gemini 2.5 Pro`, or enter a custom model name.
-   **ElevenLabs API Key**: Obtain an API key from the [ElevenLabs Dashboard](https://elevenlabs.io/).
-   **Voice Selections**:
    -   *French Voice*: Select **Charlotte** (recommended for natural French female narration) or paste a custom Voice ID.
    -   *English Voice*: Select **Rachel** (recommended for conversational English guides) or paste a custom Voice ID.
-   Click **Save Settings**.

### 3. Configure Google Drive Sync (Optional)
To sync your vocabulary and audio across devices:
1.  Go to the [Google Cloud Console — Credentials](https://console.cloud.google.com/apis/credentials).
2.  Create an **OAuth 2.0 Client ID** of type **Web application**.
3.  Add the redirect URI shown on the extension's settings page (looks like `https://<extension-id>.chromiumapp.org/`) to the **Authorized redirect URIs**.
4.  Enable the **Google Drive API** in your Google Cloud project.
5.  Copy the Client ID into the extension's settings.
6.  Enter the Google Drive Folder ID (from the folder URL, the part after `/folders/`). You can also paste the full folder URL — the extension extracts the ID automatically.
7.  Click **Authenticate with Google** and grant access.
8.  Click **Sync Now** to perform the initial sync, or use the ☁️ button in the side panel.

---

## 📖 How to Use

### 🔍 Method 1: Scanning a Full Page (Text Mode)
1.  Open any French textbook reader or webpage with French content.
2.  Open the **French Assistant Side Panel** by clicking the puzzle icon in Chrome and pinning/clicking the extension.
3.  Click **Analyze Page** in the side panel.
4.  The extension will **auto-scroll** the entire page top-to-bottom, capturing all text blocks as it goes. Progress is shown in the loading indicator (e.g., "Scrolling page... 65% (142 blocks captured)").
5.  Once scrolling completes, the text is sent to Gemini for analysis. For large pages, this happens in batches — each batch carries a running summary of prior context so nothing is analyzed in isolation.
6.  A list of extracted French words and expressions will load.
7.  Click on any word card to expand its detail drawer.
8.  Click **French Voice** to hear native French audio, or **Play** next to the example sentence to hear it in context.

### 📄 Method 2: Analyzing a PDF
1.  Open a French PDF directly in Chrome (navigate to the `.pdf` URL), or open a page that has a PDF embedded.
2.  Click **Analyze Page** — the extension automatically detects the PDF, downloads it, and sends it directly to Gemini.
3.  For large PDFs, analysis happens in 10-page batches with progress updates (e.g., "Analyzing PDF batch 2 of 4...").
4.  No auto-scrolling or screenshots are needed — Gemini reads the PDF natively.

### 👁️ Method 3: Vision Mode (for text in images)
1.  Toggle on **Vision Mode** in the side panel before clicking Analyze Page.
2.  Click **Analyze Page** — the extension auto-scrolls as before, but now captures **screenshots** at each scroll position instead of extracting DOM text.
3.  The screenshots are sent in batches to Gemini Vision, which reads French text directly from the images — including labels on diagrams, text in illustrations, and content inside image-based layouts.
4.  Use this when the page renders text as images, or when DOM extraction misses content.

### 👆 Method 4: Highlighting Text (Quick Lookup)
1.  While reading the textbook page, highlight (select) any French word or phrase with your cursor.
2.  Click **Lookup Selected** in the side panel.
3.  The term will be analyzed by Gemini, added to the top of your list, and the detail view will automatically slide in!

---

## 🛠️ Technical Details for Developers

### 1. Auto-Scroll & Text Harvesting
Clicking **Analyze Page** triggers a programmatic auto-scroll engine in `content_script.js`. It scrolls the page (or the primary same-origin iframe) from top to bottom in 75%-viewport steps, pausing at each step to harvest text and allow lazy/virtualized content to render. A `MutationObserver` and scroll listeners continuously deduplicate and accumulate paragraphs into a buffer using a `Set` of normalized strings.

### 2. Same-Origin Iframe Extraction
The textbook reader uses standard same-origin `srcdoc` iframes. The `content_script.js` handles this by checking for `iframe` tags and recursively traversing their `contentDocument.body`. It filters elements by checking the `lang` attribute:
-   If an element has `lang="en"`, it is skipped, along with all its children.
-   Common UI elements (buttons, inputs, textareas, svgs) are skipped to prevent reading control panel buttons.

### 3. Chunked Analysis with Running Summaries
Large pages (60+ text blocks) are split into overlapping chunks of ~60 paragraphs with 10-paragraph overlap at boundaries. Each chunk is sent to Gemini sequentially. Gemini returns two things per chunk:
1.  **`vocabulary`**: the array of extracted word entries.
2.  **`running_summary`**: a Gemini-generated cumulative summary (~200 words) covering all content analyzed so far — topics, themes, and every `french_word` already extracted.

The running summary from chunk N is fed as context into chunk N+1. This way, chunk 5 receives a summary that encapsulates chunks 1–4, maintaining full thematic continuity without resending raw text. Results are merged and deduplicated by `french_word` at the end.

### 4. PDF Support
The service worker detects PDFs in three ways: (1) the tab URL ends in `.pdf`, (2) an `<embed type="application/pdf">` element on the page, or (3) an `<iframe>` or `<object>` pointing to a `.pdf` URL. When detected, the PDF is fetched directly via the service worker (which has `<all_urls>` host permission, bypassing CORS), converted to base64, and sent to Gemini as `inline_data` with `mime_type: "application/pdf"`. Large PDFs are analyzed in batches of 10 pages, with Gemini instructed to focus on a specific page range per batch while the running summary carries cumulative context forward.

### 5. Vision Mode
When toggled on, the service worker captures JPEG screenshots via `chrome.tabs.captureVisibleTab` at each auto-scroll step. Screenshots are sent to Gemini Vision in batches of 4, using the same running-summary chain for context continuity. **No DOM text is sent in Vision mode** — Gemini reads everything from the images. The model is automatically upgraded from `flash-lite` to `flash` for better image understanding.

### 6. Service Worker Module System
The extension runs background tasks using a Manifest V3 Service Worker. In `manifest.json`, the background service worker is declared with `"type": "module"`, allowing direct `import` statements of the API clients and caching systems.

### 7. Audio Caching
Audio assets are stored in an IndexedDB database named `FrenchAssistantAudioCache` in the `audio_blobs` store. The keys are structured as `lowercase_french_word_voiceId`. When audio is played:
1.  The service worker queries the local cache.
2.  If found, the cached Blob is fetched and converted to an `ArrayBuffer` (serialized as `Uint8Array` for Chrome message passing) to be sent to the side panel.
3.  If not found, ElevenLabs is called, the audio is written asynchronously to the IndexedDB, and the `ArrayBuffer` is sent.

The cache includes stale-handle recovery — if the service worker's IndexedDB handle becomes invalid after sleeping, the database is automatically reopened.
