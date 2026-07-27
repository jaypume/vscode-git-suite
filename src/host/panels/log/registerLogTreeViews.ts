import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';
import { CommitFileTreeProvider } from './CommitFileTreeProvider';
import { BranchTreeProvider } from './BranchTreeProvider';
import { logUiState, type FileViewMode } from './LogUiState';
import { openSmartDiff } from './openSmartDiff';

/**
 * Register the native Git Log tree views and their commands.
 */
export function registerLogTreeViews(manager: WorkspaceGitManager): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const fileTreeProvider = new CommitFileTreeProvider(manager);
  disposables.push(vscode.window.registerTreeDataProvider('gitsuite.commitFileTree', fileTreeProvider));

  const branchTreeProvider = new BranchTreeProvider(manager);
  disposables.push(vscode.window.registerTreeDataProvider('gitsuite.branches', branchTreeProvider));

  // Open diff for a file in the selected commit (reuses webview's openSmartDiff).
  disposables.push(vscode.commands.registerCommand('gitsuite.log.openFileDiff', async (
    repoId: string, hash: string, filePath: string, fileStatus?: string, oldPath?: string, parents?: string[],
  ) => {
    const repo = manager.getRepo(repoId);
    if (!repo) return;
    try {
      await openSmartDiff(repo, { hash, filePath, fileStatus, oldPath, parents });
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: Cannot open diff: ${String(e)}`);
    }
  }));

  // Toggle tree / flat view mode for the commit-file tree.
  disposables.push(vscode.commands.registerCommand('gitsuite.log.toggleFileViewMode', () => {
    const next: FileViewMode = logUiState.fileViewMode === 'tree' ? 'flat' : 'tree';
    logUiState.setFileViewMode(next);
  }));

  return disposables;
}
