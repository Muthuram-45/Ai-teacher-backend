const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VOICES_FILE = path.join(DATA_DIR, 'teacher_voices.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn("⚠️ Could not create data dir:", err.message);
  }
}

// In-memory cache loaded from disk
let voicesCache = [];

const MOHAN_VOICE_ID = "voice_74080a81-5951-4b5f-972b-72b4064d116a";

function loadVoicesFromDisk() {
  try {
    if (fs.existsSync(VOICES_FILE)) {
      const raw = fs.readFileSync(VOICES_FILE, 'utf8');
      voicesCache = JSON.parse(raw);
    } else {
      voicesCache = [];
    }
  } catch (err) {
    console.error("❌ Failed to read teacher_voices.json:", err.message);
    voicesCache = [];
  }

  // Ensure Mohan is always available
  let mohanEntry = voicesCache.find(v => v.voiceId === MOHAN_VOICE_ID || v.displayName === "Mohan");
  if (!mohanEntry) {
    mohanEntry = {
      voiceId: MOHAN_VOICE_ID,
      displayName: "Mohan",
      teacherEmail: "default_teacher",
      description: "Mohan Replicated Voice via Gemini 3.8 Flash TTS",
      sampleRate: 24000,
      model: "gemini-3.8-flash-tts",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    voicesCache.unshift(mohanEntry);
    saveVoicesToDisk();
  } else if (mohanEntry.voiceId !== MOHAN_VOICE_ID) {
    mohanEntry.voiceId = MOHAN_VOICE_ID;
    mohanEntry.displayName = "Mohan";
    saveVoicesToDisk();
  }

  return voicesCache;
}

function saveVoicesToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(VOICES_FILE, JSON.stringify(voicesCache, null, 2), 'utf8');
  } catch (err) {
    console.error("❌ Failed to write teacher_voices.json:", err.message);
  }
}

// Initialize on load
loadVoicesFromDisk();

class VoiceStore {
  /**
   * Save a replicated voice associated with a teacher.
   */
  static async saveVoice({ voiceId, teacherEmail, displayName, description, sampleRate = 24000 }) {
    if (!voiceId) throw new Error("voiceId is required");
    const email = (teacherEmail || "default_teacher").trim().toLowerCase();
    
    // Refresh from disk
    loadVoicesFromDisk();

    const existingIndex = voicesCache.findIndex(v => v.voiceId === voiceId);
    const voiceRecord = {
      voiceId,
      teacherEmail: email,
      displayName: displayName || "My Replicated Voice",
      description: description || "Teacher Replicated Voice via Gemini 3.8 Flash TTS",
      sampleRate,
      model: "gemini-3.8-flash-tts",
      createdAt: existingIndex >= 0 ? voicesCache[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      voicesCache[existingIndex] = voiceRecord;
    } else {
      voicesCache.push(voiceRecord);
    }

    saveVoicesToDisk();
    return voiceRecord;
  }

  /**
   * Retrieve all replicated voices belonging to a teacher.
   */
  static async getVoicesForTeacher(teacherEmail) {
    loadVoicesFromDisk();
    if (!teacherEmail) return voicesCache;
    const cleanEmail = teacherEmail.trim().toLowerCase();
    return voicesCache.filter(v => v.teacherEmail === cleanEmail || v.teacherEmail === "default_teacher");
  }

  /**
   * Find a specific voice by its voiceId.
   */
  static async getVoiceById(voiceId) {
    loadVoicesFromDisk();
    return voicesCache.find(v => v.voiceId === voiceId) || null;
  }

  /**
   * Check if a teacher is authorized to use a voice.
   */
  static async isAuthorized(teacherEmail, voiceId) {
    const voice = await this.getVoiceById(voiceId);
    if (!voice) {
      // If voice exists in Vertex AI but was created previously without email, allow if format valid
      return /^voice_[A-Za-z0-9_-]+$/.test(voiceId);
    }
    if (!teacherEmail) return true;
    const cleanEmail = teacherEmail.trim().toLowerCase();
    return voice.teacherEmail === cleanEmail || voice.teacherEmail === "default_teacher";
  }

  /**
   * Delete a voice record for a teacher.
   */
  static async deleteVoice(voiceId, teacherEmail) {
    loadVoicesFromDisk();
    const cleanEmail = (teacherEmail || "").trim().toLowerCase();
    const idx = voicesCache.findIndex(
      v => v.voiceId === voiceId && (!cleanEmail || v.teacherEmail === cleanEmail)
    );
    if (idx >= 0) {
      const removed = voicesCache.splice(idx, 1);
      saveVoicesToDisk();
      return removed[0];
    }
    return null;
  }

  /**
   * Return all voices.
   */
  static async getAllVoices() {
    loadVoicesFromDisk();
    return voicesCache;
  }
}

module.exports = VoiceStore;
