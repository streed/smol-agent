/**
 * Type declarations for graphology
 * 
 * Minimal types for the graph library used in repo-map.ts for PageRank.
 */
declare module 'graphology' {
  export default class Graph<NodeAttributes = any, EdgeAttributes = any> {
    constructor(options?: GraphOptions);
    
    // Node operations
    addNode(node: string, attributes?: NodeAttributes): string;
    addNodeAttribute(node: string, name: string, value: any): void;
    addNodeAttributes(node: string, attributes: NodeAttributes): void;
    hasNode(node: string): boolean;
    getNodeAttributes(node: string): NodeAttributes;
    updateNodeAttribute(node: string, name: string, updater: (value: any) => any): void;
    forEachNode(callback: (node: string, attributes: NodeAttributes) => void): void;
    
    // Edge operations
    addEdge(source: string, target: string, attributes?: EdgeAttributes): string;
    addDirectedEdge(source: string, target: string, attributes?: EdgeAttributes): string;
    addUndirectedEdge(source: string, target: string, attributes?: EdgeAttributes): string;
    hasEdge(source: string, target: string): boolean;
    forEachEdge(callback: (edge: string, attributes: EdgeAttributes, source: string, target: string) => void): void;
    
    // Graph properties
    order: number;  // Number of nodes
    size: number;   // Number of edges
    directed: boolean;
    
    // Utility
    clear(): void;
    destroy(): void;
  }
  
  export interface GraphOptions {
    directed?: boolean;
    multi?: boolean;
    allowSelfLoops?: boolean;
  }
}

declare module 'graphology-metrics/centrality/pagerank' {
  import Graph from 'graphology';
  
  export interface PageRankOptions {
    alpha?: number;        // Damping factor (default: 0.85)
    tolerance?: number;     // Convergence threshold (default: 1e-8)
    maxIterations?: number; // Max iterations (default: 100)
    weights?: string;      // Weight attribute name
  }
  
  export function pagerank(
    graph: Graph,
    options?: PageRankOptions
  ): Record<string, number>;
  
  export function pagerankAssignment(
    graph: Graph,
    options?: PageRankOptions & { attributeName?: string }
  ): void;
}