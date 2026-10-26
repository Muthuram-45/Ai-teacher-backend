require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

async function runTests() {
  console.log("=================================================");
  console.log(" SkyMeet Voice Replication Test Suite");
  console.log(" Model: gemini-3.8-flash-tts");
  console.log("=================================================\n");

  const results = {
    passed: 0,
    failed: 0,
    details: []
  };

  function record(name, pass, msg = '') {
    if (pass) {
      console.log(`✅ PASS: ${name} ${msg ? '(' + msg + ')' : ''}`);
      results.passed++;
    } else {
      console.error(`❌ FAIL: ${name} - ${msg}`);
      results.failed++;
    }
    results.details.push({ name, pass, msg });
  }

  const BASE_URL = 'http://localhost:8081';

  // Test 1: Main health check
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    record("SkyMeet Backend /health endpoint", res.ok && data.success, data.message);
  } catch (e) {
    record("SkyMeet Backend /health endpoint", false, e.message);
  }

  // Test 2: Voice replication health check
  try {
    const res = await fetch(`${BASE_URL}/api/voice-replication/health`);
    const data = await res.json();
    record(
      "Voice Replication /api/voice-replication/health",
      res.ok && data.model === "gemini-3.8-flash-tts" && data.location === "global",
      `Model: ${data.model}, Location: ${data.location}`
    );
  } catch (e) {
    record("Voice Replication /api/voice-replication/health", false, e.message);
  }

  // Test 3: List voices endpoint - Mohan must be the only voice
  try {
    const res = await fetch(`${BASE_URL}/list-voices`);
    const data = await res.json();
    const isMohanOnly = Array.isArray(data.voices) && data.voices.length === 1 && data.voices[0] === "Mohan";
    const hasCorrectVoiceId = data.voiceId === "voice_74080a81-5951-4b5f-972b-72b4064d116a";
    record(
      "SkyMeet /list-voices exposes Mohan as exclusive voice with gemini-3.8-flash-tts ID",
      res.ok && isMohanOnly && hasCorrectVoiceId,
      `Voices: ${JSON.stringify(data.voices)}, VoiceId: ${data.voiceId}`
    );
  } catch (e) {
    record("SkyMeet /list-voices exposes Mohan as exclusive voice", false, e.message);
  }

  // Test 3b: Active voice endpoint
  try {
    const res = await fetch(`${BASE_URL}/active-voice`);
    const data = await res.json();
    record(
      "SkyMeet /active-voice returns Mohan and voice_74080a81-5951-4b5f-972b-72b4064d116a",
      res.ok && data.activeVoice === "Mohan" && data.voiceId === "voice_74080a81-5951-4b5f-972b-72b4064d116a",
      `Active: ${data.activeVoice}, VoiceId: ${data.voiceId}`
    );
  } catch (e) {
    record("SkyMeet /active-voice endpoint", false, e.message);
  }

  // Test 4: Validation - Missing audio files on create-voice
  try {
    const res = await fetch(`${BASE_URL}/api/voice-replication/create-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: "Test Voice" })
    });
    const data = await res.json();
    record(
      "Validation: Missing audio returns 400 Bad Request",
      res.status === 400 && !data.success,
      data.error
    );
  } catch (e) {
    record("Validation: Missing audio returns 400 Bad Request", false, e.message);
  }

  // Test 5: Validation - Missing consent flag on create-voice
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('displayName', 'Test');
    form.append('referenceAudio', Buffer.from('dummy'), { filename: 'ref.wav' });
    form.append('consentAudio', Buffer.from('dummy'), { filename: 'consent.wav' });
    // Intentionally no consentConfirmed: true

    const res = await fetch(`${BASE_URL}/api/voice-replication/create-voice`, {
      method: 'POST',
      body: form.getBuffer(),
      headers: form.getHeaders()
    });
    const data = await res.json();
    record(
      "Security: Missing explicit consent confirmation returns 400",
      res.status === 400 && data.error?.includes("consent"),
      data.error
    );
  } catch (e) {
    record("Security: Missing explicit consent confirmation returns 400", false, e.message);
  }

  // Test 6: Validation - Invalid voiceId format on generate-speech
  try {
    const res = await fetch(`${BASE_URL}/api/voice-replication/generate-speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "Hello class",
        voiceId: "invalid_id_format"
      })
    });
    const data = await res.json();
    record(
      "Validation: Invalid voiceId (not starting with voice_) returns 400",
      res.status === 400 && !data.success,
      data.error
    );
  } catch (e) {
    record("Validation: Invalid voiceId returns 400", false, e.message);
  }

  // Test 7: Validation - Empty text on generate-speech
  try {
    const res = await fetch(`${BASE_URL}/api/voice-replication/generate-speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "",
        voiceId: "voice_validformat123"
      })
    });
    const data = await res.json();
    record(
      "Validation: Empty text returns 400",
      res.status === 400 && !data.success,
      data.error
    );
  } catch (e) {
    record("Validation: Empty text returns 400", false, e.message);
  }

  // Test 8: Voice Store persistence and teacher isolation
  try {
    const VoiceStore = require('./utils/voiceStore');
    const testVoiceId = `voice_test_${Date.now()}`;
    await VoiceStore.saveVoice({
      voiceId: testVoiceId,
      teacherEmail: 'tutor@skymeet.com',
      displayName: 'Tutor Replicated Voice',
      description: 'Test description'
    });

    const tutorVoices = await VoiceStore.getVoicesForTeacher('tutor@skymeet.com');
    const saraVoices = await VoiceStore.getVoicesForTeacher('sara@skymeet.com');
    
    const tutorHasVoice = tutorVoices.some(v => v.voiceId === testVoiceId);
    const saraHasVoice = saraVoices.some(v => v.voiceId === testVoiceId);

    const authForTutor = await VoiceStore.isAuthorized('tutor@skymeet.com', testVoiceId);
    const authForSara = await VoiceStore.isAuthorized('sara@skymeet.com', testVoiceId);

    record(
      "Security & Isolation: Replicated voices isolated by teacher email",
      tutorHasVoice && !saraHasVoice && authForTutor && !authForSara,
      `Tutor authorized: ${authForTutor}, Sara authorized: ${authForSara}`
    );

    // Clean up test voice
    await VoiceStore.deleteVoice(testVoiceId, 'tutor@skymeet.com');
  } catch (e) {
    record("Security & Isolation: Replicated voices isolated by teacher email", false, e.message);
  }

  // Test 9: FFmpeg audio conversion pipeline
  try {
    const tempDir = path.join(__dirname, 'data', 'test_audio');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const genWavPath = path.join(tempDir, 'test_source.wav');
    // Generate a 1-second 24kHz tone with FFmpeg
    spawnSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', genWavPath
    ]);

    const generated = fs.existsSync(genWavPath) && fs.statSync(genWavPath).size > 1000;
    record(
      "Audio Pipeline: FFmpeg binary available and can process 24kHz PCM WAV",
      generated,
      `WAV size: ${generated ? fs.statSync(genWavPath).size : 0} bytes`
    );

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  } catch (e) {
    record("Audio Pipeline: FFmpeg binary available", false, e.message);
  }

  // Test 10: Google Vertex AI Authentication & Configuration
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'sky-meet-01';
    record(
      "Google Vertex AI: Application Default Credentials & Token generated",
      Boolean(token?.token),
      `Project: ${projectId}, Token Length: ${token?.token?.length}`
    );
  } catch (e) {
    record("Google Vertex AI: Application Default Credentials", false, e.message);
  }

  console.log("\n=================================================");
  console.log(` Summary: ${results.passed} Passed, ${results.failed} Failed`);
  console.log("=================================================");

  process.exit(results.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
