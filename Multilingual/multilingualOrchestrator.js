const languageRouter = require('./languageRouter');
const { TranslationService } = require('./services');
const { sanitizeTextForTTS } = require('./ttsSanitizer');

class MultilingualOrchestrator {
  /**
   * Generates a synchronized multilingual audio package for a given room.
   * Only translates and generates tracks for languages actually selected by students in the room,
   * plus the teacher's selected audio language.
   * English is NEVER included by default unless a student in the room actually selected English.
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
    // 1. Get active student languages for the room
    const registeredLangs = languageRouter.getActiveLanguages(roomName) || [];
    
    // 2. Select optimized teacher audio language from actual student selections
    const teacherLangDetails = languageRouter.getTeacherAudioLanguage(roomName, {
      allowDocumentedDefault: false
    });
    const teacherLanguage = teacherLangDetails.language;

    // Collect unique languages to process: strictly student selected + teacher chosen
    const langSet = new Set(registeredLangs);
    if (teacherLanguage) {
      langSet.add(teacherLanguage);
    }

    const uniqueLanguages = Array.from(langSet);

    console.log(`\n===========================================`);
    console.log(
      `🌐 [MultilingualOrchestrator] Room: "${roomName}" | Registered Student Langs: [${registeredLangs.join(', ')}] | ` +
      `Teacher Audio Lang: "${teacherLanguage || 'none'}" (${teacherLangDetails.ruleMatched}) | ` +
      `Unique Languages To Generate (${uniqueLanguages.length}): [${uniqueLanguages.join(', ')}]`
    );

    const tracks = {};

    // If no students in room and no teacher language could be selected, return clean response without silent English
    if (uniqueLanguages.length === 0) {
      console.warn(`⚠️ [MultilingualOrchestrator] No active student languages in room "${roomName}". No unnecessary TTS generated.`);
      return {
        action: "AI_ANSWER_BROADCAST",
        id: answerId,
        text: questionText,
        answer: canonicalAnswer,
        name: speakerName,
        isDirectResponse,
        startAt: Date.now() + bufferMs,
        teacherLanguage: null,
        teacherLanguageDetails: teacherLangDetails,
        tracks: {}
      };
    }

    // 3. Parallel Translation across strictly required unique languages
    await Promise.all(
      uniqueLanguages.map(async (lang) => {
        try {
          let translatedText = canonicalAnswer;
          // Only translate if canonical text differs or isn't already in this target language
          translatedText = await TranslationService.translate(canonicalAnswer, lang);

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
          tracks[lang] = {
            language: lang,
            error: true,
            text: null
          };
        }
      })
    );

    // 4. Shared synchronized future timestamp
    const startAt = Date.now() + bufferMs;

    const payload = {
      action: "AI_ANSWER_BROADCAST",
      id: answerId,
      text: questionText,
      answer: canonicalAnswer,
      name: speakerName,
      isDirectResponse,
      startAt,
      teacherLanguage,
      teacherLanguageDetails: teacherLangDetails,
      tracks
    };

    console.log(`✅ [MultilingualOrchestrator] Package ready for answer "${answerId}". Teacher Lang: "${teacherLanguage}". StartAt: ${new Date(startAt).toISOString()}`);
    return payload;
  }

  /**
   * Generates a synchronized per-language hand-raise audio package for connected students.
   * Only generates for active student languages and selected teacher language.
   *
   * @param {string} roomName
   * @param {string} studentName
   * @returns {Promise<Object>}
   */
  async prepareHandRaisePackage(roomName, studentName = "Student") {
    console.log(`\n===========================================`);
    console.log(`[HAND RAISE] Student: ${studentName} in room: ${roomName}`);

    const studentsInRoom = languageRouter.getStudentsInRoom(roomName) || [];
    const connectedCount = studentsInRoom.length > 0 ? studentsInRoom.length : 1;
    console.log(`[HAND RAISE AUDIO] Connected students: ${connectedCount}`);

    const registeredLangs = languageRouter.getActiveLanguages(roomName) || [];
    const teacherLangDetails = languageRouter.getTeacherAudioLanguage(roomName, { allowDocumentedDefault: false });
    const teacherLanguage = teacherLangDetails.language;

    const langSet = new Set(registeredLangs);
    if (teacherLanguage) {
      langSet.add(teacherLanguage);
    }
    const uniqueLanguages = Array.from(langSet);

    console.log(`[HAND RAISE AUDIO] Required Languages: [${uniqueLanguages.join(', ')}] | Teacher Lang: "${teacherLanguage || 'none'}"`);

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
            try {
              translatedText = await TranslationService.translate(baseMessage, lang);
            } catch (tErr) {
              console.warn(`⚠️ [HAND RAISE AUDIO] Translation failed for lang '${lang}'`);
              translatedText = staticTranslations[lang] || baseMessage;
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
            language: lang,
            error: true
          };
        }
      })
    );

    return {
      action: "HAND_RAISE_AUDIO_BROADCAST",
      studentName,
      roomName,
      teacherLanguage,
      teacherLanguageDetails: teacherLangDetails,
      tracks,
      timestamp: Date.now()
    };
  }
}

module.exports = new MultilingualOrchestrator();
