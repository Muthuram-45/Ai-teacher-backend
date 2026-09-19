/**
 * Centralized, Language-Aware TTS Text Sanitizer
 * Normalizes text specifically for natural speech synthesis without altering UI/transcript text.
 *
 * @param {string} text - The original input text
 * @param {string} language - Locale / language code (e.g. 'en', 'ta', 'hi', 'te')
 * @returns {string} Sanitized text optimized for TTS engine
 */
function sanitizeTextForTTS(text, language = 'en') {
  if (!text || typeof text !== 'string') return '';

  const originalText = text;
  let s = text;

  // 1. Technical Term Normalizations
  s = s.replace(/\bC\+\+\b/gi, 'C plus plus');
  s = s.replace(/\bC#\b/gi, 'C sharp');
  s = s.replace(/\bNode\.js\b/gi, 'Node dot js');
  s = s.replace(/\bVue\.js\b/gi, 'Vue dot js');
  s = s.replace(/\bReact\.js\b/gi, 'React dot js');
  s = s.replace(/\bNext\.js\b/gi, 'Next dot js');
  s = s.replace(/\b\.env\b/gi, 'environment file');
  s = s.replace(/\bHTTP\b/g, 'H T T P');
  s = s.replace(/\bHTTPS\b/g, 'H T T P S');
  s = s.replace(/\bHTML5\b/gi, 'HTML 5');
  s = s.replace(/\bCSS3\b/gi, 'CSS 3');

  // 2. Emails & URLs
  s = s.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+)\.([a-zA-Z]{2,})/g, (match, p1, p2, p3) => {
    return `${p1} at ${p2} dot ${p3}`;
  });

  // 3. Percentages & Currency
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');
  s = s.replace(/\$(\d+(?:\.\d+)?)/g, '$1 dollars');
  s = s.replace(/₹(\d+(?:\.\d+)?)/g, '$1 rupees');

  // 4. Ampersands
  s = s.replace(/\s*&\s*/g, ' and ');

  // 5. Code block / backtick sanitization
  s = s.replace(/```[\s\S]*?```/g, (codeBlock) => {
    return codeBlock.replace(/```/g, '').replace(/[{}();=<>\/]/g, ' ');
  });

  // 6. Quotation Marks & Formatting Symbols (Convert to natural speech pauses)
  s = s.replace(/["'`”‘“]/g, ' ');
  s = s.replace(/[\#\*\_~|\\<>\[\]{}()]/g, ' ');

  // 7. Clean up repeated symbols and excessive punctuation (keep single sentence endings . ! ?)
  s = s.replace(/!+/g, '.');
  s = s.replace(/\?+/g, '?');
  s = s.replace(/;+/g, ',');
  s = s.replace(/:+/g, '.');

  // 8. Normalize spacing
  s = s.replace(/\s+/g, ' ').trim();

  // Dev log for inspection
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🎙️ [TTS Sanitizer] Lang: "${language}" | Original: "${originalText.substring(0, 40)}..." -> Sanitized: "${s.substring(0, 40)}..."`);
  }

  return s;
}

module.exports = {
  sanitizeTextForTTS,
};
