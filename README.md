# LM Studio Provider for VS Code

Use local LM Studio models in VS Code chat through the `LanguageModelChatProvider` API.

This extension discovers chat-capable models from LM Studio, exposes them to VS Code under the `lmstudio` vendor, and forwards chat requests to LM Studio's OpenAI-compatible `/v1/chat/completions` endpoint.

## Features

- Automatic model discovery from LM Studio
- Uses LM Studio context metadata instead of hardcoded placeholder limits
- Filters out embedding-only models from chat registration
- Periodically refreshes available models while VS Code is running
- Includes built-in diagnostics for provider and model visibility

## Requirements

- VS Code `1.90.0` or later
- LM Studio running locally or on a reachable host
- LM Studio API enabled, defaulting to `http://localhost:12345`
- GitHub Copilot Chat installed in VS Code

## Installation

### From source

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

### As an installed extension

Package and install the extension:

```bash
npx vsce package
```

Then install the generated `.vsix` in VS Code.

## Configuration

Set the LM Studio base URL in your VS Code settings if you are not using the default host:

```json
{
  "lmstudio.apiBase": "http://localhost:12345"
}
```

## Usage

1. Start LM Studio.
2. Make sure the LM Studio local server is enabled.
3. Open VS Code with this extension installed.
4. Open chat and pick an LM Studio model from the model selector.

If you changed the extension manifest or installed a new `.vsix`, fully restart VS Code instead of using `Reload Window`.

## Commands

- `LM Studio: Run Diagnostics`
- `LM Studio: Test Available Models`
- `LM Studio: Set Server URL`

## Troubleshooting

### Check the LM Studio API

```bash
curl http://localhost:12345/api/v1/models
```

You should see LM Studio's model inventory. Chat models should have `type: "llm"`. Embedding models are intentionally ignored by this extension.

### Run diagnostics inside VS Code

Use `LM Studio: Run Diagnostics` from the Command Palette. The output shows:

- whether the extension is active
- which models the extension discovered from LM Studio
- which models VS Code currently sees under the `lmstudio` vendor

### Models do not appear in the picker

- Confirm LM Studio is reachable at the configured URL.
- Confirm you restarted VS Code after installing or updating the extension.
- Confirm the diagnostics command lists the expected models.
- If diagnostics finds models but the picker does not update, close all VS Code windows and launch VS Code again.

## Development

```bash
npm install
npm run compile
npm run watch
```

## Project structure

- `src/extension.ts` registers the provider and commands
- `src/lmstudio-provider.ts` discovers LM Studio models and serves chat responses
- `package.json` defines the extension manifest and contributions

## License

MIT
