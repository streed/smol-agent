/**
 * Type declarations for @mariozechner/pi-tui
 * 
 * Minimal types for the terminal UI library used by smol-agent.
 */
declare module '@mariozechner/pi-tui' {
  import { Readable, Writable } from 'stream';
  
  // Core TUI class
  export class TUI {
    constructor(options?: { input?: Readable; output?: Writable });
    render(component: any): void;
    destroy(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  
  // Text component
  export class Text {
    constructor(options?: { content?: string; style?: any });
    setContent(content: string): void;
    getContent(): string;
  }
  
  // Container component
  export class Container {
    constructor(options?: { children?: any[] });
    add(child: any): void;
    remove(child: any): void;
  }
  
  // Editor component for input
  export class Editor {
    constructor(options?: {
      placeholder?: string;
      multiline?: boolean;
      autocomplete?: AutocompleteProvider | AutocompleteProvider[];
      onSubmit?: (value: string) => void;
      onKeyPress?: (key: string, modifiers?: KeyModifiers) => void;
    });
    getValue(): string;
    setValue(value: string): void;
    setPlaceholder(text: string): void;
    focus(): void;
    blur(): void;
    clear(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  
  // Markdown rendering
  export class Markdown {
    constructor(options?: { content?: string; maxWidth?: number });
    setContent(content: string): void;
    setMaxWidth(width: number): void;
  }
  
  // Spacer component
  export class Spacer {}
  
  // Process terminal for subprocesses
  export class ProcessTerminal {
    constructor(options?: { command?: string; args?: string[] });
    start(): void;
    write(data: string): void;
    resize(width: number, height: number): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  
  // Autocomplete interface
  export interface AutocompleteProvider {
    complete(input: string, position: number): Promise<Completion[]>;
  }
  
  export class CombinedAutocompleteProvider implements AutocompleteProvider {
    constructor(providers: AutocompleteProvider[]);
    complete(input: string, position: number): Promise<Completion[]>;
  }
  
  // Completion result
  export interface Completion {
    text: string;
    display?: string;
    description?: string;
    start: number;
    end: number;
  }
  
  // Key event modifiers
  export interface KeyModifiers {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  }
  
  // Key matching utility
  export function matchesKey(key: string, event: KeyEvent): boolean;
  
  export interface KeyEvent {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
    sequence?: string;
  }
  
  // Truncation utility
  export function truncate(text: string, maxLength: number, suffix?: string): string;
}