import { register } from "./registry.js";
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { validateFilePath } from "./registry.js";

const TOOLS_DIR = ".smol-agent/tools";

/**
 * Helper to ensure tools directory exists
 */
async function ensureToolsDir() {
  try {
    await mkdir(TOOLS_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Helper to list existing custom tools
 */
async function listCustomTools() {
  try {
    await ensureToolsDir();
    const files = await readdir(TOOLS_DIR);
    return files.filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Create a new tool that can be used in subsequent agent runs.
 * The tool is saved to .smol-agent/tools and registered for immediate use.
 */
register("create_tool", {
  description: "Create a new custom tool for the agent to use. The tool is saved to .smol-agent/tools and becomes available for use in subsequent agent runs. Use this to teach the agent new capabilities.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the tool (snake_case, e.g., 'my_custom_tool')"
      },
      description: {
        type: "string",
        description: "What the tool does (used in the system prompt)"
      },
      parameters: {
        type: "object",
        description: "JSON Schema for the tool's parameters"
      },
      code: {
        type: "string",
        description: "The JavaScript code that implements the tool's execute function. This code will be run with the tool's arguments as a parameter."
      }
    },
    required: ["name", "description", "code"]
  },
  async execute(args, context = {}) {
    const { name, description, parameters, code } = args;
    
    // Validate tool name
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return { error: "Tool name must be lowercase snake_case, starting with a letter (e.g., my_tool, calculate_hash)" };
    }
    
    // Check for reserved names
    const reservedNames = ['reflect', 'create_tool', 'list_custom_tools', 'delete_tool'];
    if (reservedNames.includes(name)) {
      return { error: `Cannot use reserved tool name: ${name}` };
    }
    
    // Build the tool definition
    const toolDef = {
      name,
      description,
      parameters: parameters || { type: "object", properties: {} },
      code,
      createdAt: new Date().toISOString()
    };
    
    // Save to tools directory
    await ensureToolsDir();
    const toolPath = join(TOOLS_DIR, `${name}.json`);
    await writeFile(toolPath, JSON.stringify(toolDef, null, 2), "utf-8");
    
    return { 
      success: true,
      message: `Tool '${name}' created and saved to ${toolPath}`,
      tool: toolDef
    };
  }
});

/**
 * List all custom tools available in .smol-agent/tools
 */
register("list_custom_tools", {
  description: "List all custom tools that have been created and are available for use.",
  parameters: {
    type: "object",
    properties: {}
  },
  async execute() {
    const toolFiles = await listCustomTools();
    const tools = [];
    
    for (const file of toolFiles) {
      try {
        const content = await readFile(join(TOOLS_DIR, file), "utf-8");
        const tool = JSON.parse(content);
        tools.push({
          name: tool.name,
          description: tool.description,
          createdAt: tool.createdAt
        });
      } catch {
        // Skip invalid files
      }
    }
    
    return { tools };
  }
});

/**
 * Delete a custom tool from .smol-agent/tools
 */
register("delete_tool", {
  description: "Delete a custom tool from .smol-agent/tools. The tool will no longer be available.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the tool to delete"
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const { name } = args;
    
    // Validate name to prevent path traversal
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return { error: "Invalid tool name" };
    }
    
    const toolPath = join(TOOLS_DIR, `${name}.json`);
    
    try {
      await unlink(toolPath);
      return { success: true, message: `Tool '${name}' deleted` };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { error: `Tool '${name}' not found` };
      }
      throw err;
    }
  }
});

/**
 * Get the source code of a custom tool
 */
register("get_tool_code", {
  description: "Get the source code of a custom tool for review or modification.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the tool"
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const { name } = args;
    
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return { error: "Invalid tool name" };
    }
    
    const toolPath = join(TOOLS_DIR, `${name}.json`);
    
    try {
      const content = await readFile(toolPath, "utf-8");
      const tool = JSON.parse(content);
      return { 
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        code: tool.code,
        createdAt: tool.createdAt
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { error: `Tool '${name}' not found` };
      }
      throw err;
    }
  }
});

/**
 * Load all custom tools from .smol-agent/tools and register them.
 * This is called during agent initialization.
 */
export async function loadCustomTools(registry) {
  const toolFiles = await listCustomTools();
  
  for (const file of toolFiles) {
    try {
      const content = await readFile(join(TOOLS_DIR, file), "utf-8");
      const tool = JSON.parse(content);
      
      // Register the tool with the registry
      if (tool.name && tool.description && tool.code) {
        // Create a wrapper function that evaluates the custom code
        const executeFn = new Function('args', 'context', `
          const { ${Object.keys(tool.parameters?.properties || {}).join(', ')} } = args;
          ${tool.code}
        `);
        
        // Simpler approach: just eval the code in a function context
        const simpleExecute = new Function('args', `
          // Extract arguments into scope
          ${Object.entries(tool.parameters?.properties || {}).map(
            ([key, val], i) => `let ${key} = args.${key};`
          ).join('\n')}
          
          // The user's code
          ${tool.code}
        `);
        
        // Most flexible: use a function constructor with args object available
        const flexibleExecute = (toolArgs) => {
          try {
            // Create a sandbox-like function
            const fn = new Function('args', 'return (async () => {' + tool.code + '})()');
            return fn(toolArgs);
          } catch (err) {
            // Try synchronous execution
            const fn = new Function('args', tool.code);
            return fn(toolArgs);
          }
        };
        
        // Execute the custom tool code - extract args into function scope
        const safeExecute = async (toolArgs) => {
          try {
            const props = tool.parameters?.properties || {};
            const argNames = Object.keys(props);
            
            // Generate function with args destructured in parameters
            // e.g., function(name, age) { ... }
            // But also provide 'args' for full access
            const fn = new Function(...argNames, 'args', tool.code);
            
            // Get values for each argument
            const argValues = argNames.map(k => toolArgs?.[k]);
            
            // Call with extracted args AND the full args object
            return fn(...argValues, toolArgs);
          } catch (err) {
            return { error: err.message };
          }
        };
        
        // Actually, let's use a simpler approach - the code is expected to 
        // return a result directly
        register(tool.name, {
          description: tool.description,
          parameters: tool.parameters,
          execute: safeExecute
        });
        
        console.log(`[custom-tools] Loaded tool: ${tool.name}`);
      }
    } catch (err) {
      console.error(`[custom-tools] Failed to load ${file}:`, err.message);
    }
  }
}
