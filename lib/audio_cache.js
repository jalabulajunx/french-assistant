// IndexedDB Audio Cache for French Assistant

const DB_NAME = 'FrenchAssistantAudioCache';
const DB_VERSION = 1;
const STORE_NAME = 'audio_blobs';

let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      // Verify the object store actually exists (handles stale/corrupt DB)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        // Delete and recreate the DB
        const delReq = indexedDB.deleteDatabase(DB_NAME);
        delReq.onsuccess = () => {
          // Re-open — this time onupgradeneeded will fire
          openDB().then(resolve).catch(reject);
        };
        delReq.onerror = () => reject(new Error('Failed to reset audio cache DB'));
        return;
      }
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function getDB() {
  if (dbInstance) {
    // Verify handle is still usable (service worker may have killed it)
    try {
      // Quick check — if the DB was closed, this throws
      if (dbInstance.objectStoreNames.contains(STORE_NAME)) {
        return dbInstance;
      }
    } catch (e) {
      dbInstance = null;
    }
  }
  dbInstance = await openDB();
  return dbInstance;
}

/**
 * Generates a unique key for the text and voice combination
 * @param {string} text
 * @param {string} voiceId
 * @returns {string}
 */
function makeKey(text, voiceId) {
  const cleanText = text.trim().toLowerCase();
  return `${cleanText}_${voiceId}`;
}

export async function getAudio(text, voiceId) {
  try {
    const db = await getDB();
    const key = makeKey(text, voiceId);

    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => {
        console.error('Error fetching audio from cache:', request.error);
        resolve(null);
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  } catch (e) {
    console.error('Audio cache getAudio failed:', e);
    dbInstance = null; // Force re-open next time
    return null;
  }
}

export async function saveAudio(text, voiceId, blob) {
  try {
    const db = await getDB();
    const key = makeKey(text, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(blob, key);

      request.onerror = () => {
        console.error('Error saving audio to cache:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(true);
      };
    });
  } catch (e) {
    console.error('Audio cache saveAudio failed:', e);
    dbInstance = null;
    throw e;
  }
}

export async function clearCache() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (e) {
    console.error('Audio cache clearCache failed:', e);
    dbInstance = null;
    throw e;
  }
}
