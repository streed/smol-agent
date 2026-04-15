/**
 * Type declarations for tree-sitter
 * 
 * Minimal types for the tree-sitter parsing library.
 * Note: tree-sitter is a CommonJS module loaded via createRequire.
 */
declare module 'tree-sitter' {
  // Parser class
  export default class Parser {
    constructor();
    setLanguage(language: any): void;
    parse(input: string | Parser.Input): Tree;
    setTimeoutMicros(timeout: number): void;
  }
  
  export namespace Parser {
    export interface Input {
      (startIndex: number, startPoint?: Point, endIndex?: number): string;
      length?: number;
    }
  }
  
  // Syntax tree
  export class Tree {
    rootNode: SyntaxNode;
    edit(delta: Edit): void;
    walk(): TreeCursor;
  }
  
  // Syntax node
  export class SyntaxNode {
    type: string;
    text: string;
    startPosition: Point;
    endPosition: Point;
    startIndex: number;
    endIndex: number;
    childCount: number;
    namedChildCount: number;
    children: SyntaxNode[];
    namedChildren: SyntaxNode[];
    parent: SyntaxNode | null;
    firstChild: SyntaxNode | null;
    lastChild: SyntaxNode | null;
    nextSibling: SyntaxNode | null;
    previousSibling: SyntaxNode | null;
    
    childForFieldName(fieldName: string): SyntaxNode | null;
    child(childIndex: number): SyntaxNode | null;
    namedChild(childIndex: number): SyntaxNode | null;
    descendantForPosition(position: Point): SyntaxNode;
    descendantsOfType(type: string | string[]): SyntaxNode[];
    hasError(): boolean;
    isError(): boolean;
    isMissing(): boolean;
    isNamed(): boolean;
  }
  
  // Tree cursor for efficient traversal
  export class TreeCursor {
    nodeType: string;
    nodeText: string;
    startPosition: Point;
    endPosition: Point;
    
    gotoFirstChild(): boolean;
    gotoNextSibling(): boolean;
    gotoParent(): boolean;
    currentNode: SyntaxNode;
    reset(node: SyntaxNode): void;
  }
  
  // Position in source
  export interface Point {
    row: number;
    column: number;
  }
  
  // Edit delta
  export interface Edit {
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
    startPosition: Point;
    oldEndPosition: Point;
    newEndPosition: Point;
  }
}

// Language grammars are loaded separately
declare module 'tree-sitter-javascript' {
  const language: any;
  export default language;
}

declare module 'tree-sitter-typescript' {
  const language: { typescript: any; tsx: any };
  export default language;
}

declare module 'tree-sitter-python' {
  const language: any;
  export default language;
}

declare module 'tree-sitter-go' {
  const language: any;
  export default language;
}

declare module 'tree-sitter-rust' {
  const language: any;
  export default language;
}

declare module 'tree-sitter-java' {
  const language: any;
  export default language;
}

declare module 'tree-sitter-ruby' {
  const language: any;
  export default language;
}