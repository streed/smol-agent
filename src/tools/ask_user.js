import { register } from "./registry.js";

// The ask_user tool resolves through a callback that the UI layer sets.
// When the agent calls ask_user, it emits a pending question; the UI
// collects the answer and resolves the promise via setAskHandler.

let _askHandler = null;

/**
 * The UI layer calls this once to install its handler.
 * handler: (question: string) => Promise<string>
 */
export function setAskHandler(handler) {
  _askHandler = handler;
}

/**
 * Ask the user a yes/no question and return true if they answered yes.
 * Used internally by other tools (e.g. shell) to request one-time approval.
 * If no UI handler is registered, defaults to true (non-interactive mode).
 */
export async function requestPermission(question) {
  if (!_askHandler) return true;
  const answer = await _askHandler(question);
  return /^y(es)?$/i.test(answer.trim());
}

register("ask_user", {
  description:
    "Ask the user a question and wait for their response. Use this when you need clarification, want to confirm a destructive action, or need the user to choose between options.",
  parameters: {
    type: "object",
    required: ["question"],
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
    },
  },
  async execute({ question }) {
    if (!_askHandler) {
      return { answer: "(no UI handler registered — cannot ask user)" };
    }
    const answer = await _askHandler(question);
    return { answer: answer.trim() };
  },
});
