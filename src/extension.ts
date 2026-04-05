import * as vscode from 'vscode';
import { LMStudioChatProvider } from './lmstudio-provider';

let lmStudioProvider: LMStudioChatProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('LM Studio Provider extension activated');

    lmStudioProvider = new LMStudioChatProvider();

    try {
        const disposable = vscode.lm.registerLanguageModelChatProvider('lmstudio', lmStudioProvider);
        context.subscriptions.push(disposable);
        console.log('Language model provider registered');
    } catch (error) {
        console.error('Failed to register provider:', error);
    }

    setTimeout(() => {
        lmStudioProvider?.forceRefresh();
        console.log('Initial model refresh triggered');
    }, 100);

    const diagnosticCommand = vscode.commands.registerCommand('lmstudio.diagnose', async () => {
        console.log('Running diagnostics');

        const diagnostics: string[] = [];
        diagnostics.push('=== LM Studio Provider Diagnostics ===\n');
        diagnostics.push('1. Extension Status: ACTIVE\n');
        diagnostics.push('2. Fetching models from LM Studio...');

        try {
            const tokenSource = new vscode.CancellationTokenSource();
            const models = await lmStudioProvider?.provideLanguageModelChatInformation(
                { silent: false },
                tokenSource.token
            );
            tokenSource.dispose();

            if (models && models.length > 0) {
                diagnostics.push(`   Found ${models.length} chat models:`);
                for (const model of models) {
                    diagnostics.push(`   - ${formatModelDiagnostic(model)}`);
                }
            } else {
                diagnostics.push('   No chat models found');
                diagnostics.push('   Check that LM Studio is running at http://localhost:12345');
            }
        } catch (error) {
            diagnostics.push(`   Error: ${error}`);
        }

        diagnostics.push('');
        diagnostics.push('3. Provider Status: registered as LM Studio');

        try {
            const registeredModels = await vscode.lm.selectChatModels({ vendor: 'lmstudio' });
            diagnostics.push(`   VS Code sees ${registeredModels.length} LM Studio chat models`);
            for (const model of registeredModels) {
                diagnostics.push(`   - ${formatRegisteredModelDiagnostic(model)}`);
            }
        } catch (error) {
            diagnostics.push(`   Unable to query registered models: ${error}`);
        }

        diagnostics.push('');
        diagnostics.push('4. Expected Result');
        diagnostics.push('   If the models above show tools enabled, they should appear in the Copilot Chat agent-mode picker after a full VS Code restart.');

        const outputChannel = vscode.window.createOutputChannel('LM Studio Diagnostics');
        outputChannel.clear();
        outputChannel.append(diagnostics.join('\n'));
        outputChannel.show();

        void vscode.window.showInformationMessage('LM Studio diagnostics complete. Check the output panel.');
    });

    const testCommand = vscode.commands.registerCommand('lmstudio.testModels', async () => {
        console.log('Testing LM Studio models');

        const tokenSource = new vscode.CancellationTokenSource();
        const models = await lmStudioProvider?.provideLanguageModelChatInformation(
            { silent: false },
            tokenSource.token
        );
        tokenSource.dispose();

        if (!models || models.length === 0) {
            void vscode.window.showWarningMessage(
                'No LM Studio models found.\n\nMake sure LM Studio is running and the API is reachable at http://localhost:12345.'
            );
            return;
        }

        const modelList = models.map(model => `- ${model.id}`).join('\n');
        void vscode.window.showInformationMessage(`Found ${models.length} LM Studio models:\n\n${modelList}`);
    });

    const setApiBaseCommand = vscode.commands.registerCommand('lmstudio.setApiBase', async () => {
        const config = vscode.workspace.getConfiguration('lmstudio');
        const currentUrl = config.get<string>('apiBase') || 'http://localhost:12345';

        const nextUrl = await vscode.window.showInputBox({
            title: 'LM Studio Server URL',
            prompt: 'Enter the LM Studio base URL',
            value: currentUrl,
            placeHolder: 'http://localhost:12345',
            ignoreFocusOut: true,
            validateInput: value => validateApiBase(value)
        });

        if (!nextUrl) {
            return;
        }

        const normalizedUrl = normalizeApiBase(nextUrl);
        await config.update('apiBase', normalizedUrl, vscode.ConfigurationTarget.Global);
        lmStudioProvider?.forceRefresh();
        void vscode.window.showInformationMessage(`LM Studio server URL set to ${normalizedUrl}`);
    });

    const configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('lmstudio.apiBase')) {
            return;
        }

        console.log('LM Studio API base changed, refreshing models');
        lmStudioProvider?.forceRefresh();
    });

    context.subscriptions.push(diagnosticCommand, testCommand, setApiBaseCommand, configurationListener);
    console.log('LM Studio Provider initialized');
}

export function deactivate() {
    lmStudioProvider?.dispose();
    console.log('LM Studio Provider deactivated');
}

function formatModelDiagnostic(model: vscode.LanguageModelChatInformation): string {
    const capabilities = [
        model.capabilities.toolCalling ? 'tools' : 'no-tools',
        model.capabilities.imageInput ? 'vision' : 'text'
    ].join(', ');

    return `${model.id} | input ${model.maxInputTokens} | output ${model.maxOutputTokens} | ${capabilities}`;
}

function formatRegisteredModelDiagnostic(model: vscode.LanguageModelChat): string {
    return `${model.id} | family ${model.family} | input ${model.maxInputTokens}`;
}

function normalizeApiBase(value: string): string {
    return value.trim().replace(/\/+$/, '').replace(/\/v1\/?$/, '');
}

function validateApiBase(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return 'Enter a URL like http://localhost:12345';
    }

    try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return 'Only http and https URLs are supported';
        }
    } catch {
        return 'Enter a valid URL like http://localhost:12345';
    }

    return undefined;
}
