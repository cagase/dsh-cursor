export interface DirEntry {
    name: string;
    isDir: boolean;
    isFile: boolean;
}
export declare function readText(path: string, signal?: AbortSignal): Promise<string>;
export declare function fileExists(path: string, signal?: AbortSignal): Promise<boolean>;
export declare function dirExists(path: string, signal?: AbortSignal): Promise<boolean>;
export declare function listDir(path: string, signal?: AbortSignal): Promise<DirEntry[]>;
export declare function stamp(path: string): Promise<string | undefined>;
