// ElevenLabs TTS Client

/**
 * Synthesizes text to speech using ElevenLabs API
 * @param {string} text - The text to synthesize
 * @param {string} voiceId - The voice ID to use
 * @param {string} apiKey - The ElevenLabs API key
 * @returns {Promise<Blob>} - The synthesized audio Blob
 */
export async function synthesizeSpeech(text, voiceId, apiKey, languageCode = 'fr') {
  if (!apiKey) {
    throw new Error('ElevenLabs API key is not configured. Please add it in the settings.');
  }

  if (!voiceId) {
    throw new Error('No voice ID provided for speech synthesis.');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const requestBody = {
    text: text,
    model_id: 'eleven_multilingual_v2',
    language_code: languageCode,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'accept': 'audio/mpeg'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('ElevenLabs API error response:', errorText);
    throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
  }

  const audioBlob = await response.blob();
  return audioBlob;
}
