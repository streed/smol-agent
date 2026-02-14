import { register } from "./registry.js";

/**
 * Ask clarifying questions to gather requirements before planning.
 * This tool helps the agent understand the full scope of a task before
 * creating a plan.
 */
async function execute({ questions, context }) {
  // questions is an array of strings asking for clarification
  // context provides any existing understanding of the task
  
  return {
    success: true,
    questions,
    context,
    message: "User asked for clarification. Waiting for response.",
  };
}

register("ask_requirements", {
  description: `Ask clarifying questions to gather requirements before planning. Use this tool when the task is ambiguous or when you need more information to create a proper plan.

This tool pauses the agent loop and waits for user input. It's useful for:
- Understanding the full scope of a feature request
- Clarifying requirements before creating a plan
- Getting approval on approach before implementation
- Understanding edge cases or constraints

Arguments:
- questions: An array of specific questions to ask the user
- context: Optional existing context about the task

The agent will wait for the user to answer all questions before proceeding.

Example use case:
Task: "Add authentication to the app"
Questions: [
  "What authentication method should we use? (JWT, sessions, OAuth)",
  "Do we need to support multiple providers (Google, GitHub, etc.)?",
  "Should authentication be required for all pages or just some?"
]`,
  parameters: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Array of clarifying questions to ask the user",
      },
      context: {
        type: "string",
        description: "Optional existing context about the task",
      },
    },
  },
  execute,
});

/**
 * Analyze a task and break it into smaller sub-tasks.
 * This helps with multi-step planning by identifying the individual
 * steps needed to complete a larger task.
 */
async function executeAnalyzeTask({ task, constraints }) {
  // Parse the task and break it into logical sub-tasks
  // Consider constraints like time, resources, or dependencies
  
  return {
    success: true,
    task,
    constraints,
    subTasks: [],
    dependencies: [],
    estimatedComplexity: "unknown",
  };
}

register("analyze_task", {
  description: `Analyze a task and break it into smaller, manageable sub-tasks. Use this tool at the beginning of the planning phase to identify all the steps needed to complete a task.

This helps with:
- Breaking complex tasks into smaller pieces
- Identifying dependencies between steps
- Estimating the scope of work
- Creating a structured plan

Arguments:
- task: The main task to analyze
- constraints: Any constraints or limitations to consider (time, resources, etc.)

Returns:
- task: The original task
- constraints: The provided constraints
- subTasks: Array of identified sub-tasks
- dependencies: Array of dependency relationships
- estimatedComplexity: Low/medium/high estimate

Example:
Task: "Add user authentication"
Sub-tasks: [
  "Research authentication options",
  "Set up database schema",
  "Create auth endpoints",
  "Add authentication middleware",
  "Write tests"
]`,
  parameters: {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description: "The main task to analyze",
      },
      constraints: {
        type: "string",
        description: "Optional constraints to consider",
      },
    },
  },
  execute: executeAnalyzeTask,
});

/**
 * Review and refine a plan before execution.
 * This tool allows the agent to check that the plan is complete
 * and ready for implementation.
 */
async function executeReviewPlan({ plan, checklist }) {
  // Review the plan against a checklist of quality criteria
  // Identify any gaps or issues before execution
  
  return {
    success: true,
    plan,
    checklist,
    reviewResult: "ready",
    issues: [],
    recommendations: [],
  };
}

register("review_plan", {
  description: `Review and refine a plan before execution. Use this tool to ensure the plan is complete and ready for implementation by checking it against a quality checklist.

Checklist items typically include:
- [ ] All files to modify are identified
- [ ] Implementation steps are clear and in order
- [ ] Edge cases are considered
- [ ] Tests are planned
- [ ] Potential risks are documented
- [ ] Dependencies are identified

Arguments:
- plan: The plan content to review (markdown string)
- checklist: Optional array of checklist items to verify

Returns:
- plan: The original plan
- checklist: The checklist used
- reviewResult: "ready", "needs_revision", or "caution"
- issues: Array of identified issues
- recommendations: Array of improvement suggestions

Use this before switching from planning to coding mode to ensure nothing was missed.`,
  parameters: {
    type: "object",
    required: ["plan"],
    properties: {
      plan: {
        type: "string",
        description: "The plan content to review (markdown string)",
      },
      checklist: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Optional checklist items to verify",
      },
    },
  },
  execute: executeReviewPlan,
});
