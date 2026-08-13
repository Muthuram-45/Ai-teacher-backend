const Groq = require("groq-sdk");
const fetch = require("node-fetch"); // node-fetch or native fetch depending on Node version

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

class STTService {
  /**
   * Transcribe audio using Whisper model
   * @param {Buffer} audioBuffer
   * @param {string} mimetype e.g., 'audio/wav'
   */
  static async transcribe(audioBuffer, mimetype = 'audio/wav') {
    // Write buffer to a temporary file or create a Blob to pass to Groq
    // Groq requires a File object or similar stream
    try {
      const file = new File([audioBuffer], "audio.wav", { type: mimetype });
      
      const transcription = await groq.audio.transcriptions.create({
        file: file,
        model: "whisper-large-v3", // or "whisper-large-v3-turbo"
        response_format: "verbose_json",
      });
      return transcription;
    } catch (error) {
      console.error("STT Error:", error);
      throw error;
    }
  }
}

class TranslationService {
  static async translate(text, targetLanguage) {
    if (!text || text.trim() === '') return text;
    
    const languageMap = {
      'ta': 'Tamil',
      'hi': 'Hindi',
      'ml': 'Malayalam',
      'te': 'Telugu',
      'kn': 'Kannada'
    };
    
    const langName = languageMap[targetLanguage] || targetLanguage;
    
    // Using Llama-3 to translate
    const prompt = `Translate the following text to ${langName}. Return ONLY the translated text, without any additional comments, quotes or formatting:\n\n"${text}"`;
    
    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: "You are a professional translator. Provide direct translations without any meta-text."
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 200,
      });
      
      let translated = completion.choices[0]?.message?.content?.trim();
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
