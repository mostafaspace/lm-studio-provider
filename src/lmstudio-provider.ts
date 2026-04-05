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

interface OpenAIChatCompletionMessage {
    role: OpenAIRole;
    content?: string | null;
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
    private apiBase = 'http://localhost:12345';
    private modelsCache: vscode.LanguageModelChatInformation[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<void> | undefined;

    readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

    constructor() {
        console.log('Initializing LM Studio provider');
        void this.refreshModels();
        this.refreshTimer = setInterval(() => {
            void this.refreshModels();
        }, 5000);
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

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

        if (this.modelsCache.length === 0) {
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

            const convertedMessages = this.convertMessages(messages);
            if (this.shouldUseToolCallingRequest(options)) {
                await this.provideToolCallingResponse(model, convertedMessages, options, progress, token);
                return;
            }

            await this.provideStreamingTextResponse(model, convertedMessages, progress, token);
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
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model.id,
                messages,
                stream: true,
                temperature: 0.7,
                max_tokens: 2000
            }),
            signal: controller.signal
        });

        if (!response.ok || !response.body) {
            throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

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
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            progress.report(new vscode.LanguageModelTextPart(content));
                        }
                    } catch {
                        // Ignore partial stream frames that are not valid JSON on their own.
                    }
                }
            }
        } finally {
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
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model.id,
                messages,
                stream: false,
                temperature: 0.7,
                max_tokens: 2000,
                tools: this.convertTools(options.tools ?? []),
                tool_choice: this.convertToolChoice(options.toolMode)
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as OpenAIChatCompletionResponse;
        const message = payload.choices?.[0]?.message;
        if (!message) {
            return;
        }

        const parsedToolCalls = this.extractToolCalls(message);
        for (const toolCall of parsedToolCalls.toolCalls) {
            progress.report(new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input));
        }

        const content = this.getVisibleAssistantContent(message, parsedToolCalls.consumedContent);
        if (content) {
            progress.report(new vscode.LanguageModelTextPart(content));
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
        } catch (error) {
            console.error('Error refreshing LM Studio models:', error);
        }
    }

    private async fetchAvailableModels(apiBase: string): Promise<LMStudioApiModel[]> {
        this.apiBase = apiBase;

        try {
            console.log(`Fetching models from ${this.apiBase}/api/v1/models`);
            const response = await fetch(`${this.apiBase}/api/v1/models`);
            if (!response.ok) {
                throw new Error(`Failed to fetch API models: ${response.statusText}`);
            }

            const data = await response.json() as LMStudioLegacyApiModelsResponse | LMStudioCurrentApiModelsResponse;
            const models = this.normalizeApiModelsResponse(data);
            console.log(`Received ${models.length} models from LM Studio`);
            return models;
        } catch (error) {
            console.warn('Falling back to OpenAI-compatible /v1/models:', error);
        }

        try {
            const response = await fetch(`${this.apiBase}/v1/models`);
            if (!response.ok) {
                throw new Error(`Failed to fetch OpenAI models: ${response.statusText}`);
            }

            const data = await response.json() as LMStudioOpenAIModelsResponse;
            return (data.data || []).map(model => ({
                id: model.id,
                object: model.object,
                max_context_length: 131072
            }));
        } catch (error) {
            console.error('Error fetching models from LM Studio:', error);
            return [];
        }
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

        return 'http://localhost:12345';
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
        const baseContext = model.max_context_length || 131072;

        if ('loaded_instances' in model && Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0) {
            const loadedContext = model.loaded_instances[0]?.config?.context_length || 0;
            return Math.max(baseContext, loadedContext);
        }

        return baseContext;
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
        if ('capabilities' in model && Array.isArray(model.capabilities)) {
            return model.capabilities.includes('tool_use');
        }

        // VS Code gates agent-mode visibility on toolCalling. LM Studio's current
        // metadata reports training hints rather than transport support, so expose
        // chat-capable LLMs as tool-capable to keep them selectable.
        return this.isChatModel(model);
    }

    private supportsVision(model: LMStudioApiModel): boolean {
        if ('capabilities' in model && !Array.isArray(model.capabilities)) {
            return !!model.capabilities?.vision;
        }

        return model.type === 'vlm';
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

    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatCompletionMessage[] {
        const converted: OpenAIChatCompletionMessage[] = [];

        for (const message of messages) {
            const textParts: string[] = [];
            const assistantToolCalls: OpenAIChatCompletionToolCall[] = [];

            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                    continue;
                }

                if (typeof part === 'string') {
                    textParts.push(part);
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
                    const pendingText = this.joinTextParts(textParts);
                    if (pendingText) {
                        converted.push({
                            role: 'user',
                            content: pendingText,
                            name: message.name
                        });
                        textParts.length = 0;
                    }

                    converted.push({
                        role: 'tool',
                        content: this.getToolResultText(part),
                        tool_call_id: part.callId
                    });
                }
            }

            if (assistantToolCalls.length > 0) {
                converted.push({
                    role: 'assistant',
                    content: this.joinTextParts(textParts),
                    name: message.name,
                    tool_calls: assistantToolCalls
                });
                continue;
            }

            const content = this.joinTextParts(textParts);
            if (!content) {
                continue;
            }

            converted.push({
                role: this.toOpenAIRole(message.role),
                content,
                name: message.name
            });
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

    private getOpenAIMessageText(content: string | null | undefined): string {
        return typeof content === 'string' ? content : '';
    }

    private extractToolCalls(message: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIChatCompletionToolCall[] }): ParsedToolCallCollection {
        const structuredCalls = this.parseStructuredToolCalls(message.tool_calls ?? []);
        if (structuredCalls.length > 0) {
            return {
                toolCalls: structuredCalls,
                consumedContent: false
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
            consumedContent: false
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
                consumedContent: false
            };
        }

        const xmlMatches = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
        const toolCalls: ParsedToolCall[] = [];
        let consumedContent = false;

        for (let index = 0; index < xmlMatches.length; index += 1) {
            const parsed = this.parseSingleToolCallBlock(xmlMatches[index][1], `${callIdPrefix}_${index + 1}`);
            if (parsed) {
                toolCalls.push(parsed);
            }
        }

        if (toolCalls.length > 0) {
            consumedContent = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim().length === 0;
            return {
                toolCalls,
                consumedContent
            };
        }

        const jsonToolCall = this.parseStandaloneJsonToolCall(text, `${callIdPrefix}_1`);
        if (jsonToolCall) {
            return {
                toolCalls: [jsonToolCall],
                consumedContent: true
            };
        }

        return {
            toolCalls: [],
            consumedContent: false
        };
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
        consumedContent: boolean
    ): string {
        if (consumedContent) {
            return '';
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
