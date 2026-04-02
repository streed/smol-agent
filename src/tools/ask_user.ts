import { register } from "./registry.js";

// The ask_user tool resolves through a callback that the UI layer sets.
// When the agent calls ask_user, it emits a pending question; the UI
// collects the answer and resolves the promise via setAskHandler.

type AskHandler = (question: string) => Promise<string>;

let _askHandler: AskHandler | null = null;

/**
 * The UI layer calls this once to install its handler.
 * handler: (question: string) => Promise<string>
 */
export function setAskHandler(handler: AskHandler): void {
  _askHandler = handler;
}

/**
 * Get the current ask handler (used by other tools that need to ask questions)
 */
export function getAskHandler(): AskHandler | null {
  return _askHandler;
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
  async execute({ question }: { question: string }): Promise<{ answer: string }> {
    if (!_askHandler) {
      return { answer: "(no UI handler registered — cannot ask user)" };
    }
    const answer = (await _askHandler(question)) || "";
    return { answer: answer.trim() };
  },
});