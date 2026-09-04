require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const { GoogleGenAI } = require("@google/genai");
const textToSpeech = require('@google-cloud/text-to-speech');
const { logTokenUsage } = require("./utils/tokenLogger");
const ttsClient = new textToSpeech.TextToSpeechClient();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Import and use upload routes
const uploadroutes = require("./Route/uploadroutes");
app.use("/api", uploadroutes);

// Import and use auth routes
const authRoutes = require("./Route/authRoutes");
app.use("/api/auth", authRoutes);

// Import and use multilingual routes
const multilingualRoutes = require("./Multilingual/translationGateway");
app.use("/api/multilingual", multilingualRoutes);

// 🔊 TTS Endpoint using Google Cloud TTS
app.post("/api/tts", async (req, res) => {
  try {
    const text = req.body.text;
    const lang = req.body.lang || 'en';
    if (!text) return res.status(400).send("Text is required");

    const localeMap = {
      'en': 'en-IN',
      'hi': 'hi-IN',
      'ml': 'ml-IN',
      'ta': 'ta-IN',
      'te': 'te-IN',
      'kn': 'kn-IN',
      'en-IN': 'en-IN'
    };
    const locale = localeMap[lang] || lang;
    const isMale = activeVoice === "Male";
    const genderSuffix = isMale ? "B" : "A"; // Wavenet-B is Male, Wavenet-A is Female in most IN locales
    
    // Construct request
    const request = {
      input: { text: text },
      // Select the language and SSML voice gender
      voice: { languageCode: locale, name: `${locale}-Wavenet-${genderSuffix}` },
      // select the type of audio encoding
      audioConfig: { audioEncoding: 'MP3' },
    };

    // Performs the text-to-speech request
    const [response] = await ttsClient.synthesizeSpeech(request);
    
    console.log(`✅ [TTS] Successfully synthesized: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);

    res.set("Content-Type", "audio/mpeg");
    res.set("Access-Control-Allow-Origin", "*"); // explicitly allow for recording mix
    res.send(response.audioContent);
  } catch (err) {
    console.error("❌ Google Cloud TTS Error:", err);
    res.status(500).send("Google Cloud TTS failed");
  }
});

const client = new GoogleGenAI({
  vertexai: process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true',
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

// 🔒 Track rooms ended by teacher (in-memory)
const endedRooms = new Set();

const fs = require("fs");
const path = require("path");

// In-memory state for waiting and blocked students
const waitingStudents = {}; // { requestId: { name, room, status: 'waiting' | 'admitted' | 'rejected', token, url } }
const blockedStudents = new Set(); // Set of "roomName:studentName" or just globally? Let's do "roomName:studentName"
let activeVoice = "Female"; // Default voice
global.activeVoice = activeVoice;

// In-memory activity summaries
const studentActivitiesData = {}; // { roomName: { studentName: { awayTime, inactiveTime, backgroundTime, warningCount } } }

// Path to voices directory
const VOICES_DIR = path.join(__dirname, "..", "Ai-teacher-voicemodel", "voices");

// Voice Management Endpoints
app.get("/list-voices", (req, res) => {
  try {
    // Return available Google Cloud TTS voice genders (Wavenet is fixed)
    res.json({ voices: ["Female", "Male"] });
  } catch (e) {
    console.error("❌ VOICES LIST ERROR:", e);
    res.status(500).json({ error: "Failed to list voices" });
  }
});

app.post("/select-voice", (req, res) => {
  const { voice } = req.body;
  if (!voice) return res.status(400).json({ error: "No voice name provided" });
  activeVoice = voice;
  global.activeVoice = voice;
  console.log(`🎤 ACTIVE VOICE SET TO: ${voice}`);
  res.json({ success: true, activeVoice });
});

app.get("/active-voice", (req, res) => {
  res.json({ activeVoice });
});

const getDeviceType = (userAgent) => {
  if (/mobile/i.test(userAgent)) return "Mobile";
  if (/tablet|ipad/i.test(userAgent)) return "Tablet";
  return "Laptop";
};

app.post("/request-join", async (req, res) => {
  const { name, room, preferredLanguage } = req.body;
  if (!name || !room) {
    return res.status(400).json({ error: "Missing name or room" });
  }

  if (blockedStudents.has(`${room}:${name}`)) {
    return res
      .status(403)
      .json({ error: "You have been blocked from this room by the teacher." });
  }

  const userAgent = req.headers["user-agent"] || "";
  const deviceType = getDeviceType(userAgent);

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  waitingStudents[requestId] = { name, room, status: "waiting", deviceType, preferredLanguage: preferredLanguage || "en" };

  console.log(`📥 JOIN REQUEST: ${name} for room ${room}. ID: ${requestId} [Device: ${deviceType}] [Lang: ${preferredLanguage || "en"}]`);
  res.json({ requestId });
});

app.get("/join-status/:requestId", (req, res) => {
  const { requestId } = req.params;
  const request = waitingStudents[requestId];

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  res.json({
    status: request.status,
    token: request.token,
    url: request.url,
    error:
      request.status === "rejected" ? "Teacher rejected your request." : null,
  });

  // Clean up if admitted or rejected
  if (request.status === "admitted" || request.status === "rejected") {
    // We could clean up here, but let's keep it for a bit just in case of retry
    // setTimeout(() => delete waitingStudents[requestId], 60000);
  }
});

app.get("/waiting-students/:room", (req, res) => {
  const { room } = req.params;
  const list = Object.entries(waitingStudents)
    .filter(([id, req]) => req.room === room && req.status === "waiting")
    .map(([id, req]) => ({ id, name: req.name }));
  res.json({ waiting: list });
});

app.post("/admit-student", async (req, res) => {
  const { requestId } = req.body;
  const request = waitingStudents[requestId];

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  try {
    // Generate token for the student
    const metadata = { role: "student", device: request.deviceType || "Laptop", preferredLanguage: request.preferredLanguage || "en" };
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: request.name,
        metadata: JSON.stringify(metadata),
      },
    );

    at.addGrant({
      roomJoin: true,
      room: request.room,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const jwt = await at.toJwt();
    request.status = "admitted";
    request.token = jwt;
    request.url = process.env.LIVEKIT_URL;

    console.log(`✅ STUDENT ADMITTED: ${request.name} to ${request.room}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ ADMISSION ERROR:", e);
    res.status(500).json({ error: "Failed to admit student" });
  }
});

app.post("/reject-student", (req, res) => {
  const { requestId } = req.body;
  const request = waitingStudents[requestId];
  if (request) {
    request.status = "rejected";
    console.log(`❌ STUDENT REJECTED: ${request.name} from ${request.room}`);
  }
  res.json({ success: true });
});

app.post("/remove-participant", async (req, res) => {
  const { roomName, identity, block } = req.body;
  if (!roomName || !identity) {
    return res
      .status(400)
      .json({ error: "roomName and identity are required" });
  }

  try {
    await roomService.removeParticipant(roomName, identity);
    if (block) {
      blockedStudents.add(`${roomName}:${identity}`);
      console.log(`🚫 BLOCKED: ${identity} from ${roomName}`);
    }
    console.log(`👋 REMOVED: ${identity} from ${roomName}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ REMOVE ERROR:", e);
    res.status(500).json({ error: "Failed to remove participant" });
  }
});

app.post("/token", async (req, res) => {
  try {
    const { name, room, role, className, topic, preferredLanguage } = req.body;
    console.log("📥 TOKEN REQUEST BODY:", req.body);

    if (!name || !room || !role) {
      return res.status(400).json({ error: "Missing name, room, or role" });
    }

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(500).json({ error: "LiveKit ENV variables missing" });
    }

    // Build metadata object
    const metadata = { role, preferredLanguage: preferredLanguage || "en" };

    // Add className and topic if provided (for teachers)
    if (className) metadata.className = className;
    if (topic) metadata.topic = topic;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name,
        metadata: JSON.stringify(metadata),
      },
    );

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const jwt = await at.toJwt();
    console.log(
      "✅ TOKEN GENERATED for:",
      name,
      "ROLE:",
      role,
      className ? `CLASS: ${className}` : "",
      topic ? `TOPIC: ${topic}` : "",
    );

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (e) {
    console.error("❌ TOKEN ERROR:", e);
    res.status(500).json({ error: "Token generation failed" });
  }
});

app.post("/ask-ai", async (req, res) => {
  try {
    const { question, studentName, topic, className, preferredLanguage } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    const student = studentName || "student";
    const safeTopic = (topic && topic.trim() !== "General Class" && topic.trim() !== "") ? topic.trim() : "this specific ongoing technical class session";
    const safeClassName = (className && className.trim() !== "") ? className.trim() : "General";
    const classContext = `Class: ${safeClassName}, Topic: ${safeTopic}`;
    const thanglishPrompt = `EXTREMELY CASUAL, NATURAL TAMIL-ENGLISH MIX.

CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the Tamil words using native Tamil script (தமிழ்).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Tamil words (No Thanglish).

CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Chennai would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Use Tamil script only for sentence structure, conjunctions, and helping verbs (e.g., "use பண்ணுவோம்", "understand ஆகும்", "solve பண்ண", "run ஆகுது").
- NEVER use formal, literary, or pure Tamil words (e.g., avoid "செய்யப்படுகிறது", "கூடியது", "காரணமாக", "ஆகும்").
- Keep technical terms 100% in pure English without any Tamil suffixes (e.g., say "conclusion", NOT "conclusion-அ").
- The tone should be highly conversational, relaxed, and direct.

FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array ன்னா, multiple values-அ single variable-ல store பண்ண use ஆகுற ஒரு data structure. இதுல items எல்லாம் contiguous memory locations-ல இருக்கும். Index வச்சு easy-ஆ elements access பண்ணலாம்."

Question: "Explain object oriented programming"
Answer: "Object oriented programming, or OOPs, ன்னா real-world entities-அ objects மாதிரி treat பண்ணி code பண்ற style. இதுல classes and objects use பண்ணி code write பண்ணுவோம். Main concepts வந்து inheritance, polymorphism, encapsulation மாறி இருக்கும்."

Question: "What is logical reasoning?"
Answer: "Logical reasoning ன்னா, சரியான evidence வச்சு correct conclusion எப்படி கொண்டு வரது னு பாக்குறது. இதுல நம்ம information analyze பண்ணி, pattern identify பண்ணி, correct முடிவு எடுப்போம்."

Question: "Why is water wet?"
Answer: "Water ஏன் wet-ஆ இருக்கு ன்னா, அது liquid state-ல இருக்கும் போது objects மேல stick ஆகுற property இருக்கு. இது cohesion and adhesion னு சொல்லுவாங்க."

Question: "What is the capital of France?"
Answer: "France ஓட capital Paris. இது ரொம்ப famous-ஆன city, and Eiffel Tower அங்க தான் இருக்கு."`;

    const hinglishPrompt = `EXTREMELY CASUAL, NATURAL HINDI-ENGLISH MIX.
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the Hindi words using native Hindi script (Devanagari - हिंदी).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Hindi words (No Hinglish).
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Delhi would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Use Hindi script only for sentence structure, conjunctions, and helping verbs.
- NEVER use formal, literary, or pure Hindi words.
- Keep technical terms 100% in pure English without any Hindi suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array मतलब, multiple values को एक single variable में store करने के लिए use होने वाला data structure. इसमें items contiguous memory locations पर होते हैं. Index का use करके elements को easily access कर सकते हैं."`;

    const tenglishPrompt = `EXTREMELY CASUAL, NATURAL TELUGU-ENGLISH MIX.
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the Telugu words using native Telugu script (తెలుగు).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Telugu words (No Tenglish).
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Hyderabad would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Use Telugu script only for sentence structure, conjunctions, and helping verbs.
- NEVER use formal, literary, or pure Telugu words.
- Keep technical terms 100% in pure English without any Telugu suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array అంటే, multiple values ని single variable లో store చేయడానికి use చేసే data structure. ఇందులో items అన్నీ contiguous memory locations లో ఉంటాయి. Index use చేసి elements ని easily access చేయొచ్చు."`;

    const kanglishPrompt = `EXTREMELY CASUAL, NATURAL KANNADA-ENGLISH MIX.
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the Kannada words using native Kannada script (ಕನ್ನಡ).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Kannada words (No Kanglish).
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Bangalore would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Use Kannada script only for sentence structure, conjunctions, and helping verbs.
- NEVER use formal, literary, or pure Kannada words.
- Keep technical terms 100% in pure English without any Kannada suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array ಅಂದ್ರೆ, multiple values ನ single variable ನಲ್ಲಿ store ಮಾಡೋಕೆ use ಮಾಡೋ data structure. ಇದ್ರಲ್ಲಿ items ಎಲ್ಲಾ contiguous memory locations ನಲ್ಲಿ ಇರುತ್ತೆ. Index use ಮಾಡಿ elements ನ easily access ಮಾಡ್ಬಹುದು."`;

    const manglishPrompt = `EXTREMELY CASUAL, NATURAL MALAYALAM-ENGLISH MIX.
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the Malayalam words using native Malayalam script (മലയാളം).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Malayalam words (No Manglish).
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Kochi would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Use Malayalam script only for sentence structure, conjunctions, and helping verbs.
- NEVER use formal, literary, or pure Malayalam words.
- Keep technical terms 100% in pure English without any Malayalam suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array എന്നാൽ, multiple values ഒരു single variable-ൽ store ചെയ്യാൻ use ചെയ്യുന്ന data structure ആണ്. ഇതിൽ items contiguous memory locations-ൽ ആയിരിക്കും. Index use ചെയ്തു elements easily access ചെയ്യാം."`;

    const languageMap = {
      'ta': thanglishPrompt,
      'hi': hinglishPrompt,
      'ml': manglishPrompt,
      'te': tenglishPrompt,
      'kn': kanglishPrompt
    };
    const langName = languageMap[preferredLanguage] || preferredLanguage;

    const languageStr = preferredLanguage && preferredLanguage !== 'en' ? `You MUST answer in the following language: \n${langName}\n` : "You must answer in English.";

    console.log(`\n\n===========================================`);
    console.log(`[ASK-AI] Received Request for Student: ${student}`);
    console.log(`[ASK-AI] Topic Received from Frontend: "${topic}" -> Evaluated as: "${safeTopic}"`);
    // 🔍 1. Strict Validation & Classification
    const validationPrompt = `# Student Message Classification & Response Prompt

You are a polite and friendly classroom teacher assistant.

Your job is to understand the student's message and classify it into exactly ONE of these categories:

* \`YES\`
* \`GREETING\`
* \`PERSONAL\`
* \`IGNORE\`

Current class topic:
\`${safeTopic}\`

Student name:
\`${student}\`

Student language:
\`${langName}\`

Student message:
\`${question}\`

## 1. YES — Topic-Related Question

Return \`YES\` when the student is asking an academic question related to the current class topic.

Examples:

* "What is a loop?"
* "What is inheritance?"
* "Explain polymorphism."
* "How does a for loop work?"
* "What is the difference between list and tuple?"

If the message contains a greeting together with a topic question, classify it as \`YES\`.

Examples:

* "Hi, what is a loop?"
* "Good morning, can you explain inheritance?"
* "Hello teacher, what is polymorphism?"

Do NOT classify these as \`GREETING\` because the student has an actual academic doubt.

## 2. GREETING — Greeting or Simple Friendly Conversation

Return \`GREETING\` when the student is only greeting or making simple friendly conversation.

Examples:

* "Hi"
* "Hello"
* "Hey"
* "Good morning"
* "Good afternoon"
* "Good evening"
* "Good night"
* "How are you?"
* "How are you doing?"
* "How is your day?"
* "What's up?"
* "How's it going?"
* "Nice to meet you"
* "Hope you are doing well"
* "Are you ready?"
* "Can we start?"
* "Shall we begin?"

For GREETING, generate a short, polite response.

You MUST use EXACTLY the following mapping for GREETING based on what the student said:
- "Hi" -> "Hello ${studentName}! Please ask your doubt."
- "Hello" -> "Hello ${studentName}! Please ask your doubt."
- "Hey" -> "Hello ${studentName}! Please ask your doubt."
- "Good morning" -> "Good morning ${studentName}! Please ask your doubt."
- "Good afternoon" -> "Good afternoon ${studentName}! Please ask your doubt."
- "Good evening" -> "Good evening ${studentName}! Please ask your doubt."
- "How are you?" -> "I'm doing well, ${studentName}! Please ask your doubt."
- If the greeting is anything else, use: "Hello ${studentName}! Please ask your doubt."

## 3. PERSONAL — Personal Questions

Return \`PERSONAL\` when the student is asking about you personally rather than asking about the lesson.

Examples:

* "Are you human?"
* "What is your name?"
* "What should I call you?"
* "How old are you?"
* "Where do you live?"
* "Where are you from?"
* "Who created you?"
* "Who made you?"
* "Are you a robot?"
* "Do you have feelings?"
* "Do you sleep?"
* "Do you eat?"
* "Do you have a family?"
* "Do you have friends?"
* "What do you like?"
* "What is your favorite color?"
* "What is your favorite food?"
* "Do you like music?"
* "Do you like movies?"
* "Can you be my friend?"
* "Can I talk to you?"
* "Can I ask you something personal?"
* "What do you do when you're not teaching?"

For PERSONAL questions, you MUST use EXACTLY the following mapping based on what the student said:
- "Are you human?" -> "I'm here to support you with your learning, ${studentName}. Please ask your doubt."
- "What is your name?" -> "You can simply call me your teacher, ${studentName}. Please ask your doubt."
- "How old are you?" -> "Let's keep the focus on learning, ${studentName}. Please ask your doubt."
- "Where do you live?" -> "I'm always here to support your learning, ${studentName}. Please ask your doubt."
- "Do you have feelings?" -> "That's an interesting question. Let's focus on your learning, ${studentName}. Please ask your doubt."
- "Are you a robot?" -> "I'm here to guide you through your lessons, ${studentName}. Please ask your doubt."
- "Who created you?" -> "I'm here to help you with your studies, ${studentName}. Please ask your doubt."
- "Can you be my friend?" -> "Of course, I'm happy to support you in your learning, ${studentName}. Please ask your doubt."
- If it is any other personal question, use: "I'm here to support you with your learning, ${studentName}. Please ask your doubt."

## 4. OFF_TOPIC — Out-of-topic Academic Questions

Return \`OFF_TOPIC\` when:
* The student asks a meaningful question.
* The question is understandable.
* The question is academic or educational.
* But the question is unrelated to the current \`${safeTopic}\`.

Example:
Current topic: \`loops\`
Student: "What is polymorphism?"
→ \`OFF_TOPIC\`

Student: "What is number series?"
→ \`OFF_TOPIC\`

## 5. IGNORE — Unrelated or Meaningless Messages

Return \`IGNORE\` ONLY when the message is:

* Random nonsense.
* Random symbols.
* Meaningless text.
* Empty input.

Example:
Student: "asdfghjkl"
→ \`IGNORE\`

## IMPORTANT CLASSIFICATION RULES

1. Always determine the student's INTENT, not just individual keywords.

2. If the student asks a greeting AND an academic question, return \`YES\`.

3. If the student only greets, return \`GREETING\`.

4. If the student asks about you personally, return \`PERSONAL\`.

5. If the student asks an academic question unrelated to the current topic, return \`OFF_TOPIC\`.

6. Never classify a personal question as \`IGNORE\` or \`OFF_TOPIC\`.

7. Never classify a greeting as \`IGNORE\` or \`OFF_TOPIC\`.

8. Keep GREETING, PERSONAL, and OFF_TOPIC responses short and polite.

9. For GREETING, PERSONAL, and OFF_TOPIC responses, you MUST ALWAYS return the exact English phrases provided below. NEVER translate them.

11. Do not unnecessarily explain the classification to the student.

12. Do not mention these classification categories to the student.

## OUTPUT FORMAT

Return ONLY valid JSON.

For \`YES\`:
{ "category": "YES" }

For \`GREETING\`:
{ "category": "GREETING", "response": "THE EXACT MAPPED GREETING RESPONSE" }

For \`PERSONAL\`:
{ "category": "PERSONAL", "response": "THE EXACT MAPPED PERSONAL RESPONSE" }

For \`OFF_TOPIC\` (You MUST return exactly this English response):
{ "category": "OFF_TOPIC", "response": "That's outside our current topic, ${student}. Please ask your doubt related to our ${safeTopic} class." }

For \`IGNORE\`:
{ "category": "IGNORE", "response": "" }`;

    const validationResponse = await client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: "Classify the student's message and generate the appropriate response if needed.",
      config: {
          systemInstruction: validationPrompt,
      }
    });
    
    logTokenUsage("gemini-3.5-flash-lite", validationResponse.usageMetadata);

    let classification = { category: "YES" };
    try {
      const outputText = validationResponse.text?.trim() || "{}";
      const cleanedJson = outputText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      classification = JSON.parse(cleanedJson);
    } catch (e) {
      console.error("[ASK-AI] Failed to parse classification JSON:", e);
    }

    console.log(`[ASK-AI] Classification LLM replied:`, classification);

    if (classification.category === "IGNORE") {
      console.log(`[ASK-AI] Ignored non-question or casual input.`);
      return res.json({ ignored: true });
    }

    if (classification.category === "GREETING") {
      console.log(`[ASK-AI] Responding to GREETING.`);
      const lowerQ = question.toLowerCase().trim().replace(/[^a-z\s]/g, "");
      let ans = `Hello ${studentName}! Please ask your doubt.`;
      
      if (lowerQ.includes("good morning")) ans = `Good morning ${studentName}! Please ask your doubt.`;
      else if (lowerQ.includes("good afternoon")) ans = `Good afternoon ${studentName}! Please ask your doubt.`;
      else if (lowerQ.includes("good evening")) ans = `Good evening ${studentName}! Please ask your doubt.`;
      else if (lowerQ.includes("how are you")) ans = `I'm doing well, ${studentName}! Please ask your doubt.`;
      else if (lowerQ.includes("hi") || lowerQ.includes("hello") || lowerQ.includes("hey")) ans = `Hello ${studentName}! Please ask your doubt.`;
      
      // Prefer LLM generated exact match if provided, otherwise fallback to our robust JS check
      return res.json({ answer: classification.response && classification.response !== "THE EXACT MAPPED GREETING RESPONSE" ? classification.response : ans, isDirectResponse: true });
    }

    if (classification.category === "PERSONAL") {
      console.log(`[ASK-AI] Responding to PERSONAL.`);
      const lowerQ = question.toLowerCase().trim().replace(/[^a-z\s]/g, "");
      let ans = `I'm here to support you with your learning, ${studentName}. Please ask your doubt.`;
      
      if (lowerQ.includes("human")) ans = `I'm here to support you with your learning, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("name")) ans = `You can simply call me your teacher, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("old") || lowerQ.includes("age")) ans = `Let's keep the focus on learning, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("live") || lowerQ.includes("from")) ans = `I'm always here to support your learning, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("feelings")) ans = `That's an interesting question. Let's focus on your learning, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("robot") || lowerQ.includes("ai")) ans = `I'm here to guide you through your lessons, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("created") || lowerQ.includes("made")) ans = `I'm here to help you with your studies, ${studentName}. Please ask your doubt.`;
      else if (lowerQ.includes("friend")) ans = `Of course, I'm happy to support you in your learning, ${studentName}. Please ask your doubt.`;
      
      return res.json({ answer: classification.response && classification.response !== "THE EXACT MAPPED PERSONAL RESPONSE" ? classification.response : ans, isDirectResponse: true });
    }

    if (classification.category === "OFF_TOPIC") {
      console.log(`[ASK-AI] Responding to OFF_TOPIC.`);
      return res.json({ answer: `That's outside our current topic, ${studentName}. Please ask your doubt related to our ${topic} class.`, isDirectResponse: true });
    }

    console.log(`[ASK-AI] Proceeding to Answer Generation...`);
    // 🤖 2. Answer the Question
    const topicContext = `The current class context is: "${classContext}".`;

    const completion = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: question,
      config: {
          systemInstruction: `You are a strict but friendly classroom Teacher. ${topicContext} ` +
            "RULES: " +
            "1. Give a clear, direct answer to the student's question. " +
            "2. Provide a detailed but concise explanation (around 3 to 5 sentences). " +
            "3. Never use 'Namaste', 'Ji', or any cultural/regional words. " +
            "4. Never use filler openers like 'Great question!' or 'Of course!'. " +
            "5. Go straight to the point. " +
            "6. Use the EXACT technical terms the student asked about instead of substituting them with synonyms. " +
            `7. You MUST start your answer by addressing the student by their name: '${student}' (e.g. '${student}, logical reasoning is...'). ` +
            languageStr,
      }
    });

    const answer = completion.text;
    logTokenUsage("gemini-3.5-flash", completion.usageMetadata);
    console.log(`[ASK-AI] Answer generated:\n${answer}\n`);

    res.json({ answer });
  } catch (err) {
    console.error("❌ GROQ ERROR:", err);
    res.status(500).json({ error: "AI response failed" });
  }
});

// 🎤 Extract Question from Voice Transcript
app.post("/extract-question", async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const prompt = `You are a strict classroom assistant. 
Extract ONLY the core academic question from the transcript. 

RULES:
- If the transcript ONLY contains greetings, meta-talk (like "I have a doubt", "Wait", "One more thing"), or teacher-student chatter WITHOUT a specific subject-matter question, you MUST return exactly: <NONE>
- DO NOT extract meta-sentences like "I have one doubt" or "I have a question".
- If a question is found, return ONLY the question text clearly.
- Correct minor phonetic errors by context (e.g., if it says "What is python for", make it "What is Python for?").
- If NO specific question about the subject is found, return exactly: <NONE>

EXAMPLES:
Transcript: "Hi ma'm, I have one doubt." -> Output: <NONE>
Transcript: "Hello teacher, i have doubt what is a variable" -> Output: What is a variable?
Transcript: "Excuse me mam please explain what is inherit" -> Output: please explain what is inheritance?
Transcript: "I have one more doubt." -> Output: <NONE>

Transcript:
"${transcript}"

Extracted Question:`;

    const completion = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
          systemInstruction: "You extract core questions from classroom dialogue. Return only the extracted question text, or an empty string if none found.",
          temperature: 0.1,
      }
    });

    logTokenUsage("gemini-3.5-flash", completion.usageMetadata);

    const extractedQuestion = completion.text
      ?.trim()
      .replace(/^"|"$/g, "");

    res.json({ extractedQuestion });
  } catch (err) {
    console.error("❌ EXTRACTION ERROR:", err);
    res.status(500).json({ error: "Question extraction failed" });
  }
});

// 📝 Quiz Storage (in-memory)
const quizzes = {}; // { quizId: { roomName, topic, questions, submissions: [] } }

// 🎯 Generate Quiz
app.post("/generate-quiz", async (req, res) => {
  try {
    const { topic, studentQuestions, roomName } = req.body;

    if (!topic || !roomName) {
      return res.status(400).json({ error: "Topic and roomName are required" });
    }

    // Build context from student questions
    const questionsContext =
      studentQuestions && studentQuestions.length > 0
        ? `\n\nStudent questions during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        : "";

    const prompt = `You are an educational quiz generator. Generate a quiz with 8-10 multiple choice questions based on the following topic and student questions.

Topic: ${topic}${questionsContext}

Generate questions that:
1. Cover the main topic comprehensively
2. Address concepts from student questions if provided
3. Have exactly 4 options each
4. Have exactly one correct answer
5. Are educational and appropriate
6. For each question, provide translations in Tamil (ta), Hindi (hi), Telugu (te), Malayalam (ml), and Kannada (kn). 
   CRITICAL: Do NOT use pure, formal, or highly literary translations. Use conversational, colloquial language (e.g., Tanglish style but in Tamil script, Hinglish in Hindi script). Keep all technical programming terms and common English words in English.

Return ONLY a valid JSON array in this exact format, with no additional text:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "translations": {
      "ta": { "question": "Tamil Q?", "options": ["Opt A", "Opt B", "Opt C", "Opt D"] },
      "hi": { "question": "Hindi Q?", "options": ["Opt A", "Opt B", "Opt C", "Opt D"] },
      "te": { "question": "Telugu Q?", "options": ["Opt A", "Opt B", "Opt C", "Opt D"] },
      "ml": { "question": "Malayalam Q?", "options": ["Opt A", "Opt B", "Opt C", "Opt D"] },
      "kn": { "question": "Kannada Q?", "options": ["Opt A", "Opt B", "Opt C", "Opt D"] }
    }
  }
]

The correctAnswer should be the index (0-3) of the correct option.`;

    const completion = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
          systemInstruction: "You are a quiz generator and translator. Return only valid JSON arrays with no additional text or formatting.",
      }
    });

    logTokenUsage("gemini-3.5-flash", completion.usageMetadata);

    let quizQuestions;
    try {
      const responseText = completion.text?.trim();
      // Remove markdown code blocks if present
      const jsonText = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      quizQuestions = JSON.parse(jsonText);
      console.log("DEBUG: Parsed Quiz Questions from Gemini:", JSON.stringify(quizQuestions, null, 2));

      if (!Array.isArray(quizQuestions)) {
        throw new Error("AI did not return a JSON array");
      }
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError);
      return res
        .status(500)
        .json({
          error: "Failed to parse quiz questions or AI returned invalid format",
        });
    }

    // Generate unique quiz ID
    const quizId = `quiz_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store quiz
    quizzes[quizId] = {
      roomName,
      topic,
      questions: quizQuestions,
      submissions: [],
      createdAt: new Date().toISOString(),
    };

    console.log(`✅ Quiz generated: ${quizId} for room: ${roomName}`);

    res.json({
      quizId,
      questions: quizQuestions.map((q, idx) => ({
        id: idx,
        question: q.question,
        options: q.options,
        translations: q.translations,
      })),
    });
  } catch (err) {
    console.error("❌ QUIZ GENERATION ERROR:", err);
    res.status(500).json({ error: "Quiz generation failed" });
  }
});

// 🎯 Generate Attention Popup Question
app.post("/api/attention-question", async (req, res) => {
  try {
    const { className, topic } = req.body;

    if (!topic && !className) {
      return res.status(400).json({ error: "className or topic is required" });
    }

    const safeClassName = className || "General";
    const safeTopic = topic || "General Study";

    const prompt = `You are an educational assistant. Generate exactly one single, very basic and simple multiple-choice question to check if a student is paying attention. The question should be a fundamental concept directly related to the class topic and class name.

Class Name: ${safeClassName}
Topic: ${safeTopic}

Generate a question that:
1. Is directly related to the topic and class name
2. Is extremely basic, fundamental, and easy to answer
3. Has 3 simple, clear options (A, B, C)
4. Has exactly one correct answer
5. Is concise and can be read and answered quickly (under 30 seconds)

Return ONLY a valid JSON object in this exact format, with no additional text or markdown formatting blocks:
{
  "question": "Question text here?",
  "options": ["Option A", "Option B", "Option C"],
  "correctAnswer": 0
}

The correctAnswer should be the index (0-2) of the correct option.`;

    const completion = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are a question generator. Return only a valid JSON object with no additional text or formatting."
      }
    });
    logTokenUsage("gemini-2.5-flash", completion.usageMetadata);

    let questionObj;
    try {
      const responseText = completion.text?.trim();
      const jsonText = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      questionObj = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError);
      return res
        .status(500)
        .json({
          error: "Failed to parse attention question or AI returned invalid format",
        });
    }

    res.json(questionObj);
  } catch (err) {
    console.error("❌ ATTENTION QUESTION ERROR:", err);
    res.status(500).json({ error: "Attention question generation failed" });
  }
});

// 📤 Submit Quiz
app.post("/submit-quiz", async (req, res) => {
  try {
    const { quizId, studentName, answers } = req.body;

    if (!quizId || !studentName || !answers) {
      return res
        .status(400)
        .json({ error: "quizId, studentName, and answers are required" });
    }

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: "Quiz not found" });
    }

    // Grade the quiz
    let correctCount = 0;
    const results = quiz.questions.map((q, idx) => {
      const studentAnswer = answers[idx];
      const isCorrect = studentAnswer === q.correctAnswer;
      if (isCorrect) correctCount++;

      return {
        questionId: idx,
        question: q.question,
        studentAnswer,
        correctAnswer: q.correctAnswer,
        isCorrect,
      };
    });

    const score = Math.round((correctCount / quiz.questions.length) * 100);

    // Store submission
    const submission = {
      studentName,
      answers,
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      submittedAt: new Date().toISOString(),
      video_activity: req.body.video_activity || "N/A",
      status: req.body.status || "Good",
      reason: req.body.reason || "None",
      browserSwitchCount: req.body.browserSwitchCount || 0,
    };

    quiz.submissions.push(submission);

    console.log(`✅ Quiz submitted by ${studentName}: ${score}%`);

    res.json({
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      results,
    });
  } catch (err) {
    console.error("❌ QUIZ SUBMISSION ERROR:", err);
    res.status(500).json({ error: "Quiz submission failed" });
  }
});

// 📊 Get Quiz Results (Teacher)
app.get("/quiz-results/:quizId", (req, res) => {
  try {
    const { quizId } = req.params;

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: "Quiz not found" });
    }

    // Calculate statistics
    const scores = quiz.submissions.map((s) => s.score);
    const stats = {
      totalSubmissions: quiz.submissions.length,
      averageScore:
        scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0,
      highestScore: scores.length > 0 ? Math.max(...scores) : 0,
      lowestScore: scores.length > 0 ? Math.min(...scores) : 0,
    };

    res.json({
      quizId,
      topic: quiz.topic,
      roomName: quiz.roomName,
      createdAt: quiz.createdAt,
      questions: quiz.questions,
      submissions: quiz.submissions,
      stats,
    });
  } catch (err) {
    console.error("❌ QUIZ RESULTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch quiz results" });
  }
});

// 🚪 End Meeting (Delete Room)
app.post("/end-room", async (req, res) => {
  try {
    const { roomName } = req.body;
    if (!roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }

    await roomService.deleteRoom(roomName);
    endedRooms.add(roomName); // 🔒 Mark room as ended
    
    // Clear activity tracking for this room
    if (studentActivitiesData[roomName]) {
      delete studentActivitiesData[roomName];
    }
    
    console.log(`🗑️ Room ${roomName} has been ended by teacher.`);
    res.json({ success: true, message: `Room ${roomName} ended.` });
  } catch (e) {
    // Even if deleteRoom fails (room already gone), mark it as ended
    if (req.body.roomName) endedRooms.add(req.body.roomName);
    console.error("❌ END ROOM ERROR:", e);
    res.status(500).json({ error: "Failed to end room" });
  }
});

// 📊 Activity Sync
app.post("/api/activity-sync", (req, res) => {
  const { roomName, studentName, awayTime, inactiveTime, backgroundTime, warningCount } = req.body;
  if (!roomName || !studentName) {
    return res.status(400).json({ error: "roomName and studentName required" });
  }
  
  if (!studentActivitiesData[roomName]) {
    studentActivitiesData[roomName] = {};
  }
  
  studentActivitiesData[roomName][studentName] = {
    awayTime: awayTime || 0,
    inactiveTime: inactiveTime || 0,
    backgroundTime: backgroundTime || 0,
    warningCount: warningCount || 0,
    lastUpdated: new Date().toISOString()
  };
  
  res.json({ success: true });
});

// 📥 Download Activity History XLSX (Styled)
app.get("/api/activity-history/:roomName", async (req, res) => {
  const { roomName } = req.params;
  const roomData = studentActivitiesData[roomName];

  if (!roomData) {
    return res.status(404).json({ error: "No activity data found for this room" });
  }

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Activity Report');

  // Define Columns
  worksheet.columns = [
    { key: 'name', width: 20 },
    { key: 'away', width: 22 },
    { key: 'inactive', width: 24 },
    { key: 'background', width: 26 },
    { key: 'warnings', width: 18 }
  ];

  // Add "ACTIVITY DETAILS" header row
  worksheet.mergeCells('A1:E1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = 'ACTIVITY DETAILS';
  titleCell.font = { bold: true, size: 12 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' } // Yellow background
  };
  worksheet.getRow(1).height = 25;

  // Add Column Headers
  const headerRow = worksheet.addRow([
    'Student Name',
    'Total Away Time (s)',
    'Total Inactive Time (s)',
    'Total Background Time (s)',
    'Total Warnings'
  ]);
  
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
  });
  worksheet.getRow(2).height = 20;

  // Add Data Rows
  for (const [studentName, data] of Object.entries(roomData)) {
    const away = Math.floor(data.awayTime / 1000);
    const inactive = Math.floor(data.inactiveTime / 1000);
    const bg = Math.floor(data.backgroundTime / 1000);
    worksheet.addRow([studentName, away, inactive, bg, data.warningCount]);
  }

  // Set response headers
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="activity_report_${roomName}.xlsx"`);

  // Write to response
  await workbook.xlsx.write(res);
  res.end();
});

// 🔍 Check Room Status (for student join page)
app.get("/room-status/:roomName", (req, res) => {
  const { roomName } = req.params;
  const ended = endedRooms.has(roomName);
  console.log(
    `🔍 Room status check: ${roomName} → ${ended ? "ENDED" : "ACTIVE"}`,
  );
  res.json({ ended });
});

// 🌟 Encourage Student
app.post("/encourage-student", async (req, res) => {
  try {
    const { name, question } = req.body;

    if (!name || !question) {
      return res.status(400).json({ error: "Name and question are required" });
    }

    // 1. Validate if the input should be ignored
    const validationPrompt = `Determine if the following student input is an academic question or doubt, or if it should be ignored.
    
Input: "${question}"

RULES:
1. If the input is a greeting (e.g., "Hi", "Hello", "How are you", "Good morning"), an acknowledgement (e.g., "OK", "Thank you", "Sorry"), random/meaningless text (e.g., "asdfg"), or any casual non-academic message, reply with EXACTLY the word "IGNORE".
2. Otherwise, if it is a question or academic doubt, reply with EXACTLY the word "PROCEED".

OUTPUT NOTHING ELSE. Choose exactly ONE of these two words: IGNORE or PROCEED.`;

    const validationResponse = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: validationPrompt,
    });
    logTokenUsage("gemini-2.5-flash", validationResponse.usageMetadata);

    const validationResult =
      validationResponse.text?.trim()?.toUpperCase() ||
      "";
    console.log(
      `[ENCOURAGE-STUDENT] Validation result for "${question}": "${validationResult}"`,
    );

    if (validationResult.includes("IGNORE")) {
      console.log(`[ENCOURAGE-STUDENT] Ignored non-question or casual input.`);
      return res.json({ encouragement: null, ignored: true });
    }

    const prompt = `You are an encouraging Indian Teacher's Assistant. A student named "${name}" just asked this academic doubt: "${question}".
    Provide a very short, one-sentence encouraging response.
    Examples: "That is a very good curiosity, ${name}!", "Great doubt, ${name}, let's clear it together.", "Interesting point, ${name} - keep it up!"
    
    RULES:
    1. Keep it under 15 words.
    2. Be polite and use the student's name.
    3. Use "doubt" instead of "question" where appropriate.
    4. Return ONLY the encouraging statement.`;

    const completion = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are an Indian Teacher Assistant providing short, polite, and encouraging feedback.",
        temperature: 0.8,
      }
    });
    logTokenUsage("gemini-2.5-flash", completion.usageMetadata);

    const encouragement =
      completion.text?.trim() ||
      `Good question, ${name}!`;

    res.json({ encouragement });
  } catch (err) {
    console.error("❌ ENCOURAGEMENT ERROR:", err);
    res.status(500).json({ error: "Encouragement failed" });
  }
});

// 📝 Generate Class Summary
app.post("/generate-summary", async (req, res) => {
  try {
    const { topic, studentQuestions } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const questionsContext =
      studentQuestions && studentQuestions.length > 0
        ? `\n\nStudent doubts cleared during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        : "";

    const prompt = `You are an Indian Teacher Assistant. Provide a concise summary of the class based on the topic and doubts cleared.
    
Topic: ${topic}${questionsContext}

Rules:
1. Keep the summary under 50 words.
2. Highlight the key concepts discussed.
3. Use a polite, professional Indian academic tone.
4. Use terms like "doubts cleared" instead of "questions answered".
5. Return ONLY the summary text.`;

    let summary = "No summary available.";
    try {
      const completion = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          systemInstruction: "You are an Indian Teacher Assistant. Provide concise and polite class summaries.",
          temperature: 0.5,
        }
      });
      logTokenUsage("gemini-2.5-flash", completion.usageMetadata);
      summary = completion.text?.trim() || "No summary available.";
    } catch (err) {
      console.error("❌ SUMMARY GENERATION ERROR:", err.message);
    }

    res.json({ summary });
  } catch (err) {
    console.error("❌ SUMMARY ROUTE ERROR:", err);
    res.status(500).json({ error: "Summary generation failed" });
  }
});

// ========================================
// 🎬 Video Generation Integration (proxy to VideoGenerator server)
// ========================================
const rawVideogenUrl = process.env.VIDEOGEN_API_URL || (process.env.NODE_ENV === 'production' ? 'https://videogenerator-backend-ws81.onrender.com' : 'http://localhost:5000');
const VIDEOGEN_API = rawVideogenUrl.replace(/\/+$/, '');

// Proxy: Trigger one-shot video generation
app.post("/api/generate-video", async (req, res) => {
  try {
    const { topic, subTopic, durationMinutes, languages, voiceId } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    console.log(`🎬 [VIDEO-GEN] Step 1: Generating script for topic="${topic}", subTopic="${subTopic || 'N/A'}", duration=${durationMinutes}min`);
    
    const axios = require('axios');
    
    // Step 1: Generate Script
    const scriptResponse = await axios.post(`${VIDEOGEN_API}/api/videos/generate-script`, 
      { topic, subTopic, durationMinutes },
      { timeout: 1200000 } // 20 minutes
    );
    
    const scriptData = scriptResponse.data;
    
    if (!scriptData.success) {
      console.error(`❌ [VIDEO-GEN] Script generation failed:`, scriptData);
      return res.status(500).json(scriptData);
    }
    
    console.log(`🎬 [VIDEO-GEN] Step 2: Generating video with languages=${languages?.join(',')}, voiceId=${voiceId}`);
    
    // Map Frontend "Male" / "Female" to Videogenerator expected values
    let mappedVoiceId = voiceId;
    if (voiceId === "Male") mappedVoiceId = "google-cloud-tts-male";
    if (voiceId === "Female") mappedVoiceId = "google-cloud-tts-female";

    // Step 2: Generate Video
    const videoResponse = await axios.post(`${VIDEOGEN_API}/api/videos/generate`, 
      { 
        text: scriptData.text,
        format: 'landscape',
        languages: JSON.stringify(languages || []),
        voiceId: mappedVoiceId 
      },
      { timeout: 1200000 } // 20 minutes
    );
    
    const videoData = videoResponse.data;

    console.log(`✅ [VIDEO-GEN] Video generated successfully. ID: ${videoData.data?.id}`);
    res.json(videoData);
  } catch (err) {
    console.error("❌ [VIDEO-GEN] Proxy error:", err.response ? err.response.data : err.message);
    res.status(err.response ? err.response.status : 500).json({ error: "Failed to generate video", details: err.message });
  }
});

// Proxy: Get available voices from VideoGenerator
app.get("/api/video-voices", async (req, res) => {
  try {
    const response = await fetch(`${VIDEOGEN_API}/api/voice/list`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("❌ [VIDEO-VOICES] Proxy error:", err);
    res.status(500).json({ error: "Failed to fetch video voices", voices: [] });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
