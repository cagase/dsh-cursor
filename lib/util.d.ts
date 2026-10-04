export declare function expandHome(path: string): string;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function capString(value: string, max: number): string;
export declare function escapeReminderClose(text: string): string;
export declare function isKebabCase(name: string): boolean;
export declare function slugify(name: string): string;
export declare function errorMessage(error: unknown): string;
export declare function isAbort(error: unknown): boolean;
export declare function isMissing(error: unknown): boolean;
/** Convert a glob (`**`, `*`, `?`) to an unanchored-or-full-path matcher. */
export declare function matchGlob(pattern: string, filePath: string, root?: string): boolean;
export declare function toolFilePath(args: unknown): string | undefined;
export declare function toolCommand(args: unknown): string | undefined;
export declare function pluginUserMessage(plugin: string, text: string, form?: 'instructions' | 'notice'): PluginUserMessage;
export interface PluginUserMessage {
    id: never;
    role: 'user';
    content: [{
        type: 'text';
        text: string;
    }];
    source: {
        kind: 'plugin';
        plugin: string;
        form: 'instructions';
    } | {
        kind: 'plugin';
        plugin: string;
        form: 'notice';
        summary: string;
    };
}
export declare function reminder(plugin: string, body: string): PluginUserMessage;
