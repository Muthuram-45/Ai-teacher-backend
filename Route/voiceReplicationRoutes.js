const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { GoogleAuth } = require("google-auth-library");
const { spawn } = require("child_process");
const fs = require("fs");
const {
  mkdir,
  readFile,
  mkdtemp,
  rm,
  writeFile
} = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const VoiceStore = require("../utils/voiceStore");
const { normalizeLanguage, selectTeacherLanguage } = require("../Multilingual/teacherLanguageSelector");
const languageRouter = require("../Multilingual/languageRouter");

const router = express.Router();

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "sky-meet-01";
const LOCATION = process.env.VOICE_REPLICATION_LOCATION || "global";
const MODEL = "gemini-3.8-flash-tts";

const STYLE_IN_TEXT = process.env.STYLE_IN_TEXT === "true";
const USE_EMOTION_TAGS = process.env.USE_EMOTION_TAGS === "true";

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");

if (!ffmpegPath) {
  console.error("⚠️ FFmpeg binary not found. Check ffmpeg-static installation.");
}

// Multer memory storage for reference and consent recordings
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB max
    files: 2
  }
});

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});

async function googleFetch(url, options = {}) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  if (!token?.token) {
    throw new Error(
      "Google Cloud authentication failed. Verify service account credentials in GOOGLE_APPLICATION_CREDENTIALS."
    );
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    console.error("Google API error:", JSON.stringify(data, null, 2));
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Google API request failed with HTTP ${response.status}`
    );
  }

  return data;
}

// ==========================================
// LANGUAGE DETECTION & EMOTION PRESETS
// ==========================================

function mapCanonicalToTTSLanguage(canonical) {
  const norm = normalizeLanguage(canonical);
  if (norm === "ta") return "tamil";
  if (norm === "ml") return "malayalam";
  if (norm === "hi") return "hindi";
  if (norm === "te") return "telugu";
  if (norm === "kn") return "kannada";
  if (norm === "en") return "english";
  return norm || "english";
}

function detectLanguage(requested, text, roomName) {
  // 1. If roomName is provided and language was 'auto' or empty, resolve teacher language from room students
  if ((!requested || requested === "auto") && roomName) {
    const teacherSelection = languageRouter.getTeacherAudioLanguage(roomName);
    if (teacherSelection.language) {
      return mapCanonicalToTTSLanguage(teacherSelection.language);
    }
  }

  // 2. Normalize requested language code (e.g. 'ta-IN', 'Tamil', 'ml', 'hi')
  const norm = normalizeLanguage(requested);
  if (norm) {
    return mapCanonicalToTTSLanguage(norm);
  }

  // 3. Detect native script in text
  if (/[\u0B80-\u0BFF]/.test(text)) return "tamil";
  if (/[\u0D00-\u0D7F]/.test(text)) return "malayalam";
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/[\u0C00-\u0C7F]/.test(text)) return "telugu";
  if (/[\u0C80-\u0CFF]/.test(text)) return "kannada";

  // 4. If room has active students, resolve from room students
  if (roomName) {
    const teacherSelection = languageRouter.getTeacherAudioLanguage(roomName);
    if (teacherSelection.language) {
      return mapCanonicalToTTSLanguage(teacherSelection.language);
    }
  }

  // 5. Documented default if configured, otherwise fallback to english with warning
  if (process.env.DEFAULT_SESSION_LANGUAGE) {
    return mapCanonicalToTTSLanguage(process.env.DEFAULT_SESSION_LANGUAGE);
  }
  return "english";
}

const EMOTION_PRESETS = {
  warm: {
    description:
      "Warm, friendly and genuinely engaged, with a gentle smile in the voice. " +
      "Sound like you enjoy explaining this and care that the listener understands.",
    tag: "[warmly]"
  },
  confident: {
    description:
      "Confident, bold and commanding. Strong, firm voice with full authority, " +
      "like an experienced teacher who knows the subject completely.",
    tag: "[confidently]"
  },
  excited: {
    description:
      "Energetic, enthusiastic and upbeat, with bright rising intonation. " +
      "Sound thrilled to share this, like discovering something cool together.",
    tag: "[excited]"
  },
  encouraging: {
    description:
      "Supportive, positive and reassuring, like a teacher cheering a student on. " +
      "Lift the voice on praise and sound proud and kind.",
    tag: "[encouraging]"
  },
  calm: {
    description:
      "Calm, soothing and gentle, with soft, slow-flowing intonation. " +
      "Relaxed and patient, but still alive and expressive, never flat.",
    tag: "[calmly]"
  },
  serious: {
    description:
      "Serious, focused and emphatic. Lower, steady tone with firm stress on " +
      "important words, as when warning about a common mistake.",
    tag: "[seriously]"
  },
  storytelling: {
    description:
      "Expressive storyteller. Change pace and pitch with the drama of each moment, " +
      "build curiosity, slow down for suspense and lighten up for fun parts.",
    tag: "[dramatic]"
  },
  sad: {
    description:
      "Soft, heavy and sorrowful. Lower pitch, slower pace, slight breathiness, " +
      "with a feeling of holding back emotion.",
    tag: "[sadly]"
  },
  playful: {
    description:
      "Light, playful and amused, with a teasing smile in the voice and quick, " +
      "bouncy rhythm. A little humour in the delivery.",
    tag: "[playfully]"
  }
};

const INTENSITY_TEXT = {
  low: "Keep the emotion subtle and natural.",
  medium: "Show the emotion clearly in the voice.",
  high: "Make the emotion very strong and clearly audible, with big changes in pitch, volume and pace."
};

function buildHindiStyleInstruction(emotionKey, intensityKey) {
  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.confident;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.high;

  return [
    "Speak as a confident, bold and authoritative teacher explaining a lesson in natural spoken Hindi mixed with common English technical words, the way teachers from Bihar speak.",
    "Use a natural Bihari-accented Hindi with the rhythm and intonation of the Bihar region. Keep it natural, not exaggerated and not a caricature. Do not use a South Indian accent.",
    "Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Speak with full confidence and strong projection, like an experienced teacher who knows the subject completely. Never sound shy, hesitant, uncertain or like a beginner.",
    "Use a firm, steady, powerful voice. Deliver statements as facts, ending sentences with a strong, settled, falling tone instead of a tentative rising tone.",
    "Put heavy stress on key words and important points. Use short, punchy phrasing with a brisk, decisive pace.",
    "Do not add filler sounds such as umm, hmm or ah, and do not trail off at the end of sentences.",
    "Pause only briefly for emphasis, then continue boldly.",
    "Speak only the supplied text. Do not read out any instructions or bracketed tags."
  ].join(" ");
}

function buildTamilStyleInstruction(emotionKey, intensityKey) {
  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.medium;

  return [
    "Speak as a friendly, clear teacher explaining a lesson in natural spoken Tamil, mixed with common English technical words where needed.",
    "Use natural Tamil pronunciation and intonation. Keep it natural, not exaggerated. Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Use a clear, expressive voice with natural pitch variation. Stress the important words in each sentence.",
    "Do NOT add any filler or hesitation sounds such as umm, hmm, mmm, ah or aaa. Do not trail off at the end of sentences.",
    "Speak fluently and smoothly, with only short natural pauses between ideas.",
    "Speak only the supplied text. Do not read out any instructions or bracketed tags."
  ].join(" ");
}

function buildMalayalamStyleInstruction(emotionKey, intensityKey) {
  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.medium;

  return [
    "Speak as a friendly, clear teacher explaining a lesson in natural spoken Malayalam, mixed with common English technical words where needed.",
    "Use natural Malayalam pronunciation and intonation. Keep it natural, not exaggerated. Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Use a clear, expressive voice with natural pitch variation. Stress the important words in each sentence.",
    "Do NOT add any filler or hesitation sounds. Do not trail off at the end of sentences.",
    "Speak fluently and smoothly, with only short natural pauses between ideas.",
    "Speak only the supplied text. Do not read out any instructions or bracketed tags."
  ].join(" ");
}

function buildTeluguStyleInstruction(emotionKey, intensityKey) {
  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.medium;

  return [
    "Speak as a friendly, clear teacher explaining a lesson in natural spoken Telugu, mixed with common English technical words where needed.",
    "Use natural Telugu pronunciation and intonation. Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Use a clear, expressive voice. Stress important terms.",
    "Speak only the supplied text."
  ].join(" ");
}

function buildKannadaStyleInstruction(emotionKey, intensityKey) {
  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.medium;

  return [
    "Speak as a friendly, clear teacher explaining a lesson in natural spoken Kannada, mixed with common English technical words where needed.",
    "Use natural Kannada pronunciation and intonation. Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Use a clear, expressive voice. Stress important terms.",
    "Speak only the supplied text."
  ].join(" ");
}

function buildStyleInstruction(deliveryStyle, emotionKey, intensityKey, language) {
  if (language === "hindi") {
    return buildHindiStyleInstruction(emotionKey, intensityKey);
  }
  if (language === "tamil") {
    return buildTamilStyleInstruction(emotionKey, intensityKey);
  }
  if (language === "malayalam") {
    return buildMalayalamStyleInstruction(emotionKey, intensityKey);
  }
  if (language === "telugu") {
    return buildTeluguStyleInstruction(emotionKey, intensityKey);
  }
  if (language === "kannada") {
    return buildKannadaStyleInstruction(emotionKey, intensityKey);
  }

  const emotion = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;
  const intensity = INTENSITY_TEXT[intensityKey] || INTENSITY_TEXT.medium;

  if (deliveryStyle !== "teacher") {
    return [
      "Speak naturally and conversationally, like a real person talking, not reading.",
      emotion.description,
      intensity,
      "Speak only the supplied text."
    ].join(" ");
  }

  return [
    "Speak as a friendly computer science teacher explaining a lesson to beginners in an online class.",
    "Keep the cloned speaker's own voice and timbre.",
    `Emotion: ${emotion.description}`,
    intensity,
    "Do NOT sound like someone reading a book or an announcer. Sound like a real person talking live to students.",
    "Use a wide, expressive pitch range. Raise the pitch and energy on key words, important terms and good news.",
    "Stress the important word in each sentence. Let the voice rise on questions and fall softly at the end of statements.",
    "React emotionally to the content: sound curious at questions, pleased at good results, careful at warnings, amused at funny examples.",
    "Vary speed naturally: slightly faster on easy parts, slower on definitions and important points.",
    "Pause briefly between ideas and wait a moment after questions.",
    "Read hesitation sounds such as umm, hmm and ah softly and naturally, as a quick thought, not as emphasized words.",
    "Speak only the supplied text. Do not read out any instructions or bracketed tags."
  ].join(" ");
}

// ==========================================
// AUDIO CONVERSION (FFMPEG PIPELINE)
// ==========================================

async function runFfmpeg(args, description) {
  if (!ffmpegPath) {
    throw new Error("FFmpeg executable not available. Check ffmpeg-static installation.");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    const errors = [];
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);

    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(
          `${description}: ${Buffer.concat(errors).toString("utf8")}`
        ));
      } else {
        resolve();
      }
    });
  });
}

async function convertToRequiredWav(inputBuffer) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "voice-replication-")
  );

  const inputPath = path.join(tempDir, "input.audio");
  const outputPath = path.join(tempDir, "output.wav");

  try {
    await writeFile(inputPath, inputBuffer);

    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "24000",
      "-c:a", "pcm_s16le", "-f", "wav", outputPath
    ], "Input audio conversion failed");

    const wav = await readFile(outputPath);

    if (
      wav.length < 44 ||
      wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("FFmpeg did not produce a valid WAV file.");
    }

    return wav;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertWavToMp3(inputBuffer, tempo = 0.96) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "voice-replication-mp3-")
  );

  const inputPath = path.join(tempDir, "input.wav");
  const outputPath = path.join(tempDir, "output.mp3");

  const t = Math.min(1.1, Math.max(0.85, tempo));

  const filters = [
    `atempo=${t}`,
    "highpass=f=70",
    "loudnorm=I=-18:TP=-1.5:LRA=14"
  ].join(",");

  try {
    await writeFile(inputPath, inputBuffer);

    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-vn",
      "-af", filters,
      "-codec:a", "libmp3lame",
      "-b:a", "128k",
      "-ar", "24000",
      "-ac", "1",
      outputPath
    ], "MP3 conversion failed");

    const mp3 = await readFile(outputPath);

    if (mp3.length < 128) {
      throw new Error("The converted MP3 is empty or invalid.");
    }

    return mp3;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readAudioUpload(file, fieldName) {
  if (!file || !file.buffer) {
    throw new Error(`Please upload the ${fieldName} recording.`);
  }

  const wav = await convertToRequiredWav(file.buffer);

  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bitsPerSample = wav.readUInt16LE(34);

  console.log(`[Voice Replication] ${fieldName}:`, {
    sampleRate,
    channels,
    bitsPerSample,
    bytes: wav.length
  });

  if (sampleRate !== 24000 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `${fieldName} audio must be mono, 24 kHz, 16-bit PCM WAV.`
    );
  }

  return {
    mimeType: "audio/wav",
    data: wav.toString("base64")
  };
}

// ==========================================
// HUMANIZER & TAGS
// ==========================================

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function humanizeScript(text) {
  if (/\b(umm+|hmm+|ah+)\b/i.test(text)) return text;

  const rand = seededRandom(hashSeed(text));
  const paragraphs = text.split(/\n{2,}/);

  const thinking = ["Umm...", "Hmm...", "Ah,", "Umm,", "Hmm,"];
  const connectors = ["Okay, so", "So,", "Now see,", "Okay,", "Now,"];
  const transitionStart =
    /^(so|now|let's|let us|suppose|imagine|for example|for instance|next|here|see|look)\b/i;

  let lastFiller = null;
  let sinceLast = 99;
  let fillerCount = 0;

  const pick = (list) => {
    let choice;
    let tries = 0;
    do {
      choice = list[Math.floor(rand() * list.length)];
      tries++;
    } while (choice === lastFiller && tries < 6);
    lastFiller = choice;
    return choice;
  };

  const processed = paragraphs.map((para, pIndex) => {
    const sentences =
      para.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) || [para];
    const maxInPara = Math.max(1, Math.ceil(sentences.length / 4));
    let usedInPara = 0;

    const out = sentences.map((raw, i) => {
      let s = raw.trim();
      if (!s) return s;

      const words = s.split(/\s+/).length;
      sinceLast++;

      if (/\?["')\]]*$/.test(s)) {
        s = s.replace(/\?(["')\]]*)$/, "?$1 ...");
      }

      const isFirstEver = pIndex === 0 && i === 0;
      const canInsert =
        !isFirstEver &&
        sinceLast >= 3 &&
        usedInPara < maxInPara &&
        fillerCount < 12;

      const isTransition = transitionStart.test(s);
      const isLong = words > 16;

      if (canInsert && (isTransition || isLong) && rand() < 0.65) {
        const filler = isTransition
          ? pick(thinking)
          : pick([...thinking, ...connectors]);

        const lowered = /^(I\b|[A-Z]{2,})/.test(s)
          ? s
          : s[0].toLowerCase() + s.slice(1);

        s = `${filler} ${isTransition ? s : lowered}`;
        sinceLast = 0;
        usedInPara++;
        fillerCount++;
      }

      return s;
    });

    return out.join(" ");
  });

  return processed.join(" ...\n\n");
}

function addEmotionTags(text, emotionKey) {
  const preset = EMOTION_PRESETS[emotionKey] || EMOTION_PRESETS.warm;

  return text
    .split(/\n{2,}/)
    .map(p => {
      const trimmed = p.trim();
      if (!trimmed) return trimmed;
      if (/^\[[^\]]+\]/.test(trimmed)) return trimmed;
      return `${preset.tag} ${trimmed}`;
    })
    .join("\n\n");
}

// Helper to chunk long lesson text (if > 3500 chars)
function chunkLessonText(text, maxChars = 3200) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if ((currentChunk + "\n\n" + para).trim().length <= maxChars) {
      currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      if (para.length > maxChars) {
        // Break long paragraph by sentences
        const sentences = para.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) || [para];
        let subChunk = "";
        for (const s of sentences) {
          if ((subChunk + " " + s).trim().length <= maxChars) {
            subChunk = subChunk ? `${subChunk} ${s}` : s;
          } else {
            if (subChunk) chunks.push(subChunk);
            subChunk = s;
          }
        }
        currentChunk = subChunk;
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// Single chunk speech synthesis
async function synthesizeChunk({ text, voiceId, language, deliveryStyle, emotion, intensity, useHumanizer }) {
  const url =
    "https://aiplatform.googleapis.com/v1/projects/" +
    `${encodeURIComponent(PROJECT_ID)}/locations/${LOCATION}/publishers/google/models/` +
    `${MODEL}:generateContent`;

  let spokenText = useHumanizer ? humanizeScript(text) : text;
  if (USE_EMOTION_TAGS) {
    spokenText = addEmotionTags(spokenText, emotion);
  }

  const styleInstruction = buildStyleInstruction(
    deliveryStyle,
    emotion,
    intensity,
    language
  );

  const part = STYLE_IN_TEXT
    ? { text: `${styleInstruction}\n\n${spokenText}` }
    : { text: spokenText, speechMetadata: { style: styleInstruction } };

  const result = await googleFetch(url, {
    method: "POST",
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [part]
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            voice: voiceId
          }
        }
      }
    })
  });

  const parts = result.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find(p => p.inlineData?.data);

  if (!audioPart) {
    console.error("No audio returned by Vertex AI Gemini TTS:", JSON.stringify(result));
    throw new Error("The gemini-3.8-flash-tts model returned no audio content.");
  }

  const audioBuffer = Buffer.from(audioPart.inlineData.data, "base64");
  if (
    audioBuffer.length < 44 ||
    audioBuffer.toString("ascii", 0, 4) !== "RIFF" ||
    audioBuffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Vertex AI did not return a valid WAV audio response.");
  }

  return audioBuffer;
}

// ==========================================
// ROUTES
// ==========================================

// 1. Health check
router.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "SkyMeet Voice Replication",
    model: MODEL,
    location: LOCATION,
    projectId: PROJECT_ID,
    emotions: Object.keys(EMOTION_PRESETS),
    intensities: Object.keys(INTENSITY_TEXT)
  });
});

// 2. Create Replicated Voice
router.post(
  "/create-voice",
  upload.fields([
    { name: "referenceAudio", maxCount: 1 },
    { name: "consentAudio", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const referenceFile = req.files?.referenceAudio?.[0];
      const consentFile = req.files?.consentAudio?.[0];

      const teacherEmail = String(
        req.headers["x-teacher-email"] || req.body.teacherEmail || ""
      ).trim().toLowerCase();

      const displayName = String(
        req.body.displayName || "My Replicated Voice"
      ).trim().slice(0, 100);

      const consentConfirmed = req.body.consentConfirmed === true || req.body.consentConfirmed === "true";

      if (!referenceFile || !consentFile) {
        return res.status(400).json({
          success: false,
          error: "Upload both the reference voice recording and the consent recording."
        });
      }

      if (!consentConfirmed) {
        return res.status(400).json({
          success: false,
          error: "Explicit teacher consent confirmation is required before creating a replicated voice."
        });
      }

      console.log(`🎙️ Creating replicated voice: "${displayName}" for teacher: ${teacherEmail || "default"}`);

      const [sourceAudio, consentAudio] = await Promise.all([
        readAudioUpload(referenceFile, "reference"),
        readAudioUpload(consentFile, "consent")
      ]);

      const url =
        "https://aiplatform.googleapis.com/v1beta1/projects/" +
        `${encodeURIComponent(PROJECT_ID)}/locations/${LOCATION}/voices`;

      const result = await googleFetch(url, {
        method: "POST",
        body: JSON.stringify({
          store: true,
          voice: {
            type: "VOICE_TYPE_REPLICATED",
            displayName,
            replicated: {
              sourceAudio,
              consentAudio
            }
          }
        })
      });

      const voiceId = result.id;
      if (typeof voiceId !== "string" || !voiceId.startsWith("voice_")) {
        console.error("Unexpected voice response from Google:", result);
        throw new Error("Google Vertex AI did not return a valid stored Voice ID.");
      }

      console.log("✅ Voice created successfully in Vertex AI:", voiceId);

      // Persist voice metadata for this teacher
      const savedRecord = await VoiceStore.saveVoice({
        voiceId,
        teacherEmail,
        displayName,
        description: `Voice created for ${displayName}`
      });

      return res.json({
        success: true,
        voiceId,
        displayName: savedRecord.displayName,
        teacherEmail: savedRecord.teacherEmail,
        createdAt: savedRecord.createdAt,
        message: "Voice replication completed successfully."
      });
    } catch (error) {
      console.error("❌ Create voice error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Voice creation failed."
      });
    }
  }
);

const MOHAN_VOICE_ID = "voice_74080a81-5951-4b5f-972b-72b4064d116a";

// In-flight tracking to prevent duplicate concurrent TTS generation
const inFlightTTSRequests = new Map();

function getAudioCacheKey({ text, voiceId, language, deliveryStyle, emotion, intensity, tempo }) {
  const normLang = normalizeLanguage(language) || language || "english";
  const rawKey = [
    text.trim(),
    (voiceId || MOHAN_VOICE_ID).trim(),
    normLang,
    deliveryStyle || "teacher",
    emotion || "confident",
    intensity || "medium",
    tempo || "default"
  ].join(":::");
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// Reusable function to generate speech via Gemini 3.8 Flash TTS with caching and deduplication
async function generateGeminiSpeechMp3({
  text,
  voiceId = MOHAN_VOICE_ID,
  language,
  roomName,
  deliveryStyle = "teacher",
  emotion,
  intensity,
  humanize,
  tempo
}) {
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("Enter the text you want the voice to speak.");
  }

  let cleanVoiceId = String(voiceId || MOHAN_VOICE_ID).trim();
  if (cleanVoiceId === "Mohan" || !cleanVoiceId.startsWith("voice_")) {
    cleanVoiceId = MOHAN_VOICE_ID;
  }

  const lang = detectLanguage(language, cleanText, roomName);
  const isHindi = lang === "hindi";
  const isTamil = lang === "tamil";
  const isMalayalam = lang === "malayalam";

  const emo = String(
    emotion || (isHindi ? "confident" : "warm")
  ).trim().toLowerCase();

  const inten = String(
    intensity || (isHindi ? "high" : "medium")
  ).trim().toLowerCase();

  const useHumanizer = !isHindi && !isTamil && !isMalayalam && humanize !== false;
  const requestedTempo = Number(tempo);
  const defaultTempo = (isHindi || isTamil || isMalayalam) ? 1.0 : 0.96;
  const finalTempo = requestedTempo > 0 ? requestedTempo : defaultTempo;

  // Compute deterministic audio cache key
  const cacheKey = getAudioCacheKey({
    text: cleanText,
    voiceId: cleanVoiceId,
    language: lang,
    deliveryStyle,
    emotion: emo,
    intensity: inten,
    tempo: finalTempo
  });

  const cachedFilename = `cache_${cacheKey}.mp3`;
  const cachedFilepath = path.join(GENERATED_DIR, cachedFilename);

  // 1. Check disk cache for existing audio (avoid redundant TTS generation)
  if (fs.existsSync(cachedFilepath)) {
    try {
      const mp3Buffer = await readFile(cachedFilepath);
      console.log(`⚡ [TTS Cache Hit] Reused cached audio: ${cachedFilename} (${lang})`);
      return {
        mp3Buffer,
        filename: cachedFilename,
        audioUrl: `/generated/${cachedFilename}`,
        voiceId: cleanVoiceId,
        language: lang,
        emotion: emo,
        intensity: inten,
        model: MODEL,
        cached: true
      };
    } catch (readErr) {
      console.warn("⚠️ Failed reading cached file, regenerating:", readErr.message);
    }
  }

  // 2. In-flight request deduplication (protects against simultaneous retries/reconnects)
  if (inFlightTTSRequests.has(cacheKey)) {
    console.log(`🔄 [TTS Deduplication] Awaiting existing in-flight TTS generation for key: ${cacheKey.slice(0, 8)}`);
    return await inFlightTTSRequests.get(cacheKey);
  }

  const doSynthesis = async () => {
    console.log(
      `🗣️ [Gemini 3.8 Flash TTS] Synthesizing speech with voice ${cleanVoiceId} | Lang: ${lang} | Emotion: ${emo} | Length: ${cleanText.length} chars`
    );

    const chunks = chunkLessonText(cleanText, 3500);
    let finalWavBuffer;

    if (chunks.length === 1) {
      finalWavBuffer = await synthesizeChunk({
        text: chunks[0],
        voiceId: cleanVoiceId,
        language: lang,
        deliveryStyle,
        emotion: emo,
        intensity: inten,
        useHumanizer
      });
    } else {
      const wavBuffers = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkWav = await synthesizeChunk({
          text: chunks[i],
          voiceId: cleanVoiceId,
          language: lang,
          deliveryStyle,
          emotion: emo,
          intensity: inten,
          useHumanizer
        });
        wavBuffers.push(chunkWav);
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), "voice-concat-"));
      const concatListPath = path.join(tempDir, "files.txt");
      const outConcatWav = path.join(tempDir, "combined.wav");

      try {
        const fileLines = [];
        for (let i = 0; i < wavBuffers.length; i++) {
          const filePath = path.join(tempDir, `chunk_${i}.wav`);
          await writeFile(filePath, wavBuffers[i]);
          fileLines.push(`file '${filePath.replace(/\\/g, "/")}'`);
        }
        await writeFile(concatListPath, fileLines.join("\n"));

        await runFfmpeg([
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "concat", "-safe", "0",
          "-i", concatListPath,
          "-c", "copy",
          outConcatWav
        ], "Combining audio chunks failed");

        finalWavBuffer = await readFile(outConcatWav);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    await mkdir(GENERATED_DIR, { recursive: true });
    const mp3Buffer = await convertWavToMp3(finalWavBuffer, finalTempo);

    // Save with deterministic cache filename
    await writeFile(cachedFilepath, mp3Buffer);

    return {
      mp3Buffer,
      filename: cachedFilename,
      audioUrl: `/generated/${cachedFilename}`,
      voiceId: cleanVoiceId,
      language: lang,
      emotion: emo,
      intensity: inten,
      model: MODEL,
      cached: false
    };
  };

  const generationPromise = doSynthesis().finally(() => {
    inFlightTTSRequests.delete(cacheKey);
  });

  inFlightTTSRequests.set(cacheKey, generationPromise);
  return await generationPromise;
}

// 3. Generate Speech with Gemini 3.8 Flash TTS
router.post("/generate-speech", async (req, res) => {
  try {
    let text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({
        success: false,
        error: "Enter the text you want the voice to speak."
      });
    }

    let voiceId = String(req.body?.voiceId || MOHAN_VOICE_ID).trim();
    if (voiceId !== "Mohan" && !voiceId.startsWith("voice_")) {
      return res.status(400).json({
        success: false,
        error: "Invalid voiceId format. Voice ID must start with 'voice_'."
      });
    }
    if (voiceId === "Mohan") {
      voiceId = MOHAN_VOICE_ID;
    }

    const roomName = req.body?.roomName;
    let language = req.body?.language;

    // If language is 'auto' or unspecified, resolve based on room students
    if ((!language || language === "auto") && roomName) {
      const teacherSelection = languageRouter.getTeacherAudioLanguage(roomName);
      if (teacherSelection.language) {
        language = teacherSelection.language;
      }
    }

    // Optional translation before generation if requested
    if (req.body?.translateIfNeeded && language && language !== "en" && language !== "english") {
      try {
        const { TranslationService } = require("../Multilingual/services");
        const normLang = normalizeLanguage(language) || language;
        text = await TranslationService.translate(text, normLang);
      } catch (transErr) {
        console.warn("⚠️ Translation before speech generation failed, using original text:", transErr.message);
      }
    }

    const result = await generateGeminiSpeechMp3({
      text,
      voiceId,
      language,
      roomName,
      deliveryStyle: req.body?.deliveryStyle,
      emotion: req.body?.emotion,
      intensity: req.body?.intensity,
      humanize: req.body?.humanize,
      tempo: req.body?.tempo
    });

    return res.json({
      success: true,
      audioUrl: result.audioUrl,
      audioType: "audio/mpeg",
      filename: result.filename,
      model: result.model,
      voiceId: result.voiceId,
      language: result.language,
      emotion: result.emotion,
      intensity: result.intensity,
      cached: result.cached || false,
      message: result.cached
        ? "Reused cached audio file (zero extra TTS API cost)."
        : "Speech generated successfully as MP3 using Gemini 3.8 Flash TTS."
    });

  } catch (error) {
    console.error("❌ Generate speech error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Speech generation failed."
    });
  }
});

// 4. List Voices for Teacher
router.get("/voices", async (req, res) => {
  try {
    const teacherEmail = String(
      req.headers["x-teacher-email"] || req.query.teacherEmail || ""
    ).trim().toLowerCase();

    const voices = await VoiceStore.getVoicesForTeacher(teacherEmail);
    return res.json({
      success: true,
      voices
    });
  } catch (error) {
    console.error("❌ List voices error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to list voices."
    });
  }
});

// 5. Delete Voice
router.delete("/voices/:voiceId", async (req, res) => {
  try {
    const { voiceId } = req.params;
    const teacherEmail = String(
      req.headers["x-teacher-email"] || req.query.teacherEmail || req.body.teacherEmail || ""
    ).trim().toLowerCase();

    const removed = await VoiceStore.deleteVoice(voiceId, teacherEmail);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: "Voice not found or you are not authorized to delete it."
      });
    }

    return res.json({
      success: true,
      message: "Voice record deleted successfully."
    });
  } catch (error) {
    console.error("❌ Delete voice error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to delete voice."
    });
  }
});

router.generateGeminiSpeechMp3 = generateGeminiSpeechMp3;
router.MOHAN_VOICE_ID = MOHAN_VOICE_ID;
module.exports = router;
