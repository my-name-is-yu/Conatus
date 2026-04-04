// ─── JSON Extraction (mirrors extractJSON in src/llm-client.ts exactly) ───
function extractJSON(text) {
    // Try ```json ... ``` block
    const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlock) {
        return jsonBlock[1].trim();
    }
    // Try generic ``` ... ``` block
    const genericBlock = text.match(/```\s*([\s\S]*?)```/);
    if (genericBlock) {
        return genericBlock[1].trim();
    }
    // Return as-is (bare JSON)
    return text.trim();
}
// ─── MockLLMClient class ───
class MockLLMClient {
    responses;
    _callCount = 0;
    _onCall;
    constructor(responses, onCall) {
        this.responses = responses;
        this._onCall = onCall;
    }
    get callCount() {
        return this._callCount;
    }
    async sendMessage(_messages, _options) {
        const index = this._callCount;
        this._callCount++;
        if (index >= this.responses.length) {
            throw new Error(`MockLLMClient: no response at index ${index} (only ${this.responses.length} responses configured)`);
        }
        const content = this.responses[index];
        // Invoke callback (e.g. to stop the daemon) after recording the call
        this._onCall?.();
        return {
            content,
            usage: {
                input_tokens: 10,
                output_tokens: content.length,
            },
            stop_reason: "end_turn",
        };
    }
    parseJSON(content, schema) {
        const jsonText = extractJSON(content);
        let raw;
        try {
            raw = JSON.parse(jsonText);
        }
        catch (err) {
            throw new Error(`MockLLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`);
        }
        return schema.parse(raw);
    }
}
// ─── Factory functions ───
/**
 * Create a mock ILLMClient that returns responses sequentially from the array.
 * Throws a descriptive error when responses are exhausted.
 * Exposes a `callCount` getter to track sendMessage invocations.
 *
 * Optional `onCall` callback is invoked after each sendMessage call (useful
 * for stopping a daemon from within the mock to avoid real-time waits).
 */
export function createMockLLMClient(responses, onCall) {
    return new MockLLMClient(responses, onCall);
}
/**
 * Convenience wrapper for a single-response mock.
 */
export function createSingleMockLLMClient(response) {
    return new MockLLMClient([response]);
}
//# sourceMappingURL=mock-llm.js.map