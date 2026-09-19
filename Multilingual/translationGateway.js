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

module.exports = router;
