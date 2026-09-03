
const { GoogleGenAI } = require("@google/genai");
const textToSpeech = require('@google-cloud/text-to-speech');

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
const ttsClient = new textToSpeech.TextToSpeechClient();

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
    
    const thanglishPrompt = `Natural conversational Tamil-English mix (Code-switching).
REQUIRED BEHAVIOR:
- You MUST write the Tamil words using native Tamil script (தமிழ்).
- You MUST write all technical terms, nouns, and English words using standard English alphabets.
- Mix them naturally in the same sentence. Do NOT use Latin script for Tamil words (No Thanglish).
- Keep technical and classroom terms in English without adding unnecessary Tamil suffixes (e.g. use "evidence", not "evidence-அ"; use "conclusion", not "conclusion-அ").
- Avoid literal translation and overly formal Tamil.
- Make it sound like a real Tamil teacher explaining a concept naturally.
Example 1: "Logical reasoning ன்னா, எப்படி சரியான evidence வச்சு correct-ஆன conclusion-க்கு வர்றது னு பாக்குறது. இதுல நம்ம information-அ analyze பண்ணி, patterns identify பண்ணி, ஒரு correct-ஆன முடிவுக்கு வருவோம்."
Example 2: "இன்னைக்கு நம்ம photosynthesis பத்தி learn பண்ண போறோம்."`;

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
      const localeMap = {
        'en': 'en-IN',
        'hi': 'hi-IN',
        'ml': 'ml-IN',
        'ta': 'ta-IN',
        'te': 'te-IN',
        'kn': 'kn-IN',
        'en-IN': 'en-IN'
      };
      const locale = localeMap[languageCode] || languageCode;
      
      const request = {
        input: { text: text },
        voice: { languageCode: locale, name: `${locale}-Wavenet-A` }, // fallback to Wavenet
        audioConfig: { audioEncoding: 'MP3' },
      };

      const [response] = await ttsClient.synthesizeSpeech(request);
      return response.audioContent;
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
