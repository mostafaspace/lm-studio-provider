import * as vscode from 'vscode';
import { LMStudioChatProvider } from './lmstudio-provider';

let lmStudioProvider: LMStudioChatProvider | undefined;
let connectionPanel: vscode.WebviewPanel | undefined;

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
        const config = vscode.workspace.getConfiguration('lmstudio');
        const experimentalAgentMode = config.get<boolean>('enableExperimentalAgentMode', false);
        const requestTimeoutSeconds = config.get<number>('requestTimeoutSeconds', 120);

        const diagnostics: string[] = [];
        diagnostics.push('=== LM Studio Provider Diagnostics ===\n');
        diagnostics.push('1. Extension Status: ACTIVE\n');
        diagnostics.push(`2. Configuration: agent mode ${experimentalAgentMode ? 'ENABLED' : 'DISABLED'} | timeout ${requestTimeoutSeconds}s\n`);
        diagnostics.push('3. Fetching models from LM Studio...');

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
                diagnostics.push('   Check that LM Studio is running at http://localhost:1234');
            }
        } catch (error) {
            diagnostics.push(`   Error: ${error}`);
        }

        diagnostics.push('');
        diagnostics.push('4. Provider Status: registered as LM Studio');

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
        diagnostics.push('5. Expected Result');
        if (experimentalAgentMode) {
            diagnostics.push('   Tool-capable LM Studio models should appear in the Copilot Chat agent-mode picker after a full VS Code restart.');
        } else {
            diagnostics.push('   LM Studio models stay available for normal chat. Enable lmstudio.enableExperimentalAgentMode if you want them to appear in agent/autopilot mode.');
        }

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
                'No LM Studio models found.\n\nMake sure LM Studio is running and the API is reachable at http://localhost:1234.'
            );
            return;
        }

        const modelList = models.map(model => `- ${model.id}`).join('\n');
        void vscode.window.showInformationMessage(`Found ${models.length} LM Studio models:\n\n${modelList}`);
    });

    const setApiBaseCommand = vscode.commands.registerCommand('lmstudio.setApiBase', async () => {
        openConnectionPanel(context);
    });

    const configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (
            !event.affectsConfiguration('lmstudio.apiBase') &&
            !event.affectsConfiguration('lmstudio.enableExperimentalAgentMode') &&
            !event.affectsConfiguration('lmstudio.maxContextTokens') &&
            !event.affectsConfiguration('lmstudio.requestTimeoutSeconds')
        ) {
            return;
        }

        console.log('LM Studio configuration changed, refreshing models');
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

function getConfiguredApiBase(): string {
    const config = vscode.workspace.getConfiguration('lmstudio');
    return config.get<string>('apiBase') || 'http://localhost:1234';
}

function validateApiBase(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return 'Enter a URL like http://localhost:1234';
    }

    try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return 'Only http and https URLs are supported';
        }
    } catch {
        return 'Enter a valid URL like http://localhost:1234';
    }

    return undefined;
}

function openConnectionPanel(context: vscode.ExtensionContext): void {
    if (connectionPanel) {
        connectionPanel.reveal(vscode.ViewColumn.One);
        void postConnectionState(connectionPanel);
        return;
    }

    connectionPanel = vscode.window.createWebviewPanel(
        'lmstudioConnection',
        'LM Studio Connection',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    connectionPanel.webview.html = getConnectionPanelHtml(connectionPanel.webview, context.extensionUri);

    connectionPanel.onDidDispose(() => {
        connectionPanel = undefined;
    });

    connectionPanel.webview.onDidReceiveMessage(async message => {
        switch (message.type) {
            case 'ready':
                await postConnectionState(connectionPanel);
                break;
            case 'save':
                await saveApiBaseFromPanel(connectionPanel, message.value);
                break;
            case 'test':
                await testApiBaseFromPanel(connectionPanel, message.value);
                break;
            case 'reset':
                await saveApiBaseFromPanel(connectionPanel, 'http://localhost:1234');
                break;
            default:
                break;
        }
    });
}

async function postConnectionState(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }

    await panel.webview.postMessage({
        type: 'state',
        value: getConfiguredApiBase()
    });
}

async function saveApiBaseFromPanel(panel: vscode.WebviewPanel | undefined, rawValue: string): Promise<void> {
    const validationError = validateApiBase(rawValue);
    if (validationError) {
        await panel?.webview.postMessage({
            type: 'result',
            level: 'error',
            message: validationError
        });
        return;
    }

    const normalizedUrl = normalizeApiBase(rawValue);
    const config = vscode.workspace.getConfiguration('lmstudio');
    await config.update('apiBase', normalizedUrl, vscode.ConfigurationTarget.Global);
    lmStudioProvider?.forceRefresh();

    await panel?.webview.postMessage({
        type: 'state',
        value: normalizedUrl
    });
    await panel?.webview.postMessage({
        type: 'result',
        level: 'success',
        message: `Saved ${normalizedUrl}`
    });
}

async function testApiBaseFromPanel(panel: vscode.WebviewPanel | undefined, rawValue: string): Promise<void> {
    const validationError = validateApiBase(rawValue);
    if (validationError) {
        await panel?.webview.postMessage({
            type: 'result',
            level: 'error',
            message: validationError
        });
        return;
    }

    const normalizedUrl = normalizeApiBase(rawValue);

    try {
        const response = await fetch(`${normalizedUrl}/api/v1/models`);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as { models?: Array<{ type?: string }> };
        const chatModels = (payload.models || []).filter(model => {
            const type = model.type?.toLowerCase();
            return type !== 'embedding' && type !== 'embeddings';
        });

        await panel?.webview.postMessage({
            type: 'result',
            level: 'success',
            message: `Connection works. Found ${chatModels.length} chat model${chatModels.length === 1 ? '' : 's'}.`
        });
    } catch (error) {
        await panel?.webview.postMessage({
            type: 'result',
            level: 'error',
            message: `Could not reach ${normalizedUrl}: ${error}`
        });
    }
}

function getConnectionPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LM Studio Connection</title>
    <style>
        :root {
            color-scheme: light dark;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 24px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background:
                radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-button-background) 18%, transparent), transparent 28%),
                linear-gradient(180deg, var(--vscode-editor-background), color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background)));
        }

        .shell {
            max-width: 760px;
            margin: 0 auto;
            display: grid;
            gap: 18px;
        }

        .hero,
        .card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 18px;
            background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background));
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
        }

        .hero {
            padding: 24px;
            display: grid;
            gap: 10px;
        }

        .eyebrow {
            width: fit-content;
            padding: 6px 10px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
            color: var(--vscode-button-foreground);
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        h1 {
            margin: 0;
            font-size: 28px;
            line-height: 1.15;
        }

        p {
            margin: 0;
            line-height: 1.55;
            color: var(--vscode-descriptionForeground);
        }

        .card {
            padding: 22px;
            display: grid;
            gap: 16px;
        }

        label {
            font-weight: 600;
        }

        .field {
            display: grid;
            gap: 10px;
        }

        input[type="url"] {
            width: 100%;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 12px;
            padding: 14px 16px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            outline: none;
            font: inherit;
        }

        input[type="url"]:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        .row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }

        button {
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            cursor: pointer;
            font: inherit;
            transition: transform 140ms ease, opacity 140ms ease, background 140ms ease;
        }

        button:hover {
            transform: translateY(-1px);
        }

        button:active {
            transform: translateY(0);
        }

        button.primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        button.secondary {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
        }

        button.ghost {
            color: var(--vscode-foreground);
            background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 55%, transparent);
            border: 1px solid var(--vscode-panel-border);
        }

        .status {
            min-height: 24px;
            padding: 12px 14px;
            border-radius: 12px;
            border: 1px solid transparent;
            font-size: 13px;
            line-height: 1.45;
        }

        .status.neutral {
            color: var(--vscode-descriptionForeground);
            background: color-mix(in srgb, var(--vscode-sideBar-background) 55%, transparent);
            border-color: var(--vscode-panel-border);
        }

        .status.success {
            color: var(--vscode-testing-iconPassed);
            background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
            border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 35%, transparent);
        }

        .status.error {
            color: var(--vscode-errorForeground);
            background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
            border-color: color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent);
        }

        .meta {
            display: grid;
            gap: 8px;
            padding-top: 4px;
        }

        .meta-item {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 10px 0;
            border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
        }

        .meta-item:first-child {
            border-top: 0;
            padding-top: 0;
        }

        .meta-key {
            color: var(--vscode-descriptionForeground);
        }

        .meta-value {
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
            word-break: break-all;
            text-align: right;
        }
    </style>
</head>
<body>
    <main class="shell">
        <section class="hero">
            <div class="eyebrow">LM Studio</div>
            <h1>Connection Settings</h1>
            <p>Change the LM Studio server URL, test the connection, and save it without opening JSON settings files.</p>
        </section>

        <section class="card">
            <div class="field">
                <label for="apiBase">Server URL</label>
                <input id="apiBase" type="url" spellcheck="false" placeholder="http://localhost:1234" />
                <p>Use the LM Studio base URL. The extension will normalize trailing <code>/v1</code> automatically.</p>
            </div>

            <div class="row">
                <button class="primary" id="saveButton">Save</button>
                <button class="secondary" id="testButton">Test Connection</button>
                <button class="ghost" id="resetButton">Reset Default</button>
            </div>

            <div class="status neutral" id="status" role="status" aria-live="polite">Ready.</div>

            <div class="meta">
                <div class="meta-item">
                    <span class="meta-key">Configured URL</span>
                    <span class="meta-value" id="configuredUrl">http://localhost:1234</span>
                </div>
                <div class="meta-item">
                    <span class="meta-key">Saved in</span>
                    <span class="meta-value">VS Code user settings</span>
                </div>
            </div>
        </section>
    </main>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('apiBase');
        const status = document.getElementById('status');
        const configuredUrl = document.getElementById('configuredUrl');
        const saveButton = document.getElementById('saveButton');
        const testButton = document.getElementById('testButton');
        const resetButton = document.getElementById('resetButton');

        function setStatus(level, message) {
            status.className = 'status ' + level;
            status.textContent = message;
        }

        saveButton.addEventListener('click', () => {
            setStatus('neutral', 'Saving connection settings...');
            vscode.postMessage({ type: 'save', value: input.value });
        });

        testButton.addEventListener('click', () => {
            setStatus('neutral', 'Testing connection...');
            vscode.postMessage({ type: 'test', value: input.value });
        });

        resetButton.addEventListener('click', () => {
            input.value = 'http://localhost:1234';
            setStatus('neutral', 'Resetting to the default LM Studio URL...');
            vscode.postMessage({ type: 'reset' });
        });

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'state') {
                input.value = message.value;
                configuredUrl.textContent = message.value;
                setStatus('neutral', 'Ready.');
            }

            if (message.type === 'result') {
                setStatus(message.level, message.message);
                if (message.level === 'success') {
                    configuredUrl.textContent = input.value.trim() || configuredUrl.textContent;
                }
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i += 1) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
}
