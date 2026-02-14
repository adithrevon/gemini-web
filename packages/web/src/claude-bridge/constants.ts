/**
 * Constants for Claude bridge
 */

export const MESSAGE_TYPE = 'gemini' as const;

export const LIMITS = {
  MAX_COMMAND_PREVIEW: 120,
  MAX_URL_PREVIEW: 80,
} as const;

export const TOOL_NAMES = {
  BASH: 'Bash',
  READ: 'Read',
  WRITE: 'Write',
  EDIT: 'Edit',
  GLOB: 'Glob',
  GREP: 'Grep',
  WEB_SEARCH: 'WebSearch',
  WEB_FETCH: 'WebFetch',
  TASK: 'Task',
  TODO_WRITE: 'TodoWrite',
} as const;
