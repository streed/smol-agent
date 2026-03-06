/**
 * LLM-based conversation summarization.
 * 
 * Based on research from Aider and other coding agents:
 * - Uses LLM to create intelligent summaries preserving key context
 * - Maintains file/function/library names mentioned
 * - Writes from user's first-person perspective
 * - Progressive summarization (older = shorter)
 */

import { logger } from './logger.js';

/**
 * Summarize old messages using an LLM call.
 * This preserves important context like file names, function names, and decisions made.
 */
export async function summarizeMessagesWithLLM(messages, ollamaHost, model) {
  // Build the content to summarize
  let content = '';
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (role === 'USER') {
      content += `# USER\n${msg.content}\n\n`;
    } else if (role === 'ASSISTANT') {
      // For assistant messages with tool calls, include the tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name).filter(Boolean).join(', ');
        content += `# ASSISTANT (called: ${toolNames})\n${msg.content || '(tool calls)'}\n\n`;
      } else if (msg.content) {
        content += `# ASSISTANT\n${msg.content}\n\n`;
      }
    } else if (role === 'TOOL' && msg.content) {
      // Include truncated tool results
      const truncated = msg.content.length > 200 
        ? msg.content.substring(0, 200) + '...(truncated)'
        : msg.content;
      content += `# TOOL RESULT\n${truncated}\n\n`;
    }
  }

  const summarizePrompt = `Briefly summarize this partial conversation about programming.
Include less detail about older parts and more detail about the most recent messages.
Start a new paragraph every time the topic changes!

This is only part of a longer conversation so DO NOT conclude the summary with language like "Finally, ...". Because the conversation continues after the summary.
The summary MUST include the function names, libraries, packages that are being discussed.
The summary MUST include the filenames that are being referenced by the assistant inside \`\`\`...\`\`\` fenced code blocks!
The summaries MUST NOT include \`\`\`...\`\`\` fenced code blocks!

Phrase the summary with the USER in first person, telling the ASSISTANT about the conversation.
Write *as* the user.

Conversation to summarize:

${content}`;

  try {
    const host = ollamaHost || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

    // Try a smaller/faster model for summarization if available
    let summarizationModel = model;
    if (model.includes('32b') || model.includes('70b') || model.includes('72b')) {
      const candidate = model.replace(/32b|70b|72b/, '7b');
      try {
        const checkResp = await fetch(`${host}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: candidate }),
        });
        if (checkResp.ok) {
          summarizationModel = candidate;
          logger.debug(`Using smaller model for summarization: ${candidate}`);
        }
      } catch {
        // Model check failed, use original model
      }
    }

    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: summarizationModel,
        messages: [
          { role: 'system', content: 'You are a helpful assistant that summarizes programming conversations concisely.' },
          { role: 'user', content: summarizePrompt },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Summarization API error: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.message?.content || '';
    
    logger.info(`LLM summarization created summary of ${messages.length} messages (${summary.length} chars)`);
    
    return `I spoke to you previously about a number of things.
${summary}`;
  } catch (error) {
    logger.warn(`LLM summarization failed: ${error.message}`);
    // Fall back to simple summarization
    return createSimpleSummary(messages);
  }
}

/**
 * Create a simple summary without LLM (faster, less context-aware).
 */
function createSimpleSummary(messages) {
  const topics = [];
  const files = new Set();
  const tools = new Set();

  for (const msg of messages) {
    // Extract file references
    const fileMatches = msg.content?.match(/\b[\w/.-]+\.(js|ts|py|json|md|txt|yml|yaml)\b/g) || [];
    fileMatches.forEach(f => files.add(f));

    // Track tools used
    if (msg.tool_calls) {
      msg.tool_calls.forEach(tc => {
        if (tc.function?.name) tools.add(tc.function.name);
      });
    }

    // Get user topics (first 50 chars of user messages)
    if (msg.role === 'user' && msg.content) {
      topics.push(msg.content.substring(0, 50).replace(/\n/g, ' '));
    }
  }

  const parts = [`${messages.length} earlier messages compacted.`];
  
  if (files.size > 0) {
    const fileList = [...files].slice(0, 5).join(', ');
    parts.push(`Files: ${fileList}${files.size > 5 ? '...' : ''}.`);
  }
  
  if (tools.size > 0) {
    parts.push(`Tools used: ${[...tools].join(', ')}.`);
  }
  
  if (topics.length > 0) {
    parts.push(`Recent topics: ${topics.slice(-2).join(' | ')}`);
  }

  return `[Context compacted: ${parts.join(' ')}]`;
}

/**
 * Decide which messages to summarize based on token budget.
 * Returns { toSummarize, toKeep } where toKeep are the most recent messages.
 */
const MIN_KEEP_MESSAGES = 6;

export function selectMessagesToSummarize(messages, targetTokens, estimateMessageTokensFn) {
  // Always keep system message
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const conversationMsgs = systemMsg ? messages.slice(1) : messages;

  // Find split point - keep recent messages up to targetTokens
  let tokenCount = 0;
  let splitIndex = conversationMsgs.length;

  for (let i = conversationMsgs.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokensFn(conversationMsgs[i]);
    if (tokenCount + msgTokens > targetTokens) {
      splitIndex = i + 1;
      break;
    }
    tokenCount += msgTokens;
  }

  // Ensure we always keep at least MIN_KEEP_MESSAGES recent messages
  const maxSplitIndex = Math.max(0, conversationMsgs.length - MIN_KEEP_MESSAGES);
  if (splitIndex > maxSplitIndex) {
    splitIndex = maxSplitIndex;
  }

  // Adjust split to end at an assistant message (for conversation continuity)
  while (splitIndex > 1 && conversationMsgs[splitIndex - 1]?.role !== 'assistant') {
    splitIndex--;
  }

  const toKeep = conversationMsgs.slice(splitIndex);
  const toSummarize = conversationMsgs.slice(0, splitIndex);

  return {
    toSummarize,
    toKeep,
    systemMsg,
  };
}

export default {
  summarizeMessagesWithLLM,
  selectMessagesToSummarize,
  createSimpleSummary,
};