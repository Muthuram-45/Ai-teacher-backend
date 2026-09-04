/**
 * Logs token usage metadata for AI generation requests.
 * Structured so it can be easily persisted to a database later.
 * 
 * @param {string} model - The model name used.
 * @param {object} usageMetadata - The usageMetadata object returned by the GenAI SDK.
 */
function logTokenUsage(model, usageMetadata) {
    if (!usageMetadata) {
        console.warn(`[TokenTracker] No usage metadata returned for model: ${model}`);
        return;
    }

    const usageData = {
        model: model,
        inputTokens: usageMetadata.promptTokenCount || 0,
        outputTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokenCount || 0,
        timestamp: new Date().toISOString()
    };

    console.log(`\n📊 [TokenTracker] Usage Logged:`);
    console.log(JSON.stringify(usageData, null, 2));
    
    // TODO: In the future, persist `usageData` to the SkyMeet cost-tracking database here.
}

module.exports = { logTokenUsage };
