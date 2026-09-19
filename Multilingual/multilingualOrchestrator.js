const languageRouter = require('./languageRouter');
const { TranslationService } = require('./services');
const { sanitizeTextForTTS } = require('./ttsSanitizer');

class MultilingualOrchestrator {
  /**
   * Generates a synchronized multilingual audio package for a given room.
   *
   * @param {string} roomName
   * @param {string} answerId
   * @param {string} canonicalAnswer
   * @param {boolean} isDirectResponse
   * @param {string} speakerName
   * @param {string} questionText
   * @param {number} bufferMs
   * @returns {Promise<Object>}
   */
  async prepareMultilingualPackage(
    roomName,
    answerId,
    canonicalAnswer,
    isDirectResponse = false,
    speakerName = "Student",
    questionText = "",
    bufferMs = 2500
  ) {
    // 1. Get active languages for room & deduplicate
    const registeredLangs = languageRouter.getActiveLanguages(roomName) || [];
    const uniqueLanguages = Array.from(new Set(['en', ...registeredLangs]));

    console.log(`\n===========================================`);
    console.log(`🌐 [MultilingualOrchestrator] Room: "${roomName}" | Unique Languages (${uniqueLanguages.length}):`, uniqueLanguages);

    const tracks = {};

    // 2. Parallel Translation across unique languages
    await Promise.all(
      uniqueLanguages.map(async (lang) => {
        try {
          let translatedText = canonicalAnswer;
          if (lang !== 'en') {
            translatedText = await TranslationService.translate(canonicalAnswer, lang);
          }

          const rawAudioString = isDirectResponse
            ? translatedText
            : `${speakerName} asked: ${questionText}. ${translatedText}`;

          const cleanTTSText = sanitizeTextForTTS(rawAudioString, lang);

          tracks[lang] = {
            language: lang,
            text: rawAudioString,
            ttsText: cleanTTSText,
            translatedAnswer: translatedText
          };
        } catch (err) {
          console.error(`❌ [MultilingualOrchestrator] Error translating for lang '${lang}':`, err);
          // On failure for a specific language, do NOT send incorrect fallback language.
          // Exclude or mark failed gracefully so student handles it safely.
          tracks[lang] = {
            language: lang,
            error: true,
            text: null
          };
        }
      })
    );

    // 3. Shared synchronized future timestamp
    const startAt = Date.now() + bufferMs;

    const payload = {
      action: "AI_ANSWER_BROADCAST",
      id: answerId,
      text: questionText,
      answer: canonicalAnswer,
      name: speakerName,
      isDirectResponse,
      startAt,
      tracks
    };

    console.log(`✅ [MultilingualOrchestrator] Package ready for answer "${answerId}". StartAt: ${new Date(startAt).toISOString()}`);
    return payload;
  }
}

module.exports = new MultilingualOrchestrator();
