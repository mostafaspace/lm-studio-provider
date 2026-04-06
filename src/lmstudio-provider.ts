import * as vscode from 'vscode';

interface LMStudioOpenAIModel {
    id: string;
    object: string;
}

interface LMStudioOpenAIModelsResponse {
    object: string;
    data: LMStudioOpenAIModel[];
}

interface LMStudioLegacyApiModel {
    id: string;
    object: string;
    type?: string;
    arch?: string;
    max_context_length?: number;
    capabilities?: string[];
}

interface LMStudioLegacyApiModelsResponse {
    object: string;
    data: LMStudioLegacyApiModel[];
}

interface LMStudioCurrentModelCapabilities {
    vision?: boolean;
    trained_for_tool_use?: boolean;
}

interface LMStudioCurrentLoadedInstance {
    id: string;
    config?: {
        context_length?: number;
    };
}

interface LMStudioCurrentApiModel {
    type: string;
    key: string;
    display_name?: string;
    architecture?: string;
    max_context_length?: number;
    loaded_instances?: LMStudioCurrentLoadedInstance[];
    capabilities?: LMStudioCurrentModelCapabilities;
}

interface LMStudioCurrentApiModelsResponse {
    models: LMStudioCurrentApiModel[];
}

interface LMStudioProviderConfiguration {
    url?: string;
}

type LMStudioApiModel = LMStudioLegacyApiModel | LMStudioCurrentApiModel;
type OpenAIRole = 'assistant' | 'system' | 'tool' | 'user';

interface OpenAIChatCompletionToolCall {
    id?: string;
    type?: 'function';
    function?: {
        name?: string;
        arguments?: string;
    };
}

interface OpenAIChatCompletionContentPartText {
    type: 'text';
    text: string;
}

interface OpenAIChatCompletionContentPartImage {
    type: 'image_url';
    image_url: {
        url: string;
    };
}

type OpenAIChatCompletionContentPart = OpenAIChatCompletionContentPartText | OpenAIChatCompletionContentPartImage;

interface OpenAIChatCompletionMessage {
    role: OpenAIRole;
    content?: string | null | OpenAIChatCompletionContentPart[];
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIChatCompletionToolCall[];
}

interface OpenAIChatCompletionToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: object;
    };
}

type OpenAIChatCompletionToolChoice =
    | 'auto'
    | 'required';

interface OpenAIChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: OpenAIChatCompletionToolCall[];
        };
    }>;
}

interface ParsedToolCall {
    callId: string;
    name: string;
    input: object;
}

interface ParsedToolCallCollection {
    toolCalls: ParsedToolCall[];
    consumedContent: boolean;
    visibleContent?: string;
}

export interface LMStudioModelDefinition {
    id: string;
    name: string;
    url: string;
    family: string;
    maxContextLength: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    toolCalling: boolean;
    vision: boolean;
}

export class LMStudioChatProvider implements vscode.LanguageModelChatProvider {
    private static readonly MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
    private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000;
    private static readonly DEFAULT_API_BASE = 'http://localhost:1234';

    private apiBase = LMStudioChatProvider.DEFAULT_API_BASE;
    private modelsCache: vscode.LanguageModelChatInformation[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private refreshInFlight: Promise<void> | undefined;
    private lastRefreshAt = 0;

    readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

    constructor() {
        console.log('Initializing LM Studio provider');
        void this.refreshModels();
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }

    forceRefresh(): void {
        console.log('Force refreshing models');
        void this.refreshModels();
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions & { configuration?: LMStudioProviderConfiguration },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (token.isCancellationRequested) {
            return [];
        }

        this.apiBase = this.resolveApiBase(options.configuration);

        if (this.modelsCache.length === 0 || this.isModelCacheStale()) {
            await this.refreshModels();
        }

        console.log(`provideLanguageModelChatInformation returning ${this.modelsCache.length} models`);
        return this.modelsCache;
    }

    async getModelDefinitions(configuration?: LMStudioProviderConfiguration): Promise<LMStudioModelDefinition[]> {
        const apiBase = this.resolveApiBase(configuration);
        const models = await this.fetchAvailableModels(apiBase);

        return models
            .filter(model => this.isChatModel(model))
            .map(model => this.toModelDefinition(apiBase, model));
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions & { modelConfiguration?: LMStudioProviderConfiguration },
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        try {
            this.apiBase = this.resolveApiBase(options.modelConfiguration);

            if (options.tools?.length && !model.capabilities.toolCalling) {
                throw new Error(
                    'LM Studio agent mode is disabled for this model. Enable lmstudio.enableExperimentalAgentMode to opt in to local tool calling.'
                );
            }

            const convertedMessages = this.convertMessages(messages);

            if (this.shouldUseToolCallingRequest(options)) {
                const loopOrchestrator: OpenAIChatCompletionMessage = {
                    role: 'system',
                    content: `[URGENT AGENTIC DIRECTIVE]
You are a relentless, autonomous agent operating within VS Code. Your goal is to COMPLETE the user's request exhaustively.
CRITICAL RULES:
1. TASK LIST: You MUST maintain a step-by-step markdown task list at the beginning of your response. Use [ ] for pending, [/] for in-progress, and [x] for completed tasks.
2. THINKING: You MUST write out your reasoning before taking any action. 
3. NO REPETITION: You MUST read previous tool results. NEVER repeat identical file reads or actions. If a file is read, analyze it and move on.
4. CONTINUOUS EXECUTION: NEVER stop, summarize prematurely, or ask for permission. If the task is not 100% complete, you MUST continue calling the required tools.
5. EXPLICIT TOOL EXECUTION: Instead of just talking about what you will do, YOU MUST IMMEDIATELY OUTPUT A TOOL CALL to do it.
Act like a premium autonomous agent. Use tools iteratively until the entire job is done.`
                };
                convertedMessages.unshift(loopOrchestrator);

                await this.provideToolCallingResponse(model, convertedMessages, options, progress, token);
                return;
            }

            await this.provideStreamingTextResponse(model, convertedMessages, options, progress, token);
        } catch (error) {
            throw new Error(`Failed to get response from LM Studio: ${error}`);
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        const value = typeof text === 'string' ? text : this.getMessageText(text);
        return Math.ceil(value.length / 4);
    }

    private async provideStreamingTextResponse(
        model: vscode.LanguageModelChatInformation,
        messages: OpenAIChatCompletionMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const request = this.createAbortController(token);

        const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model.id,
                messages,
                stream: true,
                ...(options.modelOptions?.temperature !== undefined && { temperature: options.modelOptions.temperature }),
                ...(options.modelOptions?.top_p !== undefined && { top_p: options.modelOptions.top_p }),
                max_tokens: -1
            }),
            signal: request.controller.signal
        });

        if (!response.ok || !response.body) {
            throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let startedReasoning = false;
        let finishedReasoning = false;
        let unparsedText = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) {
                        continue;
                    }

                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') {
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta) {
                            continue;
                        }

                        if (delta.reasoning_content) {
                            if (!startedReasoning) {
                                progress.report(new vscode.LanguageModelTextPart('<details><summary>🧠 Thinking Process</summary>\n\n'));
                                startedReasoning = true;
                            }
                            progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
                        }

                        if (delta.content) {
                            if (startedReasoning && !finishedReasoning) {
                                progress.report(new vscode.LanguageModelTextPart('\n\n</details>\n\n'));
                                finishedReasoning = true;
                            }
                            unparsedText += delta.content;
                            let safeToYield = '';
                            const lastLt = unparsedText.lastIndexOf('<');
                            if (lastLt !== -1 && unparsedText.length - lastLt < 10) {
                                safeToYield = unparsedText.substring(0, lastLt);
                                unparsedText = unparsedText.substring(lastLt);
                            } else {
                                safeToYield = unparsedText;
                                unparsedText = '';
                            }
                            if (safeToYield) {
                                safeToYield = safeToYield.replace(/<think>/g, '\n\n<details><summary>🧠 Thinking Process</summary>\n\n');
                                safeToYield = safeToYield.replace(/<\/think>/g, '\n\n</details>\n\n');
                                progress.report(new vscode.LanguageModelTextPart(safeToYield));
                            }
                        }
                    } catch {
                        // Ignore partial stream frames that are not valid JSON on their own.
                    }
                }
            }
            if (unparsedText) {
                unparsedText = unparsedText.replace(/<think>/g, '\n\n<details><summary>🧠 Thinking Process</summary>\n\n');
                unparsedText = unparsedText.replace(/<\/think>/g, '\n\n</details>\n\n');
                progress.report(new vscode.LanguageModelTextPart(unparsedText));
            }
        } finally {
            request.dispose();
            reader.releaseLock();
        }
    }

    private async provideToolCallingResponse(
        model: vscode.LanguageModelChatInformation,
        messages: OpenAIChatCompletionMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const request = this.createAbortController(token);

        const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model.id,
                messages,
                stream: true,
                temperature: options.modelOptions?.temperature ?? 0,
                ...(options.modelOptions?.top_p !== undefined && { top_p: options.modelOptions.top_p }),
                max_tokens: -1,
                tools: this.convertTools(options.tools ?? []),
                tool_choice: this.convertToolChoice(options.toolMode)
            }),
            signal: request.controller.signal
        });

        if (!response.ok || !response.body) {
            throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const streamedNativeToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
        let fullContent = '';
        let fullReasoning = '';
        let lastReportTime = Date.now();
        let startedReasoning = false;
        let finishedReasoning = false;
        let unparsedText = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                let hasReported = false;

                for (const line of lines) {
                    if (!line.startsWith('data: ')) {
                        continue;
                    }

                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') {
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta) {
                            continue;
                        }

                        if (delta.reasoning_content) {
                            if (!startedReasoning) {
                                progress.report(new vscode.LanguageModelTextPart('<details><summary>🧠 Thinking Process</summary>\n\n'));
                                startedReasoning = true;
                            }
                            fullReasoning += delta.reasoning_content;
                            progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
                            hasReported = true;
                        }

                        if (delta.content) {
                            if (startedReasoning && !finishedReasoning) {
                                progress.report(new vscode.LanguageModelTextPart('\n\n</details>\n\n'));
                                finishedReasoning = true;
                            }
                            fullContent += delta.content;
                            unparsedText += delta.content;
                            let safeToYield = '';
                            const lastLt = unparsedText.lastIndexOf('<');
                            if (lastLt !== -1 && unparsedText.length - lastLt < 10) {
                                safeToYield = unparsedText.substring(0, lastLt);
                                unparsedText = unparsedText.substring(lastLt);
                            } else {
                                safeToYield = unparsedText;
                                unparsedText = '';
                            }
                            if (safeToYield) {
                                safeToYield = safeToYield.replace(/<think>/g, '\n\n<details><summary>🧠 Thinking Process</summary>\n\n');
                                safeToYield = safeToYield.replace(/<\/think>/g, '\n\n</details>\n\n');
                                progress.report(new vscode.LanguageModelTextPart(safeToYield));
                            }
                            hasReported = true;
                        }

                        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                            for (const tc of delta.tool_calls) {
                                const index = tc.index;
                                if (!streamedNativeToolCalls.has(index)) {
                                    streamedNativeToolCalls.set(index, {
                                        id: tc.id ?? '',
                                        name: tc.function?.name ?? '',
                                        arguments: tc.function?.arguments ?? ''
                                    });
                                } else {
                                    const existing = streamedNativeToolCalls.get(index)!;
                                    if (tc.id) existing.id += tc.id;
                                    if (tc.function?.name) existing.name += tc.function.name;
                                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                                }
                            }
                        }
                    } catch {
                        // Ignore partial JSON
                    }
                }

                if (!hasReported && Date.now() - lastReportTime > 5000) {
                    progress.report(new vscode.LanguageModelTextPart(''));
                    lastReportTime = Date.now();
                } else if (hasReported) {
                    lastReportTime = Date.now();
                }
            }

            if (unparsedText) {
                unparsedText = unparsedText.replace(/<think>/g, '\n\n***🧠 Thinking Process:***\n\n');
                unparsedText = unparsedText.replace(/<\/think>/g, '\n\n---\n\n');
                progress.report(new vscode.LanguageModelTextPart(unparsedText));
            }

            const nativeToolCalls = Array.from(streamedNativeToolCalls.values());
            if (nativeToolCalls.length > 0) {
                const parsedNative = this.parseStructuredToolCalls(nativeToolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.arguments
                    }
                })));

                for (const toolCall of parsedNative) {
                    progress.report(new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input));
                }
            } else {
                const parsedToolCalls = this.extractToolCalls({ content: fullContent, reasoning_content: fullReasoning });
                for (const toolCall of parsedToolCalls.toolCalls) {
                    progress.report(new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input));
                }
            }
        } finally {
            request.dispose();
            reader.releaseLock();
        }
    }

    private async refreshModels(): Promise<void> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        this.refreshInFlight = this.doRefreshModels();
        try {
            await this.refreshInFlight;
        } finally {
            this.refreshInFlight = undefined;
        }
    }

    private async doRefreshModels(): Promise<void> {
        try {
            const models = await this.getModelDefinitions();
            console.log(`Fetched ${models.length} models from LM Studio`);

            const newInfo = models.map(model => ({
                id: model.id,
                name: model.name,
                family: model.family,
                version: '1.0.0',
                detail: 'LM Studio',
                tooltip: `${model.name} is contributed via the LM Studio provider.`,
                maxInputTokens: model.maxInputTokens,
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    toolCalling: model.toolCalling,
                    imageInput: model.vision
                } as vscode.LanguageModelChatCapabilities
            }));

            if (JSON.stringify(newInfo) !== JSON.stringify(this.modelsCache)) {
                this.modelsCache = newInfo;
                this.changeEmitter.fire();
                console.log(`Models cache updated: ${newInfo.length} models available`);
            }

            this.lastRefreshAt = Date.now();
        } catch (error) {
            console.error('Error refreshing LM Studio models:', error);
        }
    }

    private async fetchAvailableModels(apiBase: string): Promise<LMStudioApiModel[]> {
        this.apiBase = apiBase;
        return this.tryFetchAvailableModels(apiBase);
    }

    private normalizeApiModelsResponse(response: LMStudioLegacyApiModelsResponse | LMStudioCurrentApiModelsResponse): LMStudioApiModel[] {
        if ('models' in response && Array.isArray(response.models)) {
            return response.models;
        }

        if ('data' in response && Array.isArray(response.data)) {
            return response.data;
        }

        return [];
    }

    private resolveApiBase(configuration?: LMStudioProviderConfiguration): string {
        const configuredUrl = configuration?.url?.trim();
        if (configuredUrl) {
            return configuredUrl.replace(/\/v1\/?$/, '');
        }

        const config = vscode.workspace.getConfiguration('lmstudio');
        const settingsUrl = config.get<string>('apiBase')?.trim();
        if (settingsUrl) {
            return settingsUrl.replace(/\/v1\/?$/, '');
        }

        return LMStudioChatProvider.DEFAULT_API_BASE;
    }

    private async tryFetchAvailableModels(apiBase: string): Promise<LMStudioApiModel[]> {
        try {
            console.log(`Fetching models from ${apiBase}/api/v1/models`);
            const response = await fetch(`${apiBase}/api/v1/models`);
            if (!response.ok) {
                throw new Error(`Failed to fetch API models: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as LMStudioLegacyApiModelsResponse | LMStudioCurrentApiModelsResponse;
            const models = this.normalizeApiModelsResponse(data);
            console.log(`Received ${models.length} models from LM Studio via ${apiBase}/api/v1/models`);
            return models;
        } catch (error) {
            console.warn(`Failed ${apiBase}/api/v1/models, trying /v1/models instead:`, error);
        }

        try {
            console.log(`Fetching models from ${apiBase}/v1/models`);
            const response = await fetch(`${apiBase}/v1/models`);
            if (!response.ok) {
                throw new Error(`Failed to fetch OpenAI models: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as LMStudioOpenAIModelsResponse;
            const models = (data.data || []).map(model => ({
                id: model.id,
                object: model.object,
                max_context_length: 131072
            }));
            console.log(`Received ${models.length} models from LM Studio via ${apiBase}/v1/models`);
            return models;
        } catch (error) {
            console.warn(`Failed ${apiBase}/v1/models:`, error);
            return [];
        }
    }

    private isChatModel(model: LMStudioApiModel): boolean {
        const type = model.type?.toLowerCase();
        return type !== 'embedding' && type !== 'embeddings';
    }

    private toModelDefinition(apiBase: string, model: LMStudioApiModel): LMStudioModelDefinition {
        const modelId = this.getModelId(model);
        const maxContextLength = Math.max(this.getMaxContextLength(model), 4096);
        const maxOutputTokens = this.estimateMaxOutputTokens(maxContextLength);

        return {
            id: modelId,
            name: this.getModelName(model),
            url: apiBase,
            family: this.getModelFamily(modelId, model),
            maxContextLength,
            maxInputTokens: Math.max(1024, maxContextLength - maxOutputTokens),
            maxOutputTokens,
            toolCalling: this.supportsToolCalling(model),
            vision: this.supportsVision(model)
        };
    }

    private getModelId(model: LMStudioApiModel): string {
        if ('id' in model) {
            return model.id;
        }

        return model.key;
    }

    private getModelName(model: LMStudioApiModel): string {
        if ('display_name' in model && model.display_name) {
            return model.display_name;
        }

        return this.getModelId(model);
    }

    private getMaxContextLength(model: LMStudioApiModel): number {
        const configContext = vscode.workspace.getConfiguration('lmstudio').get<number>('maxContextTokens', 32768);
        return configContext > 0 ? configContext : (model.max_context_length || 131072);
    }

    private estimateMaxOutputTokens(maxContextLength: number): number {
        if (maxContextLength >= 262144) {
            return 16384;
        }

        if (maxContextLength >= 131072) {
            return 8192;
        }

        if (maxContextLength >= 32768) {
            return 4096;
        }

        return 2048;
    }

    private supportsToolCalling(model: LMStudioApiModel): boolean {
        if (!this.isExperimentalAgentModeEnabled()) {
            return false;
        }

        if ('capabilities' in model && Array.isArray(model.capabilities)) {
            return model.capabilities.includes('tool_use');
        }

        if ('capabilities' in model && !Array.isArray(model.capabilities)) {
            return !!model.capabilities?.trained_for_tool_use;
        }

        return false;
    }

    private supportsVision(model: LMStudioApiModel): boolean {
        if ('capabilities' in model && !Array.isArray(model.capabilities)) {
            return !!model.capabilities?.vision;
        }

        return model.type === 'vlm';
    }

    private isModelCacheStale(): boolean {
        return (Date.now() - this.lastRefreshAt) > LMStudioChatProvider.MODEL_CACHE_TTL_MS;
    }

    private shouldUseToolCallingRequest(options: vscode.ProvideLanguageModelChatResponseOptions): boolean {
        return !!options.tools?.length;
    }

    private convertTools(tools: readonly vscode.LanguageModelChatTool[]): OpenAIChatCompletionToolDefinition[] {
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema ?? {
                    type: 'object',
                    properties: {}
                }
            }
        }));
    }

    private convertToolChoice(toolMode: vscode.LanguageModelChatToolMode): OpenAIChatCompletionToolChoice {
        if (toolMode === vscode.LanguageModelChatToolMode.Required) {
            return 'required';
        }

        return 'auto';
    }

    private simplifyContent(parts: OpenAIChatCompletionContentPart[]): string | OpenAIChatCompletionContentPart[] | null {
        if (parts.length === 0) return null;
        if (parts.length === 1 && parts[0].type === 'text') {
            return parts[0].text;
        }

        const hasVision = parts.some(p => p.type === 'image_url');
        if (!hasVision) {
            return parts.map(p => (p as OpenAIChatCompletionContentPartText).text).join('');
        }

        return [...parts];
    }

    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatCompletionMessage[] {
        const converted: OpenAIChatCompletionMessage[] = [];

        for (const message of messages) {
            const openAiParts: OpenAIChatCompletionContentPart[] = [];
            const textParts: string[] = [];
            const assistantToolCalls: OpenAIChatCompletionToolCall[] = [];

            const flushText = () => {
                const combined = textParts.join('');
                if (combined) {
                    openAiParts.push({ type: 'text', text: combined });
                }
                textParts.length = 0;
            };

            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                    continue;
                }

                if (typeof part === 'string') {
                    textParts.push(part);
                    continue;
                }

                if (part instanceof vscode.LanguageModelDataPart) {
                    if (part.mimeType.startsWith('image/')) {
                        flushText();
                        const base64 = Buffer.from(part.data).toString('base64');
                        openAiParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${part.mimeType};base64,${base64}` }
                        });
                    }
                    continue;
                }

                if (part instanceof vscode.LanguageModelToolCallPart && message.role === vscode.LanguageModelChatMessageRole.Assistant) {
                    assistantToolCalls.push({
                        id: part.callId,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: JSON.stringify(part.input ?? {})
                        }
                    });
                    continue;
                }

                if (part instanceof vscode.LanguageModelToolResultPart && message.role === vscode.LanguageModelChatMessageRole.User) {
                    flushText();
                    
                    if (openAiParts.length > 0) {
                        converted.push({
                            role: 'user',
                            content: this.simplifyContent(openAiParts),
                            name: message.name
                        });
                        openAiParts.length = 0;
                    }

                    converted.push({
                        role: 'tool',
                        content: this.getToolResultText(part),
                        tool_call_id: part.callId
                    });
                }
            }

            flushText();

            if (assistantToolCalls.length > 0) {
                converted.push({
                    role: 'assistant',
                    content: this.simplifyContent(openAiParts),
                    name: message.name,
                    tool_calls: assistantToolCalls
                });
                continue;
            }

            if (openAiParts.length > 0) {
                converted.push({
                    role: this.toOpenAIRole(message.role),
                    content: this.simplifyContent(openAiParts),
                    name: message.name
                });
            }
        }

        return converted;
    }

    private getMessageText(message: vscode.LanguageModelChatRequestMessage): string {
        return message.content
            .map(part => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    return part.value;
                }

                if (typeof part === 'string') {
                    return part;
                }

                return '';
            })
            .join('');
    }

    private getToolResultText(part: vscode.LanguageModelToolResultPart): string {
        return part.content
            .map(item => {
                if (item instanceof vscode.LanguageModelTextPart) {
                    return item.value;
                }

                if (typeof item === 'string') {
                    return item;
                }

                if (typeof item === 'object' && item !== null) {
                    try {
                        return JSON.stringify(item);
                    } catch {
                        return '';
                    }
                }

                return '';
            })
            .join('');
    }

    private parseToolCallInput(rawArguments: string | undefined): object {
        if (!rawArguments?.trim()) {
            return {};
        }

        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }

            return { value: parsed };
        } catch (error) {
            console.warn('Failed to parse LM Studio tool-call arguments:', error);
            return { raw: rawArguments };
        }
    }

    private getOpenAIMessageText(content: string | null | undefined | OpenAIChatCompletionContentPart[]): string {
        if (!content) {
            return '';
        }
        if (typeof content === 'string') {
            return content;
        }
        return content.map(part => part.type === 'text' ? part.text : '').join('');
    }

    private extractToolCalls(message: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIChatCompletionToolCall[] }): ParsedToolCallCollection {
        const structuredCalls = this.parseStructuredToolCalls(message.tool_calls ?? []);
        if (structuredCalls.length > 0) {
            return {
                toolCalls: structuredCalls,
                consumedContent: true,
                visibleContent: ''
            };
        }

        const contentToolCalls = this.parseToolCallsFromText(message.content, 'content_tool_call');
        if (contentToolCalls.toolCalls.length > 0) {
            return contentToolCalls;
        }

        const reasoningToolCalls = this.parseToolCallsFromText(message.reasoning_content, 'reasoning_tool_call');
        if (reasoningToolCalls.toolCalls.length > 0) {
            return reasoningToolCalls;
        }

        return {
            toolCalls: [],
            consumedContent: false,
            visibleContent: this.getOpenAIMessageText(message.content)
        };
    }

    private parseStructuredToolCalls(toolCalls: OpenAIChatCompletionToolCall[]): ParsedToolCall[] {
        return toolCalls
            .map((toolCall, index) => {
                const name = toolCall.function?.name?.trim();
                if (!name) {
                    return undefined;
                }

                return {
                    callId: toolCall.id ?? `tool_call_${index + 1}`,
                    name,
                    input: this.parseToolCallInput(toolCall.function?.arguments)
                };
            })
            .filter((toolCall): toolCall is ParsedToolCall => !!toolCall);
    }

    private parseToolCallsFromText(rawText: string | null | undefined, callIdPrefix: string): ParsedToolCallCollection {
        const text = this.getOpenAIMessageText(rawText);
        if (!text) {
            return {
                toolCalls: [],
                consumedContent: false,
                visibleContent: ''
            };
        }

        const xmlMatches = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
        const toolCalls: ParsedToolCall[] = [];

        for (let index = 0; index < xmlMatches.length; index += 1) {
            const parsed = this.parseSingleToolCallBlock(xmlMatches[index][1], `${callIdPrefix}_${index + 1}`);
            if (parsed) {
                toolCalls.push(parsed);
            }
        }

        if (toolCalls.length > 0) {
            return {
                toolCalls,
                consumedContent: true,
                visibleContent: this.stripToolCallMarkup(text).trim()
            };
        }

        const fencedToolCalls = this.parseFencedJsonToolCalls(text, callIdPrefix);
        if (fencedToolCalls.toolCalls.length > 0) {
            return fencedToolCalls;
        }

        const jsonToolCall = this.parseStandaloneJsonToolCall(text, `${callIdPrefix}_1`);
        if (jsonToolCall) {
            return {
                toolCalls: [jsonToolCall],
                consumedContent: true,
                visibleContent: ''
            };
        }

        return {
            toolCalls: [],
            consumedContent: false,
            visibleContent: text
        };
    }

    private parseFencedJsonToolCalls(text: string, callIdPrefix: string): ParsedToolCallCollection {
        const fenceMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
        const toolCalls: ParsedToolCall[] = [];

        for (let index = 0; index < fenceMatches.length; index += 1) {
            const block = fenceMatches[index][1]?.trim();
            if (!block) {
                continue;
            }

            const parsed = this.parseStandaloneJsonToolCall(block, `${callIdPrefix}_${index + 1}`);
            if (parsed) {
                toolCalls.push(parsed);
            }
        }

        if (toolCalls.length === 0) {
            return {
                toolCalls: [],
                consumedContent: false,
                visibleContent: text
            };
        }

        return {
            toolCalls,
            consumedContent: true,
            visibleContent: text.replace(/```(?:json)?\s*[\s\S]*?```/g, '').trim()
        };
    }

    private stripToolCallMarkup(text: string): string {
        return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    }

    private addToolCallingSystemPrompt(messages: OpenAIChatCompletionMessage[]): OpenAIChatCompletionMessage[] {
        const instruction: OpenAIChatCompletionMessage = {
            role: 'system',
            content: [
                'When tools are available, never print tool calls as JSON, XML, markdown code fences, or pseudocode.',
                'If a tool is needed, call it directly.',
                'Do not narrate the tool call or restate its arguments.',
                'Never repeat the same tool call after a tool result unless the previous result explicitly says to retry.',
                'If you include user-visible text in the same turn, keep it to a single brief sentence.'
            ].join(' ')
        };

        const firstSystemIndex = messages.findIndex(message => message.role === 'system');
        if (firstSystemIndex === -1) {
            return [instruction, ...messages];
        }

        const mergedMessages = [...messages];
        const existingContent = this.getOpenAIMessageText(mergedMessages[firstSystemIndex].content);
        mergedMessages[firstSystemIndex] = {
            ...mergedMessages[firstSystemIndex],
            content: existingContent
                ? `${existingContent}\n\n${instruction.content}`
                : instruction.content
        };
        return mergedMessages;
    }

    private parseSingleToolCallBlock(block: string, callId: string): ParsedToolCall | undefined {
        const trimmedBlock = block.trim();
        const jsonToolCall = this.parseStandaloneJsonToolCall(trimmedBlock, callId);
        if (jsonToolCall) {
            return jsonToolCall;
        }

        const xmlFunctionMatch = trimmedBlock.match(/<function=([^>\s]+)>([\s\S]*?)<\/function>/);
        if (!xmlFunctionMatch) {
            return undefined;
        }

        const name = xmlFunctionMatch[1].trim();
        if (!name) {
            return undefined;
        }

        const input: Record<string, unknown> = {};
        const parameterMatches = [...xmlFunctionMatch[2].matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)];
        for (const parameterMatch of parameterMatches) {
            const parameterName = parameterMatch[1].trim();
            if (!parameterName) {
                continue;
            }

            input[parameterName] = this.parseLooseValue(parameterMatch[2].trim());
        }

        return {
            callId,
            name,
            input
        };
    }

    private parseStandaloneJsonToolCall(rawText: string, callId: string): ParsedToolCall | undefined {
        try {
            const parsed = JSON.parse(rawText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return undefined;
            }

            const candidate = parsed as { name?: unknown; toolName?: unknown; arguments?: unknown; input?: unknown };
            const name = typeof candidate.name === 'string'
                ? candidate.name
                : typeof candidate.toolName === 'string'
                    ? candidate.toolName
                    : undefined;

            if (!name) {
                return undefined;
            }

            return {
                callId,
                name,
                input: this.normalizeToolCallInput(candidate.arguments ?? candidate.input ?? {})
            };
        } catch {
            return undefined;
        }
    }

    private normalizeToolCallInput(input: unknown): object {
        if (!input) {
            return {};
        }

        if (typeof input === 'string') {
            return this.parseToolCallInput(input);
        }

        if (typeof input === 'object' && !Array.isArray(input)) {
            return input;
        }

        return { value: input };
    }

    private parseLooseValue(value: string): unknown {
        if (!value) {
            return '';
        }

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    private getVisibleAssistantContent(
        message: { content?: string | null; reasoning_content?: string | null },
        consumedContent: boolean,
        visibleContent?: string
    ): string {
        if (consumedContent) {
            return visibleContent?.trim() ?? '';
        }

        return this.getOpenAIMessageText(message.content);
    }

    private joinTextParts(parts: string[]): string | null {
        const combined = parts.join('');
        return combined.length > 0 ? combined : null;
    }

    private toOpenAIRole(role: vscode.LanguageModelChatMessageRole): Exclude<OpenAIRole, 'tool'> {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.Assistant:
                return 'assistant';
            case vscode.LanguageModelChatMessageRole.User:
                return 'user';
            default:
                return 'system';
        }
    }

    private isExperimentalAgentModeEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('lmstudio');
        return config.get<boolean>('enableExperimentalAgentMode', false);
    }

    private getRequestTimeoutMs(): number {
        const config = vscode.workspace.getConfiguration('lmstudio');
        const configuredSeconds = config.get<number>('requestTimeoutSeconds');
        if (typeof configuredSeconds === 'number' && Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
            return Math.max(5, configuredSeconds) * 1000;
        }

        return LMStudioChatProvider.DEFAULT_REQUEST_TIMEOUT_MS;
    }

    private createAbortController(token: vscode.CancellationToken): { controller: AbortController; dispose: () => void } {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.getRequestTimeoutMs());
        const cancellationSubscription = token.onCancellationRequested(() => controller.abort());

        return {
            controller,
            dispose: () => {
                clearTimeout(timeoutHandle);
                cancellationSubscription.dispose();
            }
        };
    }

    private getModelFamily(modelId: string, model: LMStudioApiModel): string {
        if ('architecture' in model && model.architecture) {
            return model.architecture;
        }

        if ('arch' in model && model.arch) {
            return model.arch;
        }

        const normalized = modelId.trim();
        if (!normalized) {
            return 'lmstudio';
        }

        const slashIndex = normalized.indexOf('/');
        if (slashIndex > 0) {
            return normalized.slice(0, slashIndex);
        }

        const dashIndex = normalized.indexOf('-');
        if (dashIndex > 0) {
            return normalized.slice(0, dashIndex);
        }

        return normalized;
    }
}
