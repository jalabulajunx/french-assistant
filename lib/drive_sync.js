// Google Drive Sync for French Assistant
// Syncs vocabulary and audio cache to a user-specified Google Drive folder.
// Uses OAuth2 implicit flow via chrome.identity.launchWebAuthFlow.

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const VOCAB_FILENAME = 'french-assistant-vocabulary.json';
const AUDIO_FOLDER_NAME = 'french-assistant-audio';

// ─── OAuth ───

/**
 * Authenticate with Google via OAuth2 implicit flow.
 * Opens a consent popup the first time; subsequent calls may reuse the session.
 * @param {string} clientId - Google OAuth Client ID.
 * @param {boolean} interactive - Whether to show the consent popup.
 * @returns {Promise<string>} Access token.
 */
export async function authenticate(clientId, interactive = true) {
  const redirectUrl = chrome.identity.getRedirectURL();
  const scopes = 'https://www.googleapis.com/auth/drive.file';

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUrl)}&` +
    `response_type=token&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `prompt=${interactive ? 'consent' : 'none'}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive
  });

  // Extract access_token from the redirect URL fragment
  const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
  const accessToken = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

  if (!accessToken) {
    throw new Error('Failed to get access token from Google.');
  }

  // Store token and expiry
  const expiresAt = Date.now() + (expiresIn * 1000) - 60000; // 1 min buffer
  await chrome.storage.local.set({
    driveAccessToken: accessToken,
    driveTokenExpiresAt: expiresAt
  });

  return accessToken;
}

/**
 * Get a valid access token, re-authenticating if expired.
 * @param {string} clientId - Google OAuth Client ID.
 * @returns {Promise<string|null>} Access token or null if not configured.
 */
export async function getValidToken(clientId) {
  if (!clientId) return null;

  const stored = await chrome.storage.local.get(['driveAccessToken', 'driveTokenExpiresAt']);
  if (stored.driveAccessToken && stored.driveTokenExpiresAt > Date.now()) {
    return stored.driveAccessToken;
  }

  // Token expired — try non-interactive refresh
  try {
    return await authenticate(clientId, false);
  } catch (e) {
    console.warn('Drive: non-interactive auth failed, needs re-auth:', e.message);
    return null;
  }
}

/**
 * Get the redirect URL for the user to configure in Google Cloud Console.
 */
export function getRedirectUrl() {
  return chrome.identity.getRedirectURL();
}

// ─── Drive API Helpers ───

async function driveRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    // Token expired mid-session
    await chrome.storage.local.remove(['driveAccessToken', 'driveTokenExpiresAt']);
    throw new Error('Drive token expired. Please re-authenticate in settings.');
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Drive API error ${response.status}: ${errText}`);
  }

  return response;
}

/**
 * Find a file by name in a specific parent folder.
 * @returns {Promise<{id: string, name: string}|null>}
 */
async function findFile(name, parentId, mimeType, token) {
  let query = `name='${name}' and '${parentId}' in parents and trashed=false`;
  if (mimeType) {
    query += ` and mimeType='${mimeType}'`;
  }

  const response = await driveRequest(
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`,
    token
  );
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

/**
 * Create a folder in Drive.
 * @returns {Promise<string>} Folder ID.
 */
async function createFolder(name, parentId, token) {
  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  const response = await driveRequest(`${DRIVE_API}/files`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });

  const data = await response.json();
  return data.id;
}

/**
 * Find or create the audio subfolder inside the user's sync folder.
 * @returns {Promise<string>} Audio folder ID.
 */
async function getAudioFolderId(parentFolderId, token) {
  const existing = await findFile(AUDIO_FOLDER_NAME, parentFolderId, 'application/vnd.google-apps.folder', token);
  if (existing) return existing.id;
  return await createFolder(AUDIO_FOLDER_NAME, parentFolderId, token);
}

/**
 * Upload or update a JSON file in Drive.
 * @param {string} filename - File name.
 * @param {any} jsonData - Data to serialize.
 * @param {string} parentId - Parent folder ID.
 * @param {string} token - Access token.
 * @returns {Promise<string>} File ID.
 */
async function upsertJsonFile(filename, jsonData, parentId, token) {
  const content = JSON.stringify(jsonData, null, 2);
  const existing = await findFile(filename, parentId, null, token);

  if (existing) {
    // Update existing file
    await driveRequest(
      `${DRIVE_UPLOAD_API}/files/${existing.id}?uploadType=media`,
      token,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content
      }
    );
    return existing.id;
  } else {
    // Create new file with multipart upload (metadata + content)
    const metadata = { name: filename, parents: [parentId] };
    const boundary = 'french_assistant_boundary';
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--`;

    const response = await driveRequest(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      }
    );
    const data = await response.json();
    return data.id;
  }
}

/**
 * Download a JSON file from Drive by file ID.
 * @returns {Promise<any>} Parsed JSON data.
 */
async function downloadJsonFile(fileId, token) {
  const response = await driveRequest(
    `${DRIVE_API}/files/${fileId}?alt=media`,
    token
  );
  return await response.json();
}

// ─── Audio File Operations ───

/**
 * Upload an audio blob to Drive.
 * @param {string} audioKey - Cache key (e.g., "bonjour_voiceId").
 * @param {Blob} audioBlob - MP3 blob.
 * @param {string} audioFolderId - Drive folder ID for audio.
 * @param {string} token - Access token.
 * @returns {Promise<string>} File ID.
 */
export async function pushAudioFile(audioKey, audioBlob, audioFolderId, token) {
  const filename = `${audioKey}.mp3`;
  const existing = await findFile(filename, audioFolderId, null, token);

  if (existing) {
    // Already exists — skip (audio doesn't change)
    return existing.id;
  }

  // Create new audio file with multipart upload
  const metadata = { name: filename, parents: [audioFolderId] };
  const boundary = 'french_assistant_audio_boundary';

  // Convert blob to base64 for multipart body
  const arrayBuffer = await audioBlob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: audio/mpeg\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${base64}\r\n` +
    `--${boundary}--`;

  const response = await driveRequest(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    }
  );
  const data = await response.json();
  return data.id;
}

/**
 * List all audio files in the audio folder.
 * @returns {Promise<{name: string, id: string}[]>}
 */
export async function listAudioFiles(audioFolderId, token) {
  const query = `'${audioFolderId}' in parents and trashed=false`;
  let allFiles = [];
  let pageToken = null;

  do {
    let url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name),nextPageToken&pageSize=100&spaces=drive`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const response = await driveRequest(url, token);
    const data = await response.json();
    allFiles = allFiles.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * Download an audio file from Drive as a Blob.
 * @returns {Promise<Blob>}
 */
export async function pullAudioFile(fileId, token) {
  const response = await driveRequest(
    `${DRIVE_API}/files/${fileId}?alt=media`,
    token
  );
  return await response.blob();
}

// ─── High-Level Sync Operations ───

/**
 * Push vocabulary list to Drive.
 * @param {any[]} words - Vocabulary entries.
 * @param {string} folderId - User's Drive folder ID.
 * @param {string} token - Access token.
 */
export async function pushVocabulary(words, folderId, token) {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    wordCount: words.length,
    words
  };
  await upsertJsonFile(VOCAB_FILENAME, data, folderId, token);
  console.log(`Drive: pushed ${words.length} words to vocabulary.json`);
}

/**
 * Pull vocabulary list from Drive.
 * @param {string} folderId - User's Drive folder ID.
 * @param {string} token - Access token.
 * @returns {Promise<any[]|null>} Array of word entries, or null if not found.
 */
export async function pullVocabulary(folderId, token) {
  const file = await findFile(VOCAB_FILENAME, folderId, null, token);
  if (!file) {
    console.log('Drive: no vocabulary.json found in Drive folder');
    return null;
  }

  const data = await downloadJsonFile(file.id, token);
  console.log(`Drive: pulled ${data.wordCount || data.words?.length || 0} words from vocabulary.json`);
  return data.words || [];
}

/**
 * Full sync: push local data to Drive AND pull remote data to local.
 * Merge strategy: union of both, dedup by french_word (remote wins for conflicts).
 *
 * @param {string} folderId - Drive folder ID.
 * @param {string} token - Access token.
 * @param {function} getLocalWords - Returns current local word list.
 * @param {function} setLocalWords - Saves merged word list locally.
 * @param {function} getLocalAudio - Returns {key, blob} for a given audio key.
 * @param {function} saveLocalAudio - Saves a {key, blob} pair to local cache.
 * @param {function} getAllLocalAudioKeys - Returns all local audio cache keys.
 * @param {function} onProgress - Progress callback.
 * @returns {Promise<{wordsPushed: number, wordsPulled: number, audioPushed: number, audioPulled: number}>}
 */
export async function fullSync(folderId, token, {
  getLocalWords, setLocalWords,
  getLocalAudio, saveLocalAudio, getAllLocalAudioKeys,
  onProgress = null
} = {}) {
  const stats = { wordsPushed: 0, wordsPulled: 0, audioPushed: 0, audioPulled: 0 };

  // 1. Sync vocabulary
  if (onProgress) onProgress('Syncing vocabulary...');

  const localWords = await getLocalWords();
  const remoteWords = await pullVocabulary(folderId, token) || [];

  // Merge: build map, remote wins for same french_word
  const merged = new Map();
  for (const w of localWords) {
    if (w.french_word) merged.set(w.french_word.toLowerCase(), w);
  }
  for (const w of remoteWords) {
    if (w.french_word) merged.set(w.french_word.toLowerCase(), w);
  }
  const mergedWords = Array.from(merged.values());

  // Push merged list back to Drive
  await pushVocabulary(mergedWords, folderId, token);
  stats.wordsPushed = mergedWords.length;

  // Save merged list locally
  await setLocalWords(mergedWords);
  stats.wordsPulled = mergedWords.length - localWords.length;

  // 2. Sync audio
  if (onProgress) onProgress('Syncing audio cache...');

  const audioFolderId = await getAudioFolderId(folderId, token);
  const remoteAudioFiles = await listAudioFiles(audioFolderId, token);
  const remoteAudioMap = new Map(remoteAudioFiles.map(f => [f.name.replace('.mp3', ''), f.id]));

  // Push local audio that's not on Drive
  const localAudioKeys = await getAllLocalAudioKeys();
  for (const key of localAudioKeys) {
    if (!remoteAudioMap.has(key)) {
      try {
        const blob = await getLocalAudio(key);
        if (blob) {
          if (onProgress) onProgress(`Uploading audio: ${key.split('_')[0]}...`);
          await pushAudioFile(key, blob, audioFolderId, token);
          stats.audioPushed++;
        }
      } catch (e) {
        console.warn(`Drive: failed to push audio ${key}:`, e.message);
      }
    }
  }

  // Pull remote audio that's not in local cache
  const localKeySet = new Set(localAudioKeys);
  for (const [key, fileId] of remoteAudioMap) {
    if (!localKeySet.has(key)) {
      try {
        if (onProgress) onProgress(`Downloading audio: ${key.split('_')[0]}...`);
        const blob = await pullAudioFile(fileId, token);
        await saveLocalAudio(key, blob);
        stats.audioPulled++;
      } catch (e) {
        console.warn(`Drive: failed to pull audio ${key}:`, e.message);
      }
    }
  }

  console.log(`Drive sync complete:`, stats);
  return stats;
}

// ─── Utilities ───

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
