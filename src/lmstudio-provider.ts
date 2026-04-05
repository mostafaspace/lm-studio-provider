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
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());

            const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model.id,
                    messages: convertedMessages,
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

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) {
                            continue;
                        }

                        const data = line.slice(6);
                        if (data === '[DONE]') {
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
        const displayName = 'display_name' in model && model.display_name
            ? model.display_name
            : this.getModelId(model);

        return `LM Studio: ${displayName}`;
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

    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]) {
        return messages.map(message => ({
            role: this.toOpenAIRole(message.role),
            content: this.getMessageText(message)
        }));
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

    private toOpenAIRole(role: vscode.LanguageModelChatMessageRole): 'assistant' | 'system' | 'user' {
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
