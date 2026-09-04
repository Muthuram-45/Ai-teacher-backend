const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { GoogleGenAI } = require("@google/genai");
const { Storage } = require("@google-cloud/storage");
const { logTokenUsage } = require("../utils/tokenLogger");

const client = new GoogleGenAI({
    vertexai: process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true',
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

const router = express.Router();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const roomName = req.body.roomName || "DefaultRoom";
        const className = req.body.className || roomName;
        const today = new Date().toISOString().split("T")[0];

        const sessionId = req.body.sessionId || "default";

        const basePath = path.join(
            __dirname,
            "..",
            "ClassRecordings",
            today,
            className,
            sessionId
        );

        if (!fs.existsSync(basePath)) {
            fs.mkdirSync(basePath, { recursive: true });
        }

        cb(null, basePath);
    },

    filename: function (req, file, cb) {
        const partNumber = req.body.partNumber || "1";
        const sessionId = req.body.sessionId || Date.now();
        cb(null, `${sessionId}_Part_${partNumber}.webm`);
    }
});

const upload = multer({ storage });

router.post("/upload", upload.single("video"), async (req, res) => {
    const { roomName, className, partNumber, sessionId, transcribe, isFinal, chatHistory } = req.body;
    const filePath = req.file.path;
    const directory = path.dirname(filePath);

    console.log(`📥 Received Part ${partNumber} for session ${sessionId}. Final: ${isFinal}, Transcribe: ${transcribe}`);

    // If chat history is provided, save it for the summary phase
    if (chatHistory) {
        const chatPath = path.join(directory, `${sessionId}_chat.json`);
        fs.writeFileSync(chatPath, chatHistory);
        console.log(`💬 Chat history saved for session ${sessionId}`);
    }

    let finalTranscript = null;

    if (isFinal === "true" && transcribe === "true") {
        console.log(`🎬 Recording finished. Starting transcription process for session ${sessionId}...`);
        try {
            finalTranscript = await processTranscription(directory, sessionId, className || roomName);
        } catch (err) {
            console.error("❌ Transcription Process Error:", err);
            finalTranscript = "Transcription failed: " + err.message;
        }
    }

    if (isFinal === "true") {
        // Cleanup the temporary directory to avoid saving permanently on the server
        try {
            fs.rmSync(directory, { recursive: true, force: true });
            console.log(`🧹 Cleaned up temporary recording directory: ${directory}`);
        } catch (e) {
            console.error(`❌ Failed to clean up directory ${directory}:`, e.message);
        }
    }

    res.json({
        message: "Uploaded successfully",
        filePath: filePath,
        transcript: finalTranscript
    });
});

async function processTranscription(directory, sessionId, className) {
    const files = fs.readdirSync(directory)
        .filter(f => f.startsWith(sessionId) && f.endsWith(".webm"))
        .sort((a, b) => {
            const partA = parseInt(a.split("_Part_")[1]);
            const partB = parseInt(b.split("_Part_")[1]);
            return partA - partB;
        });

    if (files.length === 0) return;

    const listFilePath = path.join(directory, `${sessionId}_list.txt`);
    const listContent = files.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(listFilePath, listContent);

    const mergedVideoPath = path.join(directory, `${sessionId}_merged.webm`);
    const audioPath = path.join(directory, `${sessionId}_audio.mp3`);

    console.log(`🔗 Merging ${files.length} parts...`);
    await execPromise(`ffmpeg -f concat -safe 0 -i "${listFilePath}" -c copy "${mergedVideoPath}"`);

    console.log(`🎵 Extracting audio...`);
    await execPromise(`ffmpeg -i "${mergedVideoPath}" -vn -ab 128k -ar 44100 -y "${audioPath}"`);

    console.log(`📝 Uploading audio to Google Cloud Storage for transcription...`);
    const bucketName = process.env.GOOGLE_CLOUD_STORAGE_BUCKET;
    if (!bucketName) {
        throw new Error("GOOGLE_CLOUD_STORAGE_BUCKET is not set. Transcription requires GCS for Vertex AI.");
    }
    
    const storageClient = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
    const gcsFileName = `${sessionId}_audio_${Date.now()}.mp3`;
    
    await storageClient.bucket(bucketName).upload(audioPath, {
        destination: gcsFileName,
    });
    
    const gcsUri = `gs://${bucketName}/${gcsFileName}`;
    console.log(`✅ Uploaded to GCS: ${gcsUri}`);

    let audioTranscription = "";
    try {
        const transcriptionCompletion = await client.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [
                {
                    fileData: {
                        fileUri: gcsUri,
                        mimeType: "audio/mp3"
                    }
                }
            ],
            config: {
                systemInstruction: "You are a professional audio transcriptionist. Transcribe the provided audio verbatim. Output ONLY the raw transcript text. Do not add any conversational text or formatting."
            }
        });
        audioTranscription = transcriptionCompletion.text || "";
        logTokenUsage("gemini-3.5-flash", transcriptionCompletion.usageMetadata);
    } catch (e) {
        console.warn("⚠️ Transcription primary model failed, falling back to gemini-2.5-flash...", e.message);
        const fbCompletion = await client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
                {
                    fileData: {
                        fileUri: gcsUri,
                        mimeType: "audio/mp3"
                    }
                }
            ],
            config: {
                systemInstruction: "You are a professional audio transcriptionist. Transcribe the provided audio verbatim. Output ONLY the raw transcript text. Do not add any conversational text or formatting."
            }
        });
        audioTranscription = fbCompletion.text || "";
        logTokenUsage("gemini-2.5-flash", fbCompletion.usageMetadata);
    }
    
    // Clean up GCS file
    try {
        await storageClient.bucket(bucketName).file(gcsFileName).delete();
        console.log(`🧹 Cleaned up GCS audio file: ${gcsFileName}`);
    } catch (e) {
        console.warn(`⚠️ Failed to clean up GCS audio file ${gcsFileName}:`, e.message);
    }

    // 📖 Combine with Chat History
    let fullTranscript = `--- SPOKEN AUDIO TRANSCRIPT ---\n${audioTranscription}\n\n`;

    const chatPath = path.join(directory, `${sessionId}_chat.json`);
    if (fs.existsSync(chatPath)) {
        try {
            const chatData = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
            fullTranscript += `--- TEXT CHAT & QA HISTORY ---\n`;
            chatData.forEach(msg => {
                fullTranscript += `[${msg.name}]: ${msg.text}\n`;
                if (msg.answer) fullTranscript += `[AI Answer]: ${msg.answer}\n`;
            });
            fs.unlinkSync(chatPath); // Cleanup
        } catch (e) {
            console.warn("⚠️ Failed to parse chat history:", e.message);
        }
    }

    const transcriptionPath = path.join(directory, "transcription.txt");
    fs.writeFileSync(transcriptionPath, fullTranscript);
    console.log(`✅ Final transcription/chat log saved to ${transcriptionPath}`);

    console.log(`🤖 Generating summary...`);
    let summary = "No summary generated.";
    try {
        const completion = await client.models.generateContent({
            model: "gemini-3.5-flash",
            contents: fullTranscript,
            config: {
                systemInstruction: "You are an AI assistant helping a teacher. Summarize the following meeting content (Transcript AND Chat) into key points and action items. IMPORTANT: Use PLAIN TEXT ONLY. Do NOT use markdown bolding (like **text**), italics, or other markdown symbols. Do NOT include a 'Student Questions and Answers' section. Use standard numbering (1., 2., etc.) for lists."
            }
        });
        summary = completion.text || "No summary generated.";
        logTokenUsage("gemini-3.5-flash", completion.usageMetadata);
    } catch (e) {
        console.warn("⚠️ Summary primary model failed, falling back to gemini-2.5-flash...", e.message);
        const fbCompletion = await client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: fullTranscript,
            config: {
                systemInstruction: "You are an AI assistant helping a teacher. Summarize the following meeting content (Transcript AND Chat) into key points and action items. IMPORTANT: Use PLAIN TEXT ONLY. Do NOT use markdown bolding (like **text**), italics, or other markdown symbols. Do NOT include a 'Student Questions and Answers' section. Use standard numbering (1., 2., etc.) for lists."
            }
        });
        summary = fbCompletion.text || "No summary generated.";
        logTokenUsage("gemini-2.5-flash", fbCompletion.usageMetadata);
    }
    
    // Append summary to the full transcript
    fullTranscript += `\n--- CLASS SUMMARY ---\n${summary}\n`;

    try {
        fs.unlinkSync(listFilePath);
        fs.unlinkSync(audioPath);
    } catch (e) { }

    return fullTranscript;
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

module.exports = router;
