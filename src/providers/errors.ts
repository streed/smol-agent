/**
 * Shared error formatting utilities for LLM providers.
 *
 * Detects common error patterns across providers and returns
 * user-friendly error messages with actionable suggestions.
 *
 * Key exports:
 *   - formatAPIError(status, body, provider, envVar): Format HTTP errors
 *   - detectErrorType(error): Categorize errors for retry logic
 *
 * Dependencies: None (pure utility)
 * Depended on by: src/agent.js, src/constants.js, src/context-manager.js,
 *                 src/cross-agent.js, src/index.js, src/input-parser.js, src/logger.js,
 *                 src/providers/anthropic.js, src/providers/base.js, src/providers/openai-compatible.js,
 *                 src/shift-left.js, src/token-estimator.js, src/tools/registry.js,
 *                 src/tools/sub_agent.js, src/tools/web_search.js, src/ts-lint.js,
 *                 test/e2e/harness.js, test/unit/errors.test.js
 */

export interface FormattedError {
  message: string;
  actionable: string | null;
}

interface ErrorDetails {
  message?: string;
  error?: {
    message?: string;
    type?: string;
  };
  type?: string;
}

/**
 * Format a user-friendly error message based on HTTP status and error body.
 * Detects common error patterns across providers.
 *
 * @param status - HTTP status code
 * @param body - Response body text
 * @param provider - Provider name (for contextual messages)
 * @param envVar - Environment variable name for API key
 * @returns { message, actionable }
 */
export function formatAPIError(
  status: number,
  body: string,
  provider: string,
  envVar: string
): FormattedError {
  // Try to parse error details
  let errorDetails: ErrorDetails | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      errorDetails = parsed.error || parsed;
    } catch {
      // Keep raw body if short
      if (body.length < 500) {
        errorDetails = { message: body };
      }
    }
  }

  const errorMessage = errorDetails?.message || (errorDetails?.error as { message?: string })?.message || "";
  const errorType = errorDetails?.type || (errorDetails?.error as { type?: string })?.type || "";

  // Check for common error patterns
  const lowerMessage = errorMessage.toLowerCase();
  const lowerType = errorType.toLowerCase();

  // Insufficient credits/balance
  if (
    lowerMessage.includes("credit balance is too low") ||
    lowerMessage.includes("insufficient credits") ||
    lowerMessage.includes("insufficient quota") ||
    lowerMessage.includes("quota exceeded") ||
    (lowerMessage.includes("billing") && lowerMessage.includes("inactive"))
  ) {
    return {
      message: `${provider} API error: Insufficient credits. Your account balance is too low.`,
      actionable: `Add credits to your ${provider} account or check your billing settings.`,
    };
  }

  // Invalid API key
  if (
    status === 401 ||
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("invalid api_key") ||
    lowerMessage.includes("authentication") ||
    lowerType.includes("invalid_api_key")
  ) {
    return {
      message: `${provider} API error: Invalid API key.`,
      actionable: `Set the ${envVar} environment variable or use --api-key option.`,
    };
  }

  // Rate limiting
  if (status === 429 || lowerMessage.includes("rate limit") || lowerType.includes("rate_limit")) {
    return {
      message: `${provider} API error: Rate limit exceeded.`,
      actionable: "Wait a moment and try again. If this persists, check your usage limits.",
    };
  }

  // Model not found
  if (
    status === 404 ||
    lowerMessage.includes("model not found") ||
    lowerMessage.includes("does not exist") ||
    lowerType.includes("model_not_found")
  ) {
    return {
      message: `${provider} API error: Model not found.`,
      actionable: "Check that the model name is correct. Use -m to specify a different model.",
    };
  }

  // Permission denied
  if (status === 403 || lowerMessage.includes("permission") || lowerMessage.includes("access denied")) {
    return {
      message: `${provider} API error: Permission denied.`,
      actionable: "Check that your API key has access to this model/feature.",
    };
  }

  // Context length exceeded
  if (
    lowerMessage.includes("context length") ||
    lowerMessage.includes("token limit") ||
    lowerMessage.includes("max_tokens") ||
    lowerType.includes("context_length_exceeded")
  ) {
    return {
      message: `${provider} API error: Context length exceeded.`,
      actionable: "Your prompt is too long. Try with a shorter prompt or clear the conversation.",
    };
  }

  // Content filtering/blocked
  if (
    status === 400 && (lowerMessage.includes("content blocked") || lowerMessage.includes("safety policy"))
  ) {
    return {
      message: `${provider} API error: Content blocked due to safety policy.`,
      actionable: "Adjust your prompt to comply with the model's safety guidelines.",
    };
  }

  // Generic errors with details
  const detailStr = errorMessage ? `: ${errorMessage}` : "";

  switch (status) {
    case 400:
      return {
        message: `${provider} API error: 400 (Bad Request)${detailStr}`,
        actionable: "Check the request format and model name.",
      };
    case 500:
    case 502:
    case 503:
      return {
        message: `${provider} API error: ${status} (Server Error)${detailStr}`,
        actionable: "The API is experiencing issues. Try again later.",
      };
    default:
      return {
        message: `${provider} API error: ${status}${detailStr}`,
        actionable: null,
      };
  }
}

/**
 * Check if an error indicates insufficient credits/balance.
 * @param error - The error object
 * @returns boolean
 */
export function isInsufficientCreditsError(error: Error & { body?: string } | null): boolean {
  if (!error) return false;
  const message = (error.message || "").toLowerCase();
  const body = (error.body || "").toLowerCase();

  return (
    message.includes("credit balance is too low") ||
    message.includes("insufficient credits") ||
    message.includes("insufficient quota") ||
    message.includes("quota exceeded") ||
    body.includes("credit balance is too low") ||
    body.includes("insufficient credits") ||
    body.includes("insufficient quota")
  );
}