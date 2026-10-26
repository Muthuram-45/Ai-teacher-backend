const express = require('express');
const multer = require('multer');
const { STTService, TranslationService, TTSService } = require('./services');
const languageRouter = require('./languageRouter');
const { selectTeacherLanguage, normalizeLanguage } = require('./teacherLanguageSelector');
const multilingualOrchestrator = require('./multilingualOrchestrator');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Endpoint to translate lesson or speech text to chosen language
router.post('/translate-text', async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }
    const normLang = normalizeLanguage(targetLanguage) || targetLanguage || 'en';
    const translatedText = await TranslationService.translate(text, normLang);
    res.json({
      success: true,
      originalText: text,
      targetLanguage: normLang,
      translatedText
    });
  } catch (error) {
    console.error("Translate text error:", error);
    res.status(500).json({ error: "Translation failed: " + error.message });
  }
});

// Endpoint to inspect or select teacher audio language for a room
router.get('/teacher-language/:roomName', (req, res) => {
  const { roomName } = req.params;
  const summary = languageRouter.getRoomSummary(roomName);
  res.json({
    success: true,
    roomName,
    teacherAudioLanguage: summary.teacherAudioLanguage,
    activeLanguages: summary.activeLanguages,
    languageCounts: summary.languageCounts,
    studentCount: summary.studentCount,
    details: summary.teacherLanguageDetails
  });
});

// Standalone endpoint to evaluate language selection rules
router.post('/select-teacher-language', (req, res) => {
  const { studentLanguages, roomName, options } = req.body;
  if (roomName) {
    const details = languageRouter.getTeacherAudioLanguage(roomName, options);
    return res.json({
      success: !details.error,
      roomName,
      ...details
    });
  }

  const details = selectTeacherLanguage(studentLanguages || [], options);
  res.json({
    success: !details.error,
    ...details
  });
});

// Endpoint for room diagnostics
router.get('/room-summary/:roomName', (req, res) => {
  const { roomName } = req.params;
  const summary = languageRouter.getRoomSummary(roomName);
  res.json({ success: true, ...summary });
});

// Track which languages are active for which rooms
router.post('/process-chunk', upload.single('audio'), async (req, res) => {
  try {
    const { roomName } = req.body;
    const audioBuffer = req.file?.buffer;

    if (!audioBuffer) {
      return res.status(400).json({ error: "No audio chunk provided" });
    }

    const activeLanguages = languageRouter.getActiveLanguages(roomName) || [];

    // If no active students need translation, don't do anything to save costs
    if (activeLanguages.length === 0) {
      return res.json({ transcript: "", translations: {}, audioUrls: {} });
    }

    // 1. STT
    const transcription = await STTService.transcribe(audioBuffer, req.file.mimetype);
    const transcriptText = transcription.text;

    if (!transcriptText || transcriptText.trim() === '') {
      return res.json({ transcript: "", translations: {}, audioUrls: {} });
    }

    const translations = {};
    const audioBuffers = {};

    // 2. Translate and 3. TTS for each active language
    await Promise.all(activeLanguages.map(async (lang) => {
      try {
        const translatedText = await TranslationService.translate(transcriptText, lang);
        translations[lang] = translatedText;

        const audioBuf = await TTSService.synthesize(translatedText, lang);
        audioBuffers[lang] = audioBuf.toString('base64');
      } catch (err) {
        console.error(`Error processing language ${lang}:`, err);
      }
    }));

    res.json({
      transcript: transcriptText,
      translations,
      audioBase64: audioBuffers
    });

  } catch (error) {
    console.error("Translation Gateway Error:", error);
    res.status(500).json({ error: "Translation processing failed" });
  }
});

// Endpoint for students to announce their language preference
router.post('/set-language', (req, res) => {
  const { roomName, studentId, language } = req.body;
  if (!roomName || !studentId || !language) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  languageRouter.addStudent(roomName, studentId, language);
  const teacherDetails = languageRouter.getTeacherAudioLanguage(roomName);

  res.json({
    success: true,
    activeLanguages: languageRouter.getActiveLanguages(roomName),
    teacherAudioLanguage: teacherDetails.language,
    teacherLanguageDetails: teacherDetails
  });
});

router.post('/remove-student', (req, res) => {
  const { roomName, studentId } = req.body;
  languageRouter.removeStudent(roomName, studentId);
  const teacherDetails = languageRouter.getTeacherAudioLanguage(roomName);

  res.json({
    success: true,
    activeLanguages: languageRouter.getActiveLanguages(roomName),
    teacherAudioLanguage: teacherDetails.language
  });
});

router.post('/prepare-package', async (req, res) => {
  const { roomName, answerId, canonicalAnswer, isDirectResponse, speakerName, questionText, bufferMs } = req.body;
  if (!canonicalAnswer) {
    return res.status(400).json({ error: "canonicalAnswer is required" });
  }

  try {
    const packagePayload = await multilingualOrchestrator.prepareMultilingualPackage(
      roomName || "default-room",
      answerId || `ans-${Date.now()}`,
      canonicalAnswer,
      isDirectResponse || false,
      speakerName || "Student",
      questionText || "",
      bufferMs || 2500
    );
    res.json(packagePayload);
  } catch (error) {
    console.error("Multilingual Package Error:", error);
    res.status(500).json({ error: "Failed to generate multilingual package" });
  }
});

// Endpoint for hand-raise audio localized per student receiver
router.post('/hand-raise-audio', async (req, res) => {
  const { roomName, studentName, lang } = req.body;
  const normLang = normalizeLanguage(lang) || 'ta'; // Prefer Tamil if unspecified
  const name = studentName || 'Student';

  console.log(`[HAND RAISE AUDIO REQUEST] Receiver Lang: ${normLang}, Hand-Raiser: ${name}, Room: ${roomName || 'default'}`);

  const baseMessage = `${name}, did you have any doubt? If yes, click the Ask Doubt button and ask your doubt.`;

  const staticPrompts = {
    'ta': `${name}, உங்களுக்கு ஏதாவது doubt இருக்கா? அப்படி இருந்தா Ask Doubt button click பண்ணி உங்க doubt கேளுங்க.`,
    'ml': `${name}, നിങ്ങൾക്ക് എന്തെങ്കിലും doubt ഉണ്ടോ? ഉണ്ടെങ്കിൽ Ask Doubt button ക്ലിക്ക് ചെയ്ത് നിങ്ങളുടെ doubt ചോദിക്കുക.`,
    'hi': `${name}, क्या आपका कोई doubt है? अगर है तो Ask Doubt button पर click करके अपना doubt पूछें.`,
    'te': `${name}, మీకు ఏదైనా doubt ఉందా? ఉంటే Ask Doubt button పై click చేసి మీ doubt అడగండి.`,
    'kn': `${name}, ನಿಮಗೆ ಯಾವುದಾದರೂ doubt ಇದೆಯಾ? ಇದ್ದರೆ Ask Doubt button ಕ್ಲಿಕ್ ಮಾಡಿ ನಿಮ್ಮ doubt ಕೇಳಿ.`,
    'en': `${name}, do you have any doubt? If so, click the Ask Doubt button and ask your doubt.`
  };

  try {
    let translatedText = staticPrompts[normLang];
    if (!translatedText) {
      try {
        translatedText = await TranslationService.translate(baseMessage, normLang);
      } catch (err) {
        console.warn(`⚠️ [HAND RAISE AUDIO] Translation error for ${normLang}`);
        translatedText = staticPrompts['ta'] || baseMessage;
      }
    }

    const ttsBuffer = await TTSService.synthesize(translatedText, normLang);
    res.set("Content-Type", "audio/mpeg");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(ttsBuffer);
  } catch (error) {
    console.error(`❌ [HAND RAISE AUDIO ERROR] Failed for lang ${normLang}:`, error);
    res.status(500).json({ error: "Failed to generate hand raise audio" });
  }
});

router.post('/hand-raise-package', async (req, res) => {
  const { roomName, studentName } = req.body;
  try {
    const pkg = await multilingualOrchestrator.prepareHandRaisePackage(
      roomName || "default-room",
      studentName || "Student"
    );
    res.json(pkg);
  } catch (error) {
    console.error("Hand Raise Package Error:", error);
    res.status(500).json({ error: "Failed to generate hand raise package" });
  }
});

module.exports = router;
