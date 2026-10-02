import type { PluginLogger } from './types.js';
export declare function watchPaths(paths: readonly string[], logger: PluginLogger, onChange: () => void): () => void;
