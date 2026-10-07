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

  /**
   * Generates a synchronized per-language hand-raise audio package for connected students.
   *
   * @param {string} roomName
   * @param {string} studentName
   * @returns {Promise<Object>}
   */
  async prepareHandRaisePackage(roomName, studentName = "Student") {
    console.log(`\n===========================================`);
    console.log(`[HAND RAISE] Student: ${studentName}`);

    const studentsInRoom = languageRouter.getStudentsInRoom(roomName) || [];
    const connectedCount = studentsInRoom.length > 0 ? studentsInRoom.length : 1;
    console.log(`[HAND RAISE AUDIO] Connected students: ${connectedCount}`);

    const registeredLangs = languageRouter.getActiveLanguages(roomName) || [];
    const uniqueLanguages = Array.from(new Set(['en', ...registeredLangs]));

    console.log(`[HAND RAISE AUDIO] Languages: ${uniqueLanguages.join(', ')}`);

    const baseMessage = `${studentName}, did you have any doubt? If yes, click the Ask Doubt button and ask your doubt.`;
    const tracks = {};

    const staticTranslations = {
      'ta': `${studentName}, உங்களுக்கு ஏதாவது doubt இருக்கா? அப்படி இருந்தா Ask Doubt button click பண்ணி உங்க doubt கேளுங்க.`,
      'ml': `${studentName}, നിങ്ങൾക്ക് എന്തെങ്കിലും doubt ഉണ്ടോ? ഉണ്ടെങ്കിൽ Ask Doubt button ക്ലിക്ക് ചെയ്ത് നിങ്ങളുടെ doubt ചോദിക്കുക.`,
      'hi': `${studentName}, क्या आपका कोई doubt है? अगर है तो Ask Doubt button पर click करके अपना doubt पूछें.`,
      'te': `${studentName}, మీకు ఏదైనా doubt ఉందా? ఉంటే Ask Doubt button పై click చేసి మీ doubt అడగండి.`,
      'kn': `${studentName}, ನಿಮಗೆ ಯಾವುದಾದರೂ doubt ಇದೆಯಾ? ಇದ್ದರೆ Ask Doubt button ಕ್ಲಿಕ್ ಮಾಡಿ ನಿಮ್ಮ doubt ಕೇಳಿ.`,
      'en': `${studentName}, do you have any doubt? If so, click the Ask Doubt button and ask your doubt.`
    };

    await Promise.all(
      uniqueLanguages.map(async (lang) => {
        try {
          console.log(`[HAND RAISE AUDIO] Generating ${lang} audio`);
          let translatedText = staticTranslations[lang];
          
          if (!translatedText) {
            if (lang === 'en') {
              translatedText = staticTranslations['en'];
            } else {
              try {
                translatedText = await TranslationService.translate(baseMessage, lang);
              } catch (tErr) {
                console.warn(`⚠️ [HAND RAISE AUDIO] Translation failed for lang '${lang}', using English fallback prompt`);
                translatedText = staticTranslations['en'];
              }
            }
          }

          const cleanTTSText = sanitizeTextForTTS(translatedText, lang);

          tracks[lang] = {
            language: lang,
            text: translatedText,
            ttsText: cleanTTSText
          };
        } catch (err) {
          console.error(`❌ [HAND RAISE AUDIO] Error generating audio for lang '${lang}':`, err);
          tracks[lang] = {
            language: 'en',
            text: staticTranslations['en'],
            ttsText: staticTranslations['en'],
            error: true
          };
        }
      })
    );

    if (studentsInRoom.length > 0) {
      studentsInRoom.forEach(({ studentId, language }) => {
        const studentLang = language || 'en';
        console.log(`[HAND RAISE AUDIO] Sending ${studentLang} audio -> ${studentId}`);
      });
    } else {
      uniqueLanguages.forEach((lang) => {
        console.log(`[HAND RAISE AUDIO] Sending ${lang} audio -> broadcast (${lang})`);
      });
    }

    return {
      action: "HAND_RAISE_AUDIO_BROADCAST",
      studentName,
      roomName,
      tracks,
      timestamp: Date.now()
    };
  }
}

module.exports = new MultilingualOrchestrator();
