import type { AgentLike, PluginLogger, SkillCandidate } from '../types.js';
export declare function skillMatchesPath(candidate: SkillCandidate, filePath: string, root?: string): boolean;
export declare function attachMatchingSkills(agent: AgentLike, filePath: string, candidates: readonly SkillCandidate[], logger: PluginLogger): Promise<void>;
export declare function resourceDir(file: string): string;
