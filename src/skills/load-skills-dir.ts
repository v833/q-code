/**
 * Skill 目录扫描：加载 `~/.q-code/skills` 与 `<cwd>/.q-code/skills` 下的 SKILL.md。
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractFallbackDescription,
  normalizeFrontmatter,
  splitFrontmatter,
} from './parse-frontmatter';
import type { Skill, SkillSource } from './types';

const SKILL_FILE = 'SKILL.md';

/** 包一层 realpath，便于测试模拟 symlink 行为。 */
export async function resolveRealpath(p: string): Promise<string> {
  return fs.realpath(p).catch(() => p);
}

/** 解析用户主目录；单测可通过 `HOME` 覆盖，否则回退 `os.homedir()`。 */
function getUserHomeDir(): string {
  const home = process.env.HOME?.trim();
  const userProfile = process.env.USERPROFILE?.trim();
  // Windows 下 HOME 可能为空；优先使用 USERPROFILE 以匹配用户预期的 "~"。
  return home ? home : userProfile ? userProfile : os.homedir();
}

/** 解析 q-code 主目录。 */
export function getQCodeHome(): string {
  return process.env.Q_CODE_HOME?.trim() || path.join(getUserHomeDir(), '.q-code');
}

export function getUserAgentsSkillsDir(): string {
  return path.join(getUserHomeDir(), '.agents', 'skills');
}

export function getProjectAgentsSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.agents', 'skills');
}

/** 用户级 Skill 目录。 */
export function getUserSkillsDir(): string {
  return path.join(getQCodeHome(), 'skills');
}

/** 项目级 Skill 目录。 */
export function getProjectSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code', 'skills');
}

interface LoadedFromDir {
  skills: Skill[];
  warnings: string[];
}

/** 扫描 Skill 目录后的汇总结果。 */
export interface LoadAllSkillsResult {
  skills: Skill[];
  warnings: string[];
}

async function loadFromOneDir(
  dir: string,
  source: SkillSource,
): Promise<LoadedFromDir> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    // Windows 下 junction/symlink 目录可能表现为 isSymbolicLink() 而非 isDirectory()。
    // 这里不依赖 dirent 类型过滤，直接尝试读取 `<entry>/SKILL.md`，失败则跳过。
    entries = dirents.map((entry) => entry.name);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { skills: [], warnings: [] };
    return {
      skills: [],
      warnings: [`[skills] Failed to read ${dir}: ${formatError(error)}`],
    };
  }

  const skills: Skill[] = [];
  const warnings: string[] = [];

  for (const dirName of entries) {
    const skillDir = path.join(dir, dirName);
    const filePath = path.join(skillDir, SKILL_FILE);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        warnings.push(`[skills] Skipping ${skillDir}: ${formatError(error)}`);
      }
      continue;
    }

    const split = splitFrontmatter(raw);
    if (split.parseError) {
      warnings.push(
        `[skills] Skipping ${dirName}: invalid frontmatter (${split.parseError})`,
      );
      continue;
    }

    const frontmatter = normalizeFrontmatter(split.raw, split.body);
    const realFile = await resolveRealpath(filePath);
    const realDir = await resolveRealpath(skillDir);
    const name = frontmatter.name ?? dirName;
    const description =
      frontmatter.description ?? extractFallbackDescription(split.body) ?? name;

    skills.push({
      name,
      description,
      whenToUse: frontmatter.whenToUse,
      body: split.body,
      filePath: realFile,
      baseDir: realDir,
      source,
      frontmatter,
    });
  }

  return { skills, warnings };
}

function sourcePriority(source: SkillSource): number {
  switch (source) {
    case 'project-agents':
      return 3;
    case 'project-qcode':
      return 2;
    case 'user-agents':
      return 1;
    case 'user-qcode':
      return 0;
  }
}

/**
 * 加载用户与项目 Skill。
 *
 * - **同名覆盖优先级**：project-agents > project-qcode > user-agents > user-qcode
 * - **同 realpath 去重**：当同一个 SKILL.md 通过软链接/符号链接被多个目录引用时，保留更高优先级的那份
 */
export async function loadAllSkills(cwd: string): Promise<LoadAllSkillsResult> {
  const [
    userQCodeResult,
    userAgentsResult,
    projectQCodeResult,
    projectAgentsResult,
  ] = await Promise.all([
    loadFromOneDir(getUserSkillsDir(), 'user-qcode'),
    loadFromOneDir(getUserAgentsSkillsDir(), 'user-agents'),
    loadFromOneDir(getProjectSkillsDir(cwd), 'project-qcode'),
    loadFromOneDir(getProjectAgentsSkillsDir(cwd), 'project-agents'),
  ]);

  const all = [
    ...userQCodeResult.skills,
    ...userAgentsResult.skills,
    ...projectQCodeResult.skills,
    ...projectAgentsResult.skills,
  ];

  // 先按 realpath 去重，但要按优先级挑胜者（避免软链接导致低优先级先“占坑”）。
  const byRealPath = new Map<string, Skill>();
  for (const skill of all) {
    const existing = byRealPath.get(skill.filePath);
    if (!existing) {
      byRealPath.set(skill.filePath, skill);
      continue;
    }
    if (sourcePriority(skill.source) > sourcePriority(existing.source)) {
      byRealPath.set(skill.filePath, skill);
    }
  }

  // 再按 name 合并覆盖，同样使用优先级规则。
  const byName = new Map<string, Skill>();
  for (const skill of byRealPath.values()) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, skill);
      continue;
    }
    if (sourcePriority(skill.source) > sourcePriority(existing.source)) {
      byName.set(skill.name, skill);
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings: [
      ...userQCodeResult.warnings,
      ...userAgentsResult.warnings,
      ...projectQCodeResult.warnings,
      ...projectAgentsResult.warnings,
    ],
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
