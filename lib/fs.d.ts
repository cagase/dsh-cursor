export interface DirEntry {
    name: string;
    isDir: boolean;
    isFile: boolean;
}
export interface TextRead {
    text: string;
    truncated: boolean;
}
export declare function readText(path: string, signal?: AbortSignal, maxChars?: number): Promise<TextRead>;
/** Cheap identity for a directory tree: names, sizes, and mtimes, not file bodies. */
export declare function treeStamp(path: string, signal?: AbortSignal): Promise<string>;
export declare function fileExists(path: string, signal?: AbortSignal): Promise<boolean>;
export declare function dirExists(path: string, signal?: AbortSignal): Promise<boolean>;
export declare function listDir(path: string, signal?: AbortSignal): Promise<DirEntry[]>;
export declare function stamp(path: string): Promise<string | undefined>;
