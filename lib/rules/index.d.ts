import { type ParsedRuleFile } from '../parse.js';
import type { AgentLike, PluginLogger, SkillCandidate } from '../types.js';
export type RuleKind = 'always' | 'glob' | 'description' | 'manual';
export interface LoadedRule {
    kind: RuleKind;
    name: string;
    file: string;
    label: string;
    description?: string;
    globs?: string[];
    body: string;
}
export declare function classifyRule(rule: ParsedRuleFile, file: string): RuleKind;
export declare function collectRules(cwd: string, logger: PluginLogger, signal?: AbortSignal): Promise<LoadedRule[]>;
export declare function loadCursorrules(cwd: string): Promise<string | undefined>;
export declare function collectSubdirAgentsMd(cwd: string, logger: PluginLogger): Promise<{
    label: string;
    content: string;
}[]>;
export declare function renderAlwaysApply(sections: {
    label: string;
    content: string;
}[]): string;
export declare function ruleCatalogCandidates(rules: readonly LoadedRule[]): SkillCandidate[];
export declare function matchingGlobRules(rules: readonly LoadedRule[], filePath: string): LoadedRule[];
export declare function injectSessionRules(agent: AgentLike, logger: PluginLogger): Promise<void>;
export declare function attachGlobRules(agent: AgentLike, filePath: string, logger: PluginLogger): Promise<void>;
export declare function ruleWatchRoots(cwd?: string): Promise<string[]>;
