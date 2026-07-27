import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { generateWithAI } from './aiGenerate';

/**
 * Build a commit message from staged changes via the configured AI provider.
 * Optionally scoped to a single repo (used by the native SCM commit command).
 */
export async function generateCommitMessage(manager: WorkspaceGitManager, repoId?: string): Promise<string> {
  const ws = await manager.getAllStatuses();
  const cfg = vscode.workspace.getConfiguration('gitsuite');
  const maxDiffChars: number = cfg.get('ai.maxDiffChars', 8000);
  const multiRepo = ws.repos.length > 1;

  const repos = repoId ? ws.repos.filter(r => r.repoId === repoId) : ws.repos;
  const sections: string[] = [];
  for (const repo of repos) {
    const repoName = path.basename(repo.repoId);
    const files = [...repo.stagedFiles, ...repo.unstagedFiles];
    if (files.length === 0) continue;
    const fileLines = files.slice(0, 50).map(f => `${f.status[0].toUpperCase()} ${f.path}`);
    const svc = manager.getRepo(repo.repoId);
    const diff = svc ? await svc.getFullStagedDiff(maxDiffChars) : '';
    const block = [
      multiRepo ? `### Repository: ${repoName}` : '',
      '## Changed files',
      fileLines.join('\n'),
      diff ? `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
    sections.push(block);
  }

  const configuredLang: string = cfg.get('ai.language', '');
  const language = configuredLang.trim() || vscode.env.language || 'en';
  const prompt = [
    'You are a git commit message writer. Analyze the following changes and write a commit message.',
    '',
    'Rules:',
    `- Write the commit message in this language: ${language}`,
    '- First line: imperative mood, max 72 characters (e.g. "Add user authentication")',
    '- Leave a blank line after the first line',
    '- Body: 2-4 bullet points explaining WHAT changed and WHY, each starting with "- "',
    '- Be specific and technical, reference file names or module names when relevant',
    '- Output ONLY the commit message, no explanations, no markdown fences',
    '',
    sections.join('\n\n'),
  ].join('\n');

  const provider: string = cfg.get('ai.provider', 'vscode-lm');
  return generateWithAI(provider, prompt, cfg);
}
