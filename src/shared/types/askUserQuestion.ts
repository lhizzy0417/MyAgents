/**
 * AskUserQuestion types - shared between frontend and backend
 * Based on SDK's AskUserQuestionInput structure
 */

export interface AskUserQuestionOption {
  label: string;
  description: string;
  /** Optional preview content rendered when this option is focused (HTML or Markdown) */
  preview?: string;
}

export interface AskUserQuestion {
  /** Runtime-native question id. Omitted by older builtin callers, present for Codex app-server. */
  id?: string;
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  /** Optional fields can be skipped by the user. Omitted means required for legacy callers. */
  required?: boolean;
  /** Render custom text input as password/secret input. */
  isSecret?: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
  answers?: Record<string, string>;
  metadata?: { source?: string };
}

/**
 * Request sent to frontend for user interaction
 */
export interface AskUserQuestionRequest {
  requestId: string;
  questions: AskUserQuestion[];
  /** Content format for option previews: 'html' or 'markdown' */
  previewFormat?: 'html' | 'markdown';
}
