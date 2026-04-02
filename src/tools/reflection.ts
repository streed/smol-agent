/**
 * Reflection tool — allows the agent to reflect on its work after completing
 * a task. Summarizes what was done, what went well, identifies improvements,
 * and analyzes edited files for documentation needs.
 *
 * When the agent reflects, it also examines any code files >100 lines that
 * were modified during the session. For each, it reports dependencies,
 * dependents, and whether a documentation header needs to be added/updated.
 * The agent is expected to act on this report by writing or updating the
 * file-level documentation block at the top of each qualifying file.
 *
 * Key exports:
 *   - Tool registration: reflect
 *
 * Dependencies: ./registry.js, ./file_documentation.js
 * Depended on by: src/agent.js, src/tools/file_documentation.js, src/ui/App.js
 */
import { register } from "./registry.js";
import { analyzeFilesForDocumentation, getEditedFiles, clearEditedFiles } from "./file_documentation.js";

interface ReflectArgs {
  summary: string;
  whatWorkedWell?: string;
  improvements?: string;
  codebaseInsights?: string;
  askUserFeedback?: boolean;
  userQuestion?: string;
}

interface FileDocInfo {
  filePath: string;
  lineCount: number;
  hasExistingDoc: boolean;
  dependencies: string[];
  dependents: string[];
}

interface ReflectResult {
  reflection: string;
  fileDocReport?: FileDocInfo[];
  needsUserFeedback?: boolean;
  userQuestion?: string;
}

register("reflect", {
  description: "Reflect on the work just completed. Summarizes what was done, analyzes the codebase for understanding, and identifies code files (>100 lines) that need documentation headers added or updated. The documentation header should summarize the file, its dependencies, and what depends on it. If askUserFeedback is true, the UI will prompt for user input.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of what was accomplished"
      },
      whatWorkedWell: {
        type: "string",
        description: "Description of what went smoothly or exceeded expectations"
      },
      improvements: {
        type: "string",
        description: "Areas that could be improved for future similar tasks"
      },
      codebaseInsights: {
        type: "string",
        description: "Observations about how the codebase works — architecture patterns, data flow, key abstractions discovered during this work"
      },
      askUserFeedback: {
        type: "boolean",
        description: "Whether to ask the user for feedback on the work"
      },
      userQuestion: {
        type: "string",
        description: "Question to ask the user if askUserFeedback is true"
      }
    },
    required: ["summary"]
  },
  async execute(args: ReflectArgs, { cwd = process.cwd() } = {}): Promise<ReflectResult> {
    const { summary, whatWorkedWell, improvements, codebaseInsights, askUserFeedback, userQuestion } = args;

    let reflection = `## Reflection\n\n**What was accomplished:**\n${summary}\n`;

    if (whatWorkedWell) {
      reflection += `\n**What went well:**\n${whatWorkedWell}\n`;
    }

    if (improvements) {
      reflection += `\n**Areas for improvement:**\n${improvements}\n`;
    }

    if (codebaseInsights) {
      reflection += `\n**Codebase insights:**\n${codebaseInsights}\n`;
    }

    // ── File documentation analysis ───────────────────────────────
    const editedFiles = getEditedFiles();
    let fileDocReport: FileDocInfo[] | undefined;

    if (editedFiles.length > 0) {
      const analysis = analyzeFilesForDocumentation(cwd);

      if (analysis.filesToDocument.length > 0) {
        reflection += `\n**Files needing documentation (>100 lines, edited this session):**\n`;

        for (const file of analysis.filesToDocument) {
          const status = file.hasExistingDoc ? "UPDATE" : "ADD";
          reflection += `\n- \`${file.filePath}\` (${file.lineCount} lines) — [${status}]\n`;

          if (file.dependencies.length > 0) {
            reflection += `  - Dependencies: ${file.dependencies.join(", ")}\n`;
          }
          if (file.dependents.length > 0) {
            reflection += `  - Depended on by: ${file.dependents.join(", ")}\n`;
          }
        }

        reflection += `\n**Action required:** For each file listed above, add or update the documentation block at the top of the file. The documentation should include:\n`;
        reflection += `1. A summary of what the file does\n`;
        reflection += `2. Its dependencies (what it imports/uses)\n`;
        reflection += `3. What depends on it (other files that import it)\n`;
        reflection += `4. Include the @file-doc marker so it can be detected and updated later\n`;

        fileDocReport = analysis.filesToDocument;
      }

      // Clear tracker after reflection
      clearEditedFiles();
    }

    // If user feedback is requested, include that in the response
    if (askUserFeedback && userQuestion) {
      reflection += `\n**Feedback requested:** ${userQuestion}\n`;
      return {
        reflection,
        needsUserFeedback: true,
        userQuestion,
        fileDocReport
      };
    }

    return { reflection, fileDocReport };
  }
});