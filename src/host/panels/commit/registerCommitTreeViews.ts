import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';
import type { CommitPanelProvider } from '../CommitPanelProvider';
import { StashTreeProvider } from './StashTreeProvider';
import { WorktreeTreeProvider } from './WorktreeTreeProvider';

/**
 * Register native TreeViews for the Commit area (Stash now, Worktree next).
 */
export function registerCommitTreeViews(
  manager: WorkspaceGitManager,
  commitPanel: CommitPanelProvider,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const stashProvider = new StashTreeProvider(manager);
  disposables.push(vscode.window.registerTreeDataProvider('gitsuite.stash', stashProvider));

  const worktreeProvider = new WorktreeTreeProvider(manager);
  disposables.push(vscode.window.registerTreeDataProvider('gitsuite.worktrees', worktreeProvider));

  const refreshAfter = async (): Promise<void> => {
    await manager.getAllStatusesFresh();
    stashProvider.refresh();
    worktreeProvider.refresh();
  };

  disposables.push(vscode.commands.registerCommand('gitsuite.stash.pop', async (node: { repoId: string; stash?: { ref: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.stash) return;
    try {
      await repo.stashPop(node.stash.ref);
      await refreshAfter();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: stash pop failed: ${String(e)}`);
    }
  }));

  disposables.push(vscode.commands.registerCommand('gitsuite.stash.apply', async (node: { repoId: string; stash?: { ref: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.stash) return;
    try {
      await repo.stashApply(node.stash.ref);
      await refreshAfter();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: stash apply failed: ${String(e)}`);
    }
  }));

  disposables.push(vscode.commands.registerCommand('gitsuite.stash.drop', async (node: { repoId: string; stash?: { ref: string; message: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.stash) return;
    const confirm = await vscode.window.showWarningMessage(
      `Drop "${node.stash.message || node.stash.ref}"? This cannot be undone.`,
      { modal: true }, 'Drop',
    );
    if (confirm !== 'Drop') return;
    try {
      await repo.stashDrop(node.stash.ref);
      await refreshAfter();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: stash drop failed: ${String(e)}`);
    }
  }));

  disposables.push(vscode.commands.registerCommand('gitsuite.stash.rename', async (node: { repoId: string; stash?: { ref: string; message: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.stash) return;
    const newMessage = await vscode.window.showInputBox({
      title: 'Rename Stash', prompt: 'Enter a new description for the stash', value: node.stash.message,
    });
    if (!newMessage || newMessage === node.stash.message) return;
    try {
      await repo.stashRename(node.stash.ref, newMessage);
      await refreshAfter();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: stash rename failed: ${String(e)}`);
    }
  }));

  disposables.push(vscode.commands.registerCommand('gitsuite.stash.openFileDiff', async (
    repoRoot: string, stashRef: string, filePath: string, status: string,
  ) => {
    const fileName = path.basename(filePath);
    const fileUri = vscode.Uri.file(path.join(repoRoot, filePath));
    const stashUri = (ref: string): vscode.Uri => vscode.Uri.from({
      scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }),
    });
    const left = stashUri(`${stashRef}^`);
    const right = stashUri(stashRef);
    const title = `${fileName} (${stashRef})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    void status;
  }));

  // ── Worktree commands ──
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.openInExplorer', (p: string) =>
    vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p))));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.openInNewWindow', (p: string) =>
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true })));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.openInOS', (p: string) =>
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p))));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.addToWorkspace', (p: string) => {
    const uri = vscode.Uri.file(p);
    const folders = vscode.workspace.workspaceFolders ?? [];
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
  }));

  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.lock', async (node: { repoId: string; wt?: { path: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.wt) return;
    const reason = await vscode.window.showInputBox({ prompt: 'Lock reason (optional)' });
    try { await repo.lockWorktree(node.wt.path, reason); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: lock failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.unlock', async (node: { repoId: string; wt?: { path: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.wt) return;
    try { await repo.unlockWorktree(node.wt.path); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: unlock failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.remove', async (node: { repoId: string; wt?: { path: string; branchShort?: string } }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo || !node.wt) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove worktree "${node.wt.branchShort || node.wt.path}"?`, { modal: true }, 'Remove',
    );
    if (confirm !== 'Remove') return;
    try { await repo.deleteWorktree(node.wt.path, false).catch(() => repo.deleteWorktree(node.wt!.path, true)); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: remove failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.worktree.prune', async (node: { repoId: string }) => {
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.pruneWorktrees(); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: prune failed: ${String(e)}`); }
  }));

  void commitPanel; // reserved for future status-sync with the commit webview
  return disposables;
}
