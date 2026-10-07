const express = require('express');
const multer = require('multer');
const { STTService, TranslationService, TTSService } = require('./services');
const languageRouter = require('./languageRouter');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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
    const audioBuffers = {}; // We can send buffers back as base64, or store them and send URLs

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
  res.json({ success: true, activeLanguages: languageRouter.getActiveLanguages(roomName) });
});

router.post('/remove-student', (req, res) => {
  const { roomName, studentId } = req.body;
  languageRouter.removeStudent(roomName, studentId);
  res.json({ success: true });
});

const multilingualOrchestrator = require('./multilingualOrchestrator');

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
  const targetLang = lang || 'en';
  const name = studentName || 'Student';

  console.log(`[HAND RAISE AUDIO REQUEST] Receiver Lang: ${targetLang}, Hand-Raiser: ${name}, Room: ${roomName || 'default'}`);

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
    let translatedText = staticPrompts[targetLang];
    if (!translatedText) {
      try {
        translatedText = await TranslationService.translate(baseMessage, targetLang);
      } catch (err) {
        console.warn(`⚠️ [HAND RAISE AUDIO] Translation error for ${targetLang}, falling back to English prompt`);
        translatedText = staticPrompts['en'];
      }
    }

    const ttsBuffer = await TTSService.synthesize(translatedText, targetLang);
    res.set("Content-Type", "audio/mpeg");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(ttsBuffer);
  } catch (error) {
    console.error(`❌ [HAND RAISE AUDIO ERROR] Failed for lang ${targetLang}:`, error);
    try {
      const fallbackText = staticPrompts['en'];
      const ttsBuffer = await TTSService.synthesize(fallbackText, 'en');
      res.set("Content-Type", "audio/mpeg");
      res.set("Access-Control-Allow-Origin", "*");
      return res.send(ttsBuffer);
    } catch (fbErr) {
      res.status(500).json({ error: "Failed to generate hand raise audio" });
    }
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
