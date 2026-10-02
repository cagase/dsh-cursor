export declare class FrontmatterError extends Error {
}
export interface ParsedSkillFile {
    frontmatter: {
        name: string;
        description: string;
        disableModelInvocation: boolean;
        userInvocable: boolean;
        paths?: string[];
        globs?: string[];
        metadata?: Readonly<Record<string, string>>;
    };
    body: string;
}
export interface ParsedAgentFile {
    name: string;
    description: string;
    body: string;
    model?: string;
    readonly: boolean;
    background: boolean;
}
export interface ParsedRuleFile {
    name?: string;
    description?: string;
    globs?: string[];
    alwaysApply: boolean;
    body: string;
}
export declare function splitFrontmatter(text: string): {
    raw: string | undefined;
    body: string;
};
export declare function parseSkillFile(text: string, fallbackName: string): ParsedSkillFile;
export declare function parseAgentFile(text: string, fallbackName: string): ParsedAgentFile;
export declare function parseRuleFile(text: string): ParsedRuleFile;
