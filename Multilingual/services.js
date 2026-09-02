
const { GoogleGenAI } = require("@google/genai");

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

class STTService {
  /**
   * Transcribe audio using Whisper model
   * @param {Buffer} audioBuffer
   * @param {string} mimetype e.g., 'audio/wav'
   */
  static async transcribe(audioBuffer, mimetype = 'audio/wav') {
    try {
      const fileBase64 = audioBuffer.toString("base64");
      const transcriptionCompletion = await client.interactions.create({
        model: "gemini-3.5-flash",
        system_instruction: "You are a professional audio transcriptionist. Transcribe the provided audio verbatim. Output ONLY the raw transcript text. Do not add any conversational text or formatting.",
        input: [
            { audio: { data: fileBase64, mime_type: mimetype } }
        ]
      });
      
      return { text: transcriptionCompletion.output_text || "" };
    } catch (error) {
      console.error("STT Error:", error);
      throw error;
    }
  }
}

class TranslationService {
  static async translate(text, targetLanguage) {
    if (!text || text.trim() === '') return text;
    
    const thanglishPrompt = `Natural conversational Thanglish (Tamil-English mix).
REQUIRED BEHAVIOR:
- The ENTIRE answer MUST be in Thanglish. NEVER switch back to full English sentences at any point.
- Use Latin script ONLY (e.g. "Innaiku namma learn panna porom"). NEVER use Tamil script (e.g. "இன்று").
- Naturally mix Tamil grammar with English vocabulary.
- Keep technical and classroom terms in English without adding unnecessary Tamil suffixes (e.g. use "evidence", not "evidence-a"; use "conclusion", not "conclusion-a").
- Avoid literal translation and overly formal Tamil.
- Make it sound like a real Tamil teacher explaining a concept naturally.
- PRONUNCIATION & TTS FIXES: English TTS engines often fail on words like "idhu", "adhu", "agite" and spell them letter-by-letter (i-d-h-u). To prevent this, alter the spelling to force word pronunciation (e.g., use "ithu", "athu", "eethu", "aaguthey"). Use clear English syllables, avoid consonant clusters, and avoid capitalization for regional words.
Example 1: "Logical reasoning na, eppadi sariyaana evidence vechu correct-ana conclusion-ku varathu nu pakkaradhu. Idhula namma information-a analyze panni, patterns identify panni, oru correct-ana mudivukku varuvom."
Example 2: "Innaiku namma photosynthesis pathi learn panna porom."`;

    const hinglishPrompt = `EXTREMELY CASUAL, NATURAL HINGLISH (Hindi-English mix).
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the ENTIRE response using standard English alphabets (Latin script) ONLY.
- It is STRICTLY FORBIDDEN to use even a single Hindi character. If you use Hindi letters, the text-to-speech engine will crash.
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Delhi would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Only use Hindi for sentence structure, conjunctions, and helping verbs.
- PRONUNCIATION & TTS FIXES: English TTS engines often fail on words like "idhu", "adhu", "agite" and spell them letter-by-letter (i-d-h-u). To prevent this, alter the spelling to force word pronunciation (e.g., use "ithu", "athu", "eethu", "aaguthey"). Use clear English syllables, avoid consonant clusters, and avoid capitalization for regional words.
- NEVER use formal, literary, or pure Hindi words.
- Keep technical terms 100% in pure English without any Hindi suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array matlab, multiple values ko ek single variable mein store karne ke liye use hone wala data structure. Ismein items contiguous memory locations par hote hain. Index ka use karke elements ko easily access kar sakte hain."`;

    const tenglishPrompt = `EXTREMELY CASUAL, NATURAL TENGLISH (Telugu-English mix).
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the ENTIRE response using standard English alphabets (Latin script) ONLY.
- It is STRICTLY FORBIDDEN to use even a single Telugu character.
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Hyderabad would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Only use Telugu for sentence structure, conjunctions, and helping verbs.
- PRONUNCIATION & TTS FIXES: English TTS engines often fail on words like "idhu", "adhu", "agite" and spell them letter-by-letter (i-d-h-u). To prevent this, alter the spelling to force word pronunciation (e.g., use "ithu", "athu", "eethu", "aaguthey"). Use clear English syllables, avoid consonant clusters, and avoid capitalization for regional words.
- NEVER use formal, literary, or pure Telugu words.
- Keep technical terms 100% in pure English without any Telugu suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array ante, multiple values ni single variable lo store cheyadaniki use chese data structure. Indulo items anni contiguous memory locations lo untayi. Index use chesi elements ni easily access cheyochu."`;

    const kanglishPrompt = `EXTREMELY CASUAL, NATURAL KANGLISH (Kannada-English mix).
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the ENTIRE response using standard English alphabets (Latin script) ONLY.
- It is STRICTLY FORBIDDEN to use even a single Kannada character.
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Bangalore would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Only use Kannada for sentence structure, conjunctions, and helping verbs.
- PRONUNCIATION & TTS FIXES: English TTS engines often fail on words like "idhu", "adhu", "agite" and spell them letter-by-letter (i-d-h-u). To prevent this, alter the spelling to force word pronunciation (e.g., use "ithu", "athu", "eethu", "aaguthey"). Use clear English syllables, avoid consonant clusters, and avoid capitalization for regional words.
- NEVER use formal, literary, or pure Kannada words.
- Keep technical terms 100% in pure English without any Kannada suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array andre, multiple values na single variable nalli store madakke use mado data structure. Idrali items ella contiguous memory locations nalli iruthe. Index use madi elements na easily access madbahudu."`;

    const manglishPrompt = `EXTREMELY CASUAL, NATURAL MANGLISH (Malayalam-English mix).
CRITICAL SCRIPT RULE (ABSOLUTE PRIORITY):
- You MUST write the ENTIRE response using standard English alphabets (Latin script) ONLY.
- It is STRICTLY FORBIDDEN to use even a single Malayalam character.
CRITICAL TONE, PRONUNCIATION & VOCABULARY RULES:
- Write exactly how a modern, urban college student or tech professional in Kochi would speak naturally.
- Use English words for most nouns, verbs, and adjectives. Only use Malayalam for sentence structure, conjunctions, and helping verbs.
- PRONUNCIATION & TTS FIXES: English TTS engines often fail on words like "idhu", "adhu", "agite" and spell them letter-by-letter (i-d-h-u). To prevent this, alter the spelling to force word pronunciation (e.g., use "ithu", "athu", "eethu", "aaguthey"). Use clear English syllables, avoid consonant clusters, and avoid capitalization for regional words.
- NEVER use formal, literary, or pure Malayalam words.
- Keep technical terms 100% in pure English without any Malayalam suffixes.
- The tone should be highly conversational, relaxed, and direct.
FEW-SHOT EXAMPLES:
Question: "What is an array?"
Answer: "Array ennal, multiple values oru single variable-il store cheyan use cheyunna data structure aanu. Ithil items contiguous memory locations-il aayirikkum. Index use cheythu elements easily access cheyam."`;

    const languageMap = {
      'ta': thanglishPrompt,
      'hi': hinglishPrompt,
      'ml': manglishPrompt,
      'te': tenglishPrompt,
      'kn': kanglishPrompt
    };
    
    const langName = languageMap[targetLanguage] || targetLanguage;
    
    // Using Llama-3 to translate
    const prompt = `Translate the following text to ${langName}. Return ONLY the translated text, without any additional comments, quotes or formatting:\n\n"${text}"`;
    
    try {
      const completion = await client.interactions.create({
        model: "gemini-3.5-flash",
        system_instruction: "You are a professional translator. Provide direct translations without any meta-text.",
        input: prompt,
      });
      
      let translated = completion.output_text?.trim();
      // Clean up if it starts/ends with quotes
      translated = translated.replace(/^"|"$/g, "");
      return translated;
    } catch (error) {
      console.error("Translation Error:", error);
      throw error;
    }
  }
}

class TTSService {
  static async synthesize(text, languageCode) {
    try {
      // Using Google Translate TTS (similar to proxy in server.js)
      // languageCode: 'ta', 'hi', 'ml'
      const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${languageCode}&q=${encodeURIComponent(text)}`;
      
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
      });
      
      if (!response.ok) {
        throw new Error(`TTS failed with status: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error("TTS Error:", error);
      throw error;
    }
  }
}

module.exports = {
  STTService,
  TranslationService,
  TTSService,
};
