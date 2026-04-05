# LM Studio Provider for VS Code Copilot Chat

This extension integrates LM Studio with GitHub Copilot Chat, allowing you to use local language models directly in VS Code without needing external APIs.

## Features

- 🚀 **Seamless Integration**: LM Studio models appear directly in Copilot Chat's model selector
- 📱 **Auto-Discovery**: Auto-detects available models from your LM Studio instance
- 💻 **Pure Local**: Run models locally with zero external dependencies
- ⚙️ **Configurable**: Custom LM Studio server URL support
- 🔄 **Real-time Updates**: Models are refreshed automatically

## Requirements

- VS Code 1.90.0 or later
- [LM Studio](https://lmstudio.ai/) running locally (default: `http://localhost:12345`)
- GitHub Copilot Chat extension
- A model loaded in LM Studio

## Installation

1. Clone or download this extension to your machine
2. Run `npm install` in the extension directory
3. Run `npm run compile` to build
4. Press `F5` in VS Code to launch in debug mode
5. Or package as .vsix: `npx vsce package`

## Quick Start

1. **Start LM Studio** and load a model
2. **Install this extension** (or launch with F5 in development mode)
3. **Open Copilot Chat** in VS Code (Ctrl+Shift+I)
4. **Click the model selector** at the top of the chat panel
5. **Select your LM Studio model** from the dropdown
6. **Start chatting!** Your local model will process all requests

## Configuration

Add this to your VS Code settings (`settings.json`) if your LM Studio is on a different host:

```json
{
  "lmstudio.apiBase": "http://localhost:12345"
}
```

## Troubleshooting

### Models not appearing in Copilot Chat

1. **Verify LM Studio is running:**
   ```bash
   curl http://localhost:12345/v1/models
   ```
   Should return a JSON list of models.

2. **Check the diagnostic command:**
   - Press `Ctrl+Shift+P`
   - Run: `LM Studio: Run Diagnostics`
   - Check the output panel for detailed information

3. **Reload VS Code:**
   - Press `Ctrl+R` to reload the VS Code window

4. **Test the extension:**
   - Run: `LM Studio: Test Available Models` from command palette

### Connection errors

- Ensure LM Studio's API is accessible at the configured address
- Check firewall settings (port 12345 by default)
- Verify you can reach the endpoint: `http://localhost:12345/v1/models`

### Models found but chat not working

- Make sure a model is **loaded** in LM Studio (not just installed)
- Check that LM Studio's API is responding to requests
- Look at VS Code's debug console (F1 → "Debug: Toggle Debug Console") for error messages

## How It Works

The extension implements VS Code's `LanguageModelChatProvider` API to:

1. **Discover Models** - Queries LM Studio's `/v1/models` endpoint at startup and periodically
2. **Register with Copilot** - Registers as an Ollama provider (which Copilot Chat recognizes)
3. **Stream Responses** - Forwards chat requests to LM Studio's OpenAI-compatible API
4. **Handle Streaming** - Streams responses back to Copilot Chat in real-time

## Architecture

- **`src/extension.ts`** - Main entry point, registers the provider with Copilot Chat
- **`src/lmstudio-provider.ts`** - Implements the `LanguageModelChatProvider` interface
- **`package.json`** - Defines the extension manifest and commands

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript to JavaScript
npm run compile

# Watch for changes and auto-compile
npm run watch

# Run linter
npm run lint

# Test the extension
npm test
```

## Commands

The extension provides these commands in VS Code:

- **`LM Studio: Test Available Models`** - Verify models are discoverable
- **`LM Studio: Run Diagnostics`** - Detailed diagnostic information

Access these via `Ctrl+Shift+P` (Command Palette).

## Limitations

- Copilot Chat in stable VS Code displays LM Studio models as "Ollama" models (they work identically)
- Token counting is estimated (1 token ≈ 4 characters)
- Requires LM Studio to be running - connection is not cached

## API Compatibility

This extension uses LM Studio's OpenAI-compatible API. Tested with:
- LM Studio 0.2.x and later
- OpenAI API format: `/v1/chat/completions`
- Common models: Llama, Mistral, Qwen, Gemma, etc.

## Contributing

Contributions welcome! Please feel free to submit issues or pull requests.

## License

MIT

## Support

- **LM Studio Issues**: Visit [lmstudio.ai](https://lmstudio.ai/)
- **VS Code API**: [VS Code Extension API Docs](https://code.visualstudio.com/api)
- **GitHub Issues**: Create an issue in this repository

## FAQs

**Q: Why do my models show as "Ollama" models?**
A: Copilot Chat in stable VS Code only recognizes certain vendors (Ollama, OpenAI, etc.). We register as Ollama for compatibility, but it's actually connecting to LM Studio.

**Q: Can I use this with a remote LM Studio server?**
A: Yes! Change `lmstudio.apiBase` in settings to point to your remote server (e.g., `http://192.168.1.100:12345`).

**Q: Will this work in VS Code Insiders?**
A: Yes, and in the future, Insiders may display LM Studio natively without the Ollama label.

**Q: How do I load a model in LM Studio?**
A: Open LM Studio, select a model from the catalog, click "Load", and wait for it to load into memory.

