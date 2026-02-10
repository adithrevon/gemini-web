# Claude Agent SDK — Future Features

Features the Claude Agent SDK supports that are **not implemented** in this
initial integration. To revisit later.

| Feature                            | SDK API                                                          | Description                                                         |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Tool confirmation UI**           | `canUseTool` callback, `permissionMode: 'default'`               | Interactive approve/deny for tool calls (we bypass all permissions) |
| **Cost & usage tracking**          | `SDKResultMessage.total_cost_usd`, `.usage`, `.modelUsage`       | Per-turn and total cost in USD, token counts per model              |
| **Extended thinking**              | `maxThinkingTokens` option, thinking content blocks              | Claude's chain-of-thought reasoning visible in responses            |
| **File checkpointing & rewinding** | `enableFileCheckpointing`, `rewindFiles()`                       | Track file changes, restore to previous state                       |
| **Structured outputs**             | `outputFormat: { type: 'json_schema', schema }`                  | Force JSON output matching a schema                                 |
| **MCP server management**          | `mcpServers` option, `mcpServerStatus()`, `reconnectMcpServer()` | Connect external tool servers                                       |
| **Subagents / Task delegation**    | `agents` option, Task tool                                       | Define specialized sub-agents for complex tasks                     |
| **Plan mode**                      | `permissionMode: 'plan'`                                         | Read-only planning mode                                             |
| **Slash commands**                 | `supportedCommands()`                                            | /help, /context, /compact, etc.                                     |
| **Hook system**                    | `hooks` option with 12+ event types                              | Pre/post tool use callbacks, session lifecycle events               |
| **Account info**                   | `accountInfo()`                                                  | Email, org, subscription type                                       |
| **Session forking**                | `forkSession: true`                                              | Branch conversations to explore alternatives                        |
| **Plugin system**                  | `plugins` option                                                 | Load custom plugins                                                 |
| **Sandbox configuration**          | `sandbox` option                                                 | Restrict command execution, network access                          |
| **AskUserQuestion tool**           | Built-in tool with multiple choice UI                            | Claude asks user clarifying questions with options                  |
| **Todo/task management**           | TodoWrite tool                                                   | Structured task list tracking                                       |
| **Context compaction**             | `SDKCompactBoundaryMessage`                                      | Automatic context window management indicators                      |
| **1M context window**              | `betas: ['context-1m-2025-08-07']`                               | Extended context for large codebases                                |
| **Web search/fetch**               | WebSearch, WebFetch tools                                        | Search the web and fetch pages (tools work but no special UI)       |
