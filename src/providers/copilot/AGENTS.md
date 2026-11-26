# GitHub Copilot constraints

Behaviour below was verified against `@github/copilot` 1.0.114 (ACP public preview) over `copilot --acp --stdio`; recheck it when Copilot's ACP changes.

## Process and sessions

- Authentication is native: never call ACP `authenticate` or store GitHub credentials. Failures point to `copilot login` (or a `COPILOT_PROVIDER_*` model provider).
- New conversations use `session/new` and publish the id at once; bindings reopen with `session/load`, which answers `-32002 Resource not found` for unknown ids (missing session: keep the binding). Load replays the conversation as `session/update`s; that replay is never live output.
- Copilot has no ACP system-prompt field and reads custom instruction files once per process. Claudian's literal instructions go in `copilodian.instructions.md` inside a per-process temporary directory appended to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; native instruction files keep applying. A different instruction text or tool restriction replaces the process and reloads the session there. Remove the directory with its process.
- Passive sessions launch with `--available-tools=<unknown name>`, which leaves no tools; `--available-tools=` (empty) restricts nothing. Copilot reports the filter as an `Info:` message chunk without a `messageId`; such notices are not shown.
- Prompt-less sessions are not listed by Copilot but leave an empty `session-state/<id>` directory; only discovery creates them.
- Copilot's `ask_user` tool is not offered over ACP, even with client elicitation; Claudian has no question router for Copilot.

## Configuration and permissions

- Session config options are authoritative: `model`, `reasoning_effort` (category `thought_level`, reported only for the current model), `mode` (always native Agent; never Plan or Autopilot) and `allow_all`. Set an option only when it differs and only when the session offers it.
- YOLO is native `allow_all=on`; Accept edits is answered client-side for permission requests of kind `edit`. Copilot reads files without asking.
- MCP tool calls are titled `<server>-<tool>` in tool updates but only `<tool>` in permission requests. Claudian's session tools are auto-allowed by that bare name.

## History

- Native history is `$COPILOT_HOME/session-state/<id>/events.jsonl` (`COPILOT_HOME` defaults to `~/.copilot`). Turns are `interactionId`s; `abort` marks the turn interrupted. Live ACP tool updates carry display titles, so live presentation derives Copilot's native tool names from ACP kind and raw input to match history.
