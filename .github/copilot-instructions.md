# LM Studio Provider Extension - Copilot Instructions

## Project Overview

This is a VS Code extension that integrates LM Studio with GitHub Copilot Chat as a language model provider. It enables users to use local LM Studio models directly within Copilot Chat.

## Project Structure

```
lmstudio_plugin/
├── src/
│   ├── extension.ts           # Main extension activation
│   └── lmstudio-provider.ts   # Language model provider implementation
├── package.json               # Extension metadata and dependencies
├── tsconfig.json              # TypeScript configuration
└── README.md                  # User documentation
```

## Key Implementation Details

- **Provider Name**: `lm-studio`
- **API Endpoint**: Configurable, defaults to `http://localhost:12345/v1`
- **Supports**: Streaming chat completions, model enumeration, token counting
- **VS Code API**: `vscode.lm.registerLanguageModelChatProvider`

## Setup Checklist

- [x] Project structure created
- [x] Scaffolding completed
- [x] Dependencies installed
- [x] Project compiled
- [ ] Extension tested
- [x] Documentation completed

## Next Steps

1. Run `npm install` to install dependencies
2. Run `npm run compile` to compile TypeScript
3. Press F5 to test the extension
4. Verify models appear in Copilot Chat
