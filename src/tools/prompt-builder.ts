/**
 * Dynamic prompt builder for tool descriptions.
 *
 * Provides composable prompt sections with:
 * - Conditional rendering
 * - Priority ordering
 * - Dynamic content generation
 * - Schema formatting
 *
 * Key exports:
 *   - PromptSection: Single section with conditional rendering
 *   - PromptBuilder: Combines sections with priority ordering
 *   - formatSchema(schema): Format JSON schema for display
 *   - formatExamples(examples): Format example inputs/outputs
 *
 * @file-doc
 * @module tools/prompt-builder
 * @dependents src/agent.js (system prompt construction)
 */

// ============ Types ============

interface PromptSectionConfig {
  name: string;
  content: string | (() => string | null);
  condition?: () => boolean;
  priority?: number;
}

interface Example {
  description?: string;
  input: Record<string, unknown>;
  output: unknown;
}

interface PropertySchema {
  type?: string;
  description?: string;
  items?: PropertySchema;
  enum?: string[];
  anyOf?: PropertySchema[];
  oneOf?: PropertySchema[];
}

interface ParameterSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
}

interface ToolDescriptionConfig {
  name: string;
}

// ============ Prompt Section ============

/**
 * Single prompt section with conditional rendering.
 */
export class PromptSection {
  name: string;
  content: string | (() => string | null);
  condition: () => boolean;
  priority: number;

  /**
   * Create a prompt section.
   */
  constructor(config: PromptSectionConfig) {
    this.name = config.name;
    this.content = config.content;
    this.condition = config.condition ?? (() => true);
    this.priority = config.priority ?? 100;
  }

  /**
   * Check if this section should be included.
   */
  shouldInclude(): boolean {
    try {
      return this.condition();
    } catch {
      return true;
    }
  }

  /**
   * Get content for this section.
   */
  getContent(): string | null {
    if (typeof this.content === 'function') {
      try {
        return this.content();
      } catch {
        return null;
      }
    }
    return this.content;
  }

  /**
   * Render this section.
   */
  render(): string | null {
    if (!this.shouldInclude()) return null;
    const content = this.getContent();
    if (!content) return null;
    return content;
  }
}

// ============ Prompt Builder ============

/**
 * Build prompts from composable sections.
 */
export class PromptBuilder {
  private sections: PromptSection[];

  constructor() {
    this.sections = [];
  }

  /**
   * Add a section.
   */
  addSection(config: PromptSectionConfig): this {
    this.sections.push(new PromptSection(config));
    return this;
  }

  /**
   * Add multiple sections.
   */
  addSections(sections: PromptSectionConfig[]): this {
    for (const section of sections) {
      this.addSection(section);
    }
    return this;
  }

  /**
   * Remove a section by name.
   */
  removeSection(name: string): this {
    this.sections = this.sections.filter(s => s.name !== name);
    return this;
  }

  /**
   * Clear all sections.
   */
  clearSections(): this {
    this.sections = [];
    return this;
  }

  /**
   * Build the final prompt.
   */
  build(): string {
    return this.sections
      .map(section => ({ section, priority: section.priority }))
      .sort((a, b) => a.priority - b.priority)
      .map(({ section }) => section.render())
      .filter((content): content is string => content !== null)
      .join('\n\n');
  }

  /**
   * Build as JSON schema description.
   */
  buildSchema(): { description: string } {
    return {
      description: this.build()
    };
  }

  /**
   * Get section names for debugging.
   */
  getSectionNames(): string[] {
    return this.sections.map(s => s.name);
  }
}

// ============ Prompt Sections Factory ============

/**
 * Factory for common prompt sections.
 */
export const PromptSections = {
  /**
   * Create description section.
   */
  description: (text: string): PromptSectionConfig => ({
    name: 'description',
    content: text,
    priority: 1
  }),

  /**
   * Create parameters section.
   */
  parameters: (params: ParameterSchema): PromptSectionConfig => ({
    name: 'parameters',
    content: () => formatParameters(params),
    priority: 2
  }),

  /**
   * Create examples section.
   */
  examples: (examples: Example[]): PromptSectionConfig => ({
    name: 'examples',
    content: () => formatExamples(examples),
    priority: 10
  }),

  /**
   * Create warnings section.
   */
  warnings: (warnings: string[]): PromptSectionConfig => ({
    name: 'warnings',
    content: formatWarnings(warnings),
    priority: 5
  }),

  /**
   * Create conditional section.
   */
  conditional: (name: string, content: string | (() => string | null), condition: () => boolean, priority = 100): PromptSectionConfig => ({
    name,
    content,
    condition,
    priority
  }),

  /**
   * Create notes section.
   */
  notes: (notes: string[]): PromptSectionConfig => ({
    name: 'notes',
    content: notes.map(n => `- ${n}`).join('\n'),
    priority: 8
  }),

  /**
   * Create usage section.
   */
  usage: (usage: string): PromptSectionConfig => ({
    name: 'usage',
    content: `Usage:\n${usage}`,
    priority: 3
  })
};

// ============ Formatting Utilities ============

/**
 * Format parameters for prompt.
 */
function formatParameters(params: ParameterSchema | null): string {
  if (!params || !params.properties) return '';

  const lines = ['<parameters>'];
  const required = params.required || [];

  for (const [name, prop] of Object.entries(params.properties)) {
    const req = required.includes(name) ? 'required' : 'optional';
    const type = formatType(prop);
    const desc = prop.description || '';
    lines.push(`  ${name} (${type}, ${req}): ${desc}`);
  }

  lines.push('</parameters>');
  return lines.join('\n');
}

/**
 * Format JSON schema type.
 */
function formatType(prop: PropertySchema): string {
  if (prop.type) {
    if (prop.type === 'array' && prop.items) {
      return `array<${formatType(prop.items)}>`;
    }
    if (prop.enum) {
      return `${prop.type} [${prop.enum.join('|')}]`;
    }
    return prop.type;
  }
  if (prop.anyOf) {
    return prop.anyOf.map(formatType).join('|');
  }
  if (prop.oneOf) {
    return prop.oneOf.map(formatType).join('|');
  }
  return 'any';
}

/**
 * Format examples for prompt.
 */
function formatExamples(examples: Example[] | null): string {
  if (!examples || examples.length === 0) return '';

  const lines = ['<examples>'];
  for (const ex of examples) {
    lines.push('');
    if (ex.description) {
      lines.push(`# ${ex.description}`);
    }
    lines.push(`Input: ${JSON.stringify(ex.input)}`);
    lines.push(`Result: ${typeof ex.output === 'string' ? ex.output : JSON.stringify(ex.output)}`);
  }
  lines.push('</examples>');
  return lines.join('\n');
}

/**
 * Format warnings for prompt.
 */
function formatWarnings(warnings: string[] | null): string {
  if (!warnings || warnings.length === 0) return '';
  const lines = ['<warnings>'];
  for (const warning of warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push('</warnings>');
  return lines.join('\n');
}

// ============ Tool Description Builder ============

/**
 * Build tool descriptions dynamically.
 */
export class ToolDescriptionBuilder {
  private name: string;
  private builder: PromptBuilder;

  constructor(name: string) {
    this.name = name;
    this.builder = new PromptBuilder();
  }

  /**
   * Set description.
   */
  setDescription(text: string): this {
    this.builder.addSection(PromptSections.description(text));
    return this;
  }

  /**
   * Add parameters.
   */
  setParameters(params: ParameterSchema): this {
    this.builder.addSection(PromptSections.parameters(params));
    return this;
  }

  /**
   * Add examples.
   */
  addExamples(examples: Example[]): this {
    this.builder.addSection(PromptSections.examples(examples));
    return this;
  }

  /**
   * Add warnings.
   */
  addWarnings(warnings: string[]): this {
    this.builder.addSection(PromptSections.warnings(warnings));
    return this;
  }

  /**
   * Add notes.
   */
  addNotes(notes: string[]): this {
    this.builder.addSection(PromptSections.notes(notes));
    return this;
  }

  /**
   * Add usage section.
   */
  setUsage(usage: string): this {
    this.builder.addSection(PromptSections.usage(usage));
    return this;
  }

  /**
   * Add conditional section.
   */
  addConditional(name: string, content: string | (() => string | null), condition: () => boolean, priority?: number): this {
    this.builder.addSection(PromptSections.conditional(name, content, condition, priority));
    return this;
  }

  /**
   * Build the description.
   */
  build(): string {
    return this.builder.build();
  }

  /**
   * Build as JSON schema format.
   */
  buildSchema(): { name: string; description: string } {
    return {
      name: this.name,
      description: this.build()
    };
  }
}

// ============ Exports ============

export { formatParameters, formatExamples, formatWarnings };