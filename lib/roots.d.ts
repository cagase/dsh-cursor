/** `$CURSOR_CONFIG_DIR` wins; otherwise `~/.cursor`. */
export declare function userCursorDir(configured?: string): string;
export declare function projectCursorDir(cwd: string): string;
export declare function findRepoRoot(cwd: string): string;
export declare function projectRulesDir(cwd: string): string;
export declare function relativeLabel(cwd: string, path: string): string;
