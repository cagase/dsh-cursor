export declare function noteLiveSession(id: unknown, cwd: string | undefined): void;
export declare function forgetLiveSession(id: unknown, _cwd?: string): void;
/** Directories of sessions that are still running. */
export declare function liveCwds(): string[];
