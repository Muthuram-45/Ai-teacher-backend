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

router.post('/translate-text', async (req, res) => {
  const { text, targetLanguage } = req.body;
  if (!text || !targetLanguage || targetLanguage === 'en') {
    return res.json({ translatedText: text });
  }
  try {
    const translated = await TranslationService.translate(text, targetLanguage);
    res.json({ translatedText: translated });
  } catch (error) {
    console.error("Text Translation Error:", error);
    res.json({ translatedText: text });
  }
});

module.exports = router;
