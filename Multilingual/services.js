
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
        model: "gemini-3.6-flash",
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
Example 1: "Logical reasoning na, eppadi sariyaana evidence vechu correct-ana conclusion-ku varathu nu pakkaradhu. Idhula namma information-a analyze panni, patterns identify panni, oru correct-ana mudivukku varuvom."
Example 2: "Innaiku namma photosynthesis pathi learn panna porom."`;

    const languageMap = {
      'ta': thanglishPrompt,
      'hi': 'Hindi',
      'ml': 'Malayalam',
      'te': 'Telugu',
      'kn': 'Kannada'
    };
    
    const langName = languageMap[targetLanguage] || targetLanguage;
    
    // Using Llama-3 to translate
    const prompt = `Translate the following text to ${langName}. Return ONLY the translated text, without any additional comments, quotes or formatting:\n\n"${text}"`;
    
    try {
      const completion = await client.interactions.create({
        model: "gemini-3.6-flash",
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
