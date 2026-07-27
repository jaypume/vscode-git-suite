import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';
import { CommitFileTreeProvider } from './CommitFileTreeProvider';
import { logUiState, type FileViewMode } from './LogUiState';
import { openSmartDiff } from './openSmartDiff';

/**
 * Register the native Git Log tree views and their commands.
 */
export function registerLogTreeViews(manager: WorkspaceGitManager): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const fileTreeProvider = new CommitFileTreeProvider(manager);
  disposables.push(vscode.window.registerTreeDataProvider('gitsuite.commitFileTree', fileTreeProvider));

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

  // Color commit-file labels by git status (M/A/D/R) via a custom scheme.
  const statusColor: Record<string, vscode.ThemeColor> = {
    M: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    A: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    D: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
    R: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
    C: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    U: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
  };
  disposables.push(vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
      if (uri.scheme !== 'gitsuite-log-file') return undefined;
      const status = uri.query.match(/status=([A-Z])/)?.[1];
      if (!status) return undefined;
      const color = statusColor[status];
      return color ? new vscode.FileDecoration(undefined, undefined, color) : undefined;
    },
  }));

  return disposables;
}
