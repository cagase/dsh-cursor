import type { PluginLogger, SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../types.js';
export declare const PROVIDER_NAME = "cursor";
type RootKind = 'user-skills' | 'user-skills-cursor' | 'user-agents' | 'project-skills' | 'project-agents';
export interface CandidateLocator {
    root: string;
    rootKind: RootKind;
    entry: string;
    kind: 'bundle' | 'agent' | 'rule';
    file: string;
}
export interface SkillProviderOptions {
    userCursorDir: string;
    skillsCursor: boolean;
    agents: boolean;
}
export declare class CursorSkillProvider implements SkillProvider {
    private readonly logger;
    private readonly options;
    private readonly extra?;
    readonly name = "cursor";
    constructor(logger: PluginLogger, options: SkillProviderOptions, extra?: ((cwd: string | undefined, signal?: AbortSignal) => Promise<SkillCandidate[]>) | undefined);
    private resolveRoots;
    list(options: SkillLookupOptions): Promise<{
        candidates: SkillCandidate[];
        complete: boolean;
    }>;
    private listRoot;
    private listBundleDirs;
    private skillSummary;
    private agentSummary;
    get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}
export declare function catalogName(name: string, fallback: string): string;
export declare function buildAgentSkillBody(name: string, description: string, body: string, model?: string): string;
export declare function registerCursorSkills(ctx: {
    skills?: {
        registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => unknown;
    };
}, logger: PluginLogger, options: SkillProviderOptions, extra?: SkillProvider['list'] extends never ? never : CursorSkillProvider['list'] extends infer _ ? (cwd: string | undefined, signal?: AbortSignal) => Promise<SkillCandidate[]> : never): CursorSkillProvider | undefined;
export declare function skillWatchRoots(configuredUserDir: string, cwd?: string, skillsCursor?: boolean): Promise<string[]>;
export {};
