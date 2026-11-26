# Copilodian

<p>
  <img src="https://img.shields.io/github/v/release/F1orian/copilodian" alt="GitHub release" vspace="10">
  <img src="https://img.shields.io/github/license/F1orian/copilodian" alt="License" vspace="10">
</p>

![Preview](assets/Preview.png)

An Obsidian plugin that embeds the [GitHub Copilot CLI](https://github.com/github/copilot-cli) in your vault. Your vault becomes the agent's working directory — file read/write, search, bash, and multi-step workflows all work out of the box.

Copilodian is a fork of [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu. It ships with GitHub Copilot as the only enabled provider; Claudian's other providers (Claude Code, Codex, Grok Build, Antigravity CLI, OpenCode, Pi, DeepSeek Harness) are still built in and can be enabled under Settings → Providers. Copilodian keeps its own data in the vault's `.copilodian/` folder, so it can be installed beside Claudian without sharing settings or sessions.

## Features & Usage

Open Copilodian from the ribbon icon or command palette. Talk to the agent, and it reads, writes, edits, searches and runs commands in your vault.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Projects** — Group sessions that work toward a shared goal. Every member shares the project's instructions and a memory file that the agents keep current, and the agents can cooperate by finding, reading and messaging each other. See the [Projects guide](docs/projects.md).

**Zen Mode** — Collapse the sidebar holding Copilodian and the chat moves to a [compact composer](assets/zen-mode-collapsed.png) at the bottom of your notes, with a one-line activity preview and [the conversation one click away](assets/zen-mode-expanded.png).

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**@mention** — Type `@` to reference vault files, folders and other Copilodian sessions.

**Cross-Session Messaging** — Let agents read, message, steer or interrupt other Copilodian sessions, or start new ones. See the [Cross-session messaging guide](docs/cross-session-messaging.md).

**Side Chat (`/side` or `/btw`)** — Explore a separate, temporary conversation with follow-ups and tools while keeping the main chat unchanged.

**MCP Servers** — Connect external tools through the Copilot CLI's own MCP configuration.

**Tabs & Session Management** — Use multiple tabs in [single-pane mode](assets/main-chat-single-pane.png) or a persistent session manager beside the chat in [dual-pane mode](assets/main-chat-dual-pane.png).

**Plugin API (experimental)** — Let other Obsidian plugins send prompts to sessions, stop them and read their replies. See the [Plugin API guide](docs/plugin-api.md).

## Requirements

- [GitHub Copilot CLI](https://github.com/github/copilot-cli), signed in with `copilot login` (or configured with your own model provider through `COPILOT_PROVIDER_*`)
- A GitHub Copilot subscription, or an API provider configured for the Copilot CLI
- Obsidian v1.13.0+
- Desktop only (macOS, Linux, Windows)

## Installation

### With BRAT (recommended)

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community plugins
2. BRAT → Add beta plugin → enter `F1orian/copilodian`
3. Enable "Copilodian" under Settings → Community plugins
4. Open Settings → GitHub Copilot and choose the models to offer

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/F1orian/copilodian.git copilodian
   cd copilodian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Copilodian"

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs. With GitHub Copilot, data is sent to GitHub, or to the model provider configured for the Copilot CLI. If you enable another provider, data goes to that provider instead: Anthropic (Claude), OpenAI (Codex), xAI (Grok), Google (Antigravity), or the providers configured in OpenCode, Pi, or DeepSeek Harness. The destination can be configured through provider settings and environment variables.
- **No telemetry or unsolicited background activity**: Copilodian does not run telemetry beacons. UI polling timers read local Obsidian/editor selection state only. Network activity is limited to explicit provider runtime work, configured MCP endpoints, a 127.0.0.1-only listener that agent sessions use for Copilodian's session tools, provider SDK/CLI calls needed to answer your requests, and their configured services.

## Troubleshooting

See the [Troubleshooting guide](docs/troubleshooting.md) for a provider CLI or Node.js that isn't found, a newly released model that is missing, and authentication that fails while the CLI subscription works. If you run into a bug, please [submit a GitHub issue](https://github.com/F1orian/copilodian/issues).

## Architecture

```
src/
├── main.ts                      # Plugin entry point and sole composition root
├── composition/                 # Host objects and view wiring shared by app and features
├── app/                         # Startup, conversations, settings, and storage
├── core/                        # Provider-neutral execution, registry, and type contracts
│   ├── execution/               # Run, session snapshot, and interaction primitives
│   ├── providers/               # Provider registry and workspace services
│   ├── process/                 # CLI discovery and managed child processes
│   ├── prompt/                  # Prompt and context encoding
│   ├── auxiliary/               # Shared provider auxiliary services
│   └── ...                      # bootstrap, commands, rpc, security, storage, tools, types
├── providers/
│   ├── copilot/                 # GitHub Copilot CLI ACP adaptor, events.jsonl history, models
│   ├── acp/                     # Agent Client Protocol shared mechanics
│   └── ...                      # Claudian's other providers, disabled by default
├── features/
│   ├── agent-skills/            # Vault skill and Claude command management
│   ├── chat/                    # Sidebar chat: tabs, workspace lifecycle, controllers, renderers
│   ├── inline-edit/             # Inline edit modal and provider-backed edit services
│   └── settings/                # Settings shell and provider tabs
├── shared/                      # Reusable UI components, settings controls, mention/dropdown
├── i18n/                        # Internationalization (10 locales)
├── utils/                       # Domain-free leaf helpers
└── style/                       # Modular CSS
```

## Credits

Copilodian is built on [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu and keeps following its upstream development.

## License

Licensed under the [MIT License](LICENSE).
