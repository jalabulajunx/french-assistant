// Gemini API Client

/**
 * Sends a text prompt to the Gemini API and returns the parsed JSON response.
 * @param {string} text - The input text (either full page or selected word).
 * @param {string} promptType - 'page_analysis' or 'word_lookup'.
 * @param {string} apiKey - The Gemini API Key.
 * @param {string} modelName - The Gemini model to use.
 * @returns {Promise<any>}
 */
export async function analyzeText(text, promptType, apiKey, modelName = 'gemini-2.5-flash-lite') {
  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Please add it in the settings.');
  }

  // Load the prompt template from the extension assets
  const promptFile = promptType === 'page_analysis' ? 'prompts/page_analysis.txt' : 'prompts/word_lookup.txt';
  const responseText = await fetch(chrome.runtime.getURL(promptFile));
  if (!responseText.ok) {
    throw new Error(`Failed to load prompt template: ${promptFile}`);
  }
  const template = await responseText.text();
  const prompt = template.replace('{{TEXT}}', text);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 65536
    }
  };

  return await callGemini(url, requestBody);
}

/**
 * Analyze screenshots in chunked batches with running Gemini-generated summaries.
 * No DOM text is sent — Gemini reads everything from the images.
 *
 * Each batch of ~4 screenshots is sent to Gemini Vision along with the
 * running summary from all prior batches. Gemini returns vocabulary + an
 * updated running summary that gets fed into the next batch.
 *
 * @param {string[]} screenshots - Array of base64 data URLs (jpeg).
 * @param {string} apiKey - The Gemini API Key.
 * @param {string} modelName - The Gemini model to use.
 * @param {function} onProgress - Called with (chunkIndex, totalChunks).
 * @returns {Promise<any[]>} Merged array of vocabulary entries.
 */
export async function analyzeWithVisionChunked(screenshots, apiKey, modelName = 'gemini-2.5-flash-lite', onProgress = null) {
  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Please add it in the settings.');
  }

  // For vision, use flash (not flash-lite) for better image understanding
  const visionModel = modelName.includes('lite') ? modelName.replace('-lite', '') : modelName;

  // Load the base prompt template
  const responseText = await fetch(chrome.runtime.getURL('prompts/page_analysis.txt'));
  if (!responseText.ok) {
    throw new Error('Failed to load prompt template: prompts/page_analysis.txt');
  }
  const baseTemplate = await responseText.text();

  // Split screenshots into batches of 4
  const BATCH_SIZE = 4;
  const batches = [];
  for (let i = 0; i < screenshots.length; i += BATCH_SIZE) {
    batches.push(screenshots.slice(i, i + BATCH_SIZE));
  }

  // Single batch — simple path, no summary overhead
  if (batches.length <= 1) {
    const result = await callVisionBatch(batches[0], '', 0, 1, baseTemplate, visionModel, apiKey);
    return extractVocabulary(result);
  }

  console.log(`Vision chunked analysis: ${batches.length} batches of ~${BATCH_SIZE} screenshots`);
  const allResults = [];
  let runningSummary = '';

  for (let i = 0; i < batches.length; i++) {
    if (onProgress) onProgress(i, batches.length);
    console.log(`Analyzing vision batch ${i + 1}/${batches.length} (${batches[i].length} screenshots)...`);

    try {
      const result = await callVisionBatch(
        batches[i], runningSummary, i, batches.length, baseTemplate, visionModel, apiKey
      );

      let entries = [];
      let newSummary = '';

      if (result && typeof result === 'object' && !Array.isArray(result)) {
        entries = Array.isArray(result.vocabulary) ? result.vocabulary : [];
        newSummary = result.running_summary || '';
      } else if (Array.isArray(result)) {
        entries = result;
        const words = entries.map(e => e.french_word).join(', ');
        newSummary = runningSummary
          ? `${runningSummary}\nBatch ${i + 1} added: ${words}`
          : `Batch ${i + 1} words: ${words}`;
      }

      allResults.push(...entries);
      if (newSummary) runningSummary = newSummary;

    } catch (e) {
      console.warn(`Vision batch ${i + 1}/${batches.length} failed:`, e.message);
    }
  }

  if (allResults.length === 0) {
    throw new Error('All vision analysis batches failed. Please try again.');
  }

  // Deduplicate
  const seen = new Map();
  for (const entry of allResults) {
    if (entry && entry.french_word) {
      seen.set(entry.french_word.toLowerCase(), entry);
    }
  }
  return Array.from(seen.values());
}

/**
 * Call Gemini Vision for a single batch of screenshots.
 * If runningSummary is provided, it's prepended as context from prior batches.
 * Asks for { vocabulary, running_summary } response format when multi-batch.
 */
async function callVisionBatch(screenshotBatch, runningSummary, batchIdx, totalBatches, baseTemplate, visionModel, apiKey) {
  // Build the text prompt
  let contextBlock = '';
  if (batchIdx > 0 && runningSummary) {
    contextBlock =
      `CUMULATIVE CONTEXT FROM PREVIOUS SCREENSHOT BATCHES (1–${batchIdx}):\n` +
      `"""\n${runningSummary}\n"""\n\n` +
      `You are now analyzing batch ${batchIdx + 1} of ${totalBatches}. ` +
      `Use the context above to understand the page's ongoing themes, but only extract NEW vocabulary ` +
      `not already listed in the summary above.\n\n`;
  }

  const visionIntro = `You are analyzing ${screenshotBatch.length} screenshot(s) from a French textbook page. ` +
    `Read ALL text visible in the screenshots — including text inside images, diagrams, labels, ` +
    `illustrations, and handwritten exercises. Extract French vocabulary from what you see.\n\n`;

  // The base template has {{TEXT}} placeholder — for vision, we replace it with
  // the context block (prior summary) since the actual "text" is in the images.
  const prompt = visionIntro + baseTemplate.replace('{{TEXT}}', contextBlock + '[Text is contained in the attached screenshots — read it from the images.]');

  // If multi-batch, ask for wrapped format with running_summary
  let formatWrapper = '';
  if (totalBatches > 1) {
    formatWrapper =
      `\n\nIMPORTANT — OUTPUT FORMAT:\n` +
      `Return a JSON object (NOT a plain array) with exactly two keys:\n` +
      `1. "vocabulary": the array of vocabulary entry objects as described above.\n` +
      `2. "running_summary": a concise summary (150–250 words) of ALL content analyzed so far ` +
      `(including the cumulative context above AND what you read in these screenshots). ` +
      `Include: the chapter/topic, key themes, and a bullet list of all french_word values extracted so far. ` +
      `This summary will be passed to the next batch as context, so make it comprehensive.\n`;
  }

  // Build parts: text prompt, then images
  const parts = [{ text: prompt + formatWrapper }];
  for (const dataUrl of screenshotBatch) {
    const base64Data = dataUrl.split(',')[1];
    if (base64Data) {
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: base64Data
        }
      });
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apiKey}`;
  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 65536
    }
  };

  return await callGemini(url, requestBody);
}

/** Helper to extract vocabulary array from either wrapped or plain response */
function extractVocabulary(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray(result.vocabulary)) return result.vocabulary;
  if (result && typeof result === 'object') return [result];
  return [];
}

/**
 * Split numbered paragraphs into overlapping chunks.
 * Overlap ensures paragraphs near boundaries appear in both adjacent chunks,
 * preserving local context at split points.
 * @param {string} numberedText - Text formatted as "[1] ...\n[2] ...\n..."
 * @param {number} chunkSize - Max paragraphs per chunk.
 * @param {number} overlap - Number of paragraphs to overlap between chunks.
 * @returns {string[]} Array of text chunks.
 */
export function chunkText(numberedText, chunkSize = 60, overlap = 10) {
  const lines = numberedText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= chunkSize) return [lines.join('\n')];

  const chunks = [];
  const step = chunkSize - overlap;
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + chunkSize);
    chunks.push(slice.join('\n'));
    if (i + chunkSize >= lines.length) break;
  }
  return chunks;
}

/**
 * Analyze a single chunk with cumulative context from prior chunks.
 * Returns { vocabulary: [...], running_summary: "..." }.
 *
 * For chunk 1: uses the standard page_analysis prompt, but asks for the
 *   wrapped response format with a running_summary.
 * For chunk N>1: prepends the running_summary from chunks 1..(N-1) so
 *   Gemini knows the full page story so far.
 */
async function analyzeChunkWithContext(chunkText, runningSummary, chunkIdx, totalChunks, apiKey, modelName) {
  // Load the base prompt template
  const responseText = await fetch(chrome.runtime.getURL('prompts/page_analysis.txt'));
  if (!responseText.ok) {
    throw new Error('Failed to load prompt template: prompts/page_analysis.txt');
  }
  const baseTemplate = await responseText.text();

  // Build the prompt — inject context for chunks after the first
  let contextBlock = '';
  if (chunkIdx > 0 && runningSummary) {
    contextBlock =
      `CUMULATIVE CONTEXT FROM SECTIONS 1–${chunkIdx} OF THIS PAGE:\n` +
      `"""\n${runningSummary}\n"""\n\n` +
      `You are now analyzing section ${chunkIdx + 1} of ${totalChunks}. ` +
      `Use the context above to understand ongoing themes, but only extract NEW vocabulary ` +
      `not already listed in the summary. If a word from the overlap zone was already covered, skip it.\n\n`;
  }

  // Replace {{TEXT}} with context + chunk content
  const prompt = baseTemplate.replace('{{TEXT}}', contextBlock + chunkText);

  // Wrap the output format: we need BOTH vocabulary AND a running summary
  const formatWrapper =
    `\n\nIMPORTANT — OUTPUT FORMAT FOR THIS REQUEST:\n` +
    `Return a JSON object (NOT a plain array) with exactly two keys:\n` +
    `1. "vocabulary": the array of vocabulary entry objects as described above.\n` +
    `2. "running_summary": a concise summary (150–250 words) of ALL content analyzed so far ` +
    `across this page (including the cumulative context above AND this section). ` +
    `Include: the chapter/topic, key themes, and a bullet list of all french_word values extracted so far ` +
    `(from the context summary AND from this section's vocabulary). ` +
    `This summary will be passed to the next section as context, so make it comprehensive.\n`;

  const fullPrompt = prompt + formatWrapper;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 65536
    }
  };

  return await callGemini(url, requestBody);
}

/**
 * Analyze a large page by splitting into chunks and calling Gemini
 * for each chunk sequentially. Each call receives a Gemini-generated
 * running summary of ALL prior chunks, maintaining cumulative context.
 *
 * @param {string} text - Full numbered text.
 * @param {string} apiKey - Gemini API key.
 * @param {string} modelName - Model name.
 * @param {function} onProgress - Called with (chunkIndex, totalChunks).
 * @returns {Promise<any[]>} Merged array of vocabulary entries.
 */
export async function analyzeTextChunked(text, apiKey, modelName = 'gemini-2.5-flash-lite', onProgress = null) {
  const chunks = chunkText(text);

  // If only one chunk, no need for the summary machinery
  if (chunks.length <= 1) {
    return await analyzeText(text, 'page_analysis', apiKey, modelName);
  }

  console.log(`Chunked analysis: ${chunks.length} chunks from text`);
  const allResults = [];
  let runningSummary = '';  // Gemini-generated cumulative summary, grows each iteration

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    console.log(`Analyzing chunk ${i + 1}/${chunks.length} (summary so far: ${runningSummary.length} chars)...`);

    try {
      const result = await analyzeChunkWithContext(
        chunks[i], runningSummary, i, chunks.length, apiKey, modelName
      );

      // Extract vocabulary and running_summary from the wrapped response
      let entries = [];
      let newSummary = '';

      if (result && typeof result === 'object' && !Array.isArray(result)) {
        // Expected format: { vocabulary: [...], running_summary: "..." }
        entries = Array.isArray(result.vocabulary) ? result.vocabulary : [];
        newSummary = result.running_summary || '';
      } else if (Array.isArray(result)) {
        // Gemini ignored our format wrapper and returned a plain array —
        // fall back gracefully, build a crude summary ourselves
        entries = result;
        const words = entries.map(e => e.french_word).join(', ');
        newSummary = runningSummary
          ? `${runningSummary}\nSection ${i + 1} added: ${words}`
          : `Section ${i + 1} words: ${words}`;
      }

      allResults.push(...entries);

      // Update the cumulative summary for the next chunk
      if (newSummary) {
        runningSummary = newSummary;
      }

    } catch (e) {
      console.warn(`Chunk ${i + 1}/${chunks.length} failed:`, e.message);
      // Keep runningSummary intact so the next chunk still has prior context
    }
  }

  if (allResults.length === 0) {
    throw new Error('All analysis chunks failed. Please try again.');
  }

  // Deduplicate by french_word (case-insensitive), keeping the last occurrence.
  // The later entry wins because it was analyzed with more cumulative context.
  const seen = new Map();
  for (const entry of allResults) {
    if (entry && entry.french_word) {
      seen.set(entry.french_word.toLowerCase(), entry);
    }
  }
  return Array.from(seen.values());
}

/**
 * Shared Gemini API call + response parsing.
 */
async function callGemini(url, requestBody) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API error response:', errorText);
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('No response generated by Gemini.');
  }

  const generatedText = result.candidates[0].content.parts[0].text;

  try {
    const parsedData = JSON.parse(generatedText);
    return parsedData;
  } catch (e) {
    console.error('Failed to parse Gemini response as JSON. Raw response:', generatedText);
    throw new Error('Gemini did not return valid JSON. Please try again.');
  }
}
