import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';
import type { GitLogPanelProvider } from '../GitLogPanelProvider';
import { NavigatorTreeProvider, type NavGroupBy, type NavNode } from './NavigatorTreeProvider';

const GROUP_BY_KEY = 'gitsuite.nav.groupBy';
const ACTIVE_REPO_KEY = 'gitsuite.nav.activeRepo';

/**
 * Register the unified Git Navigator view: grouping switch + stash/worktree
 * actions (node-signature) + inline hover buttons + repo activation (sync Git Log).
 */
export function registerNavigatorViews(manager: WorkspaceGitManager, logPanel: GitLogPanelProvider): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const provider = new NavigatorTreeProvider(manager);
  const treeView = vscode.window.createTreeView('gitsuite.navigator', { treeDataProvider: provider, showCollapseAll: true });
  disposables.push(treeView);

  const refreshAfter = async (): Promise<void> => {
    await manager.getAllStatusesFresh();
    provider.refresh();
  };

  const applyGroupBy = (g: NavGroupBy) => {
    provider.setGroupBy(g);
    vscode.commands.executeCommand('setContext', GROUP_BY_KEY, g);
  };
  vscode.commands.executeCommand('setContext', GROUP_BY_KEY, provider.currentGroupBy);

  // Activate a repo: single-select (unblocks others), syncs Git Log to it.
  const activateRepo = (repoId: string | null) => {
    provider.setActiveRepo(repoId);
    vscode.commands.executeCommand('setContext', ACTIVE_REPO_KEY, repoId);
    if (repoId) {
      logPanel.focusRepo(repoId);
      // reveal the activated repo node so its content shows
      const node = provider.repoNode(repoId);
      if (node) treeView.reveal(node, { expand: true, select: false }).then(undefined, () => {});
    }
  };

  disposables.push(vscode.commands.registerCommand('gitsuite.nav.refresh', () => provider.refresh()));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.repo.activate', (node: NavNode) => {
    if (node.kind !== 'repo') return;
    activateRepo(node.meta.id);
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.repo.deactivate', () => {
    activateRepo(null);
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.filterRepos', async () => {
    const metas = provider.allMetas;
    if (metas.length === 0) return;
    const active = provider.activeFilter;
    const items = metas.map(m => ({ label: m.name, id: m.id, picked: active ? active.has(m.id) : true }));
    const picks = await vscode.window.showQuickPick(items, {
      title: 'Filter Repositories',
      placeHolder: 'Select repositories to show',
      canPickMany: true,
    });
    if (picks === undefined) return; // cancelled
    provider.setFilteredRepoIds(picks.map(p => p.id));
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByByRepo', () => applyGroupBy('byRepo')));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByByType', () => applyGroupBy('byType')));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByFlat', () => applyGroupBy('flat')));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByByRepoCurrent', () => applyGroupBy('byRepo')));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByByTypeCurrent', () => applyGroupBy('byType')));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.groupByFlatCurrent', () => applyGroupBy('flat')));

  // ── Stash actions (node-signature) ──
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.stash.pop', async (node: NavNode) => {
    if (node.kind !== 'stash') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.stashPop(node.stash.ref); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: stash pop failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.stash.apply', async (node: NavNode) => {
    if (node.kind !== 'stash') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.stashApply(node.stash.ref); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: stash apply failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.stash.drop', async (node: NavNode) => {
    if (node.kind !== 'stash') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    const confirm = await vscode.window.showWarningMessage(
      `Drop "${node.stash.message || node.stash.ref}"? This cannot be undone.`, { modal: true }, 'Drop');
    if (confirm !== 'Drop') return;
    try { await repo.stashDrop(node.stash.ref); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: stash drop failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.stash.rename', async (node: NavNode) => {
    if (node.kind !== 'stash') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    const newMessage = await vscode.window.showInputBox({
      title: 'Rename Stash', prompt: 'Enter a new description for the stash', value: node.stash.message,
    });
    if (!newMessage || newMessage === node.stash.message) return;
    try { await repo.stashRename(node.stash.ref, newMessage); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: stash rename failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.stash.openFileDiff', async (node: NavNode) => {
    if (node.kind !== 'stashFile') return;
    const fileName = path.basename(node.file.path);
    const fileUri = vscode.Uri.file(path.join(node.repoRoot, node.file.path));
    const stashUri = (ref: string): vscode.Uri => vscode.Uri.from({
      scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }),
    });
    const title = `${fileName} (${node.stashRef})`;
    await vscode.commands.executeCommand('vscode.diff', stashUri(`${node.stashRef}^`), stashUri(node.stashRef), title, { preview: true });
  }));

  // ── Worktree actions (node-signature) ──
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.openInExplorer', (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.wt.path));
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.openInNewWindow', (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.wt.path), { forceNewWindow: true });
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.openInOS', (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.wt.path));
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.addToWorkspace', (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(node.wt.path) });
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.lock', async (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    const reason = await vscode.window.showInputBox({ prompt: 'Lock reason (optional)' });
    try { await repo.lockWorktree(node.wt.path, reason); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: lock failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.unlock', async (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.unlockWorktree(node.wt.path); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: unlock failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.remove', async (node: NavNode) => {
    if (node.kind !== 'worktree') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove worktree "${node.wt.branchShort || node.wt.path}"?`, { modal: true }, 'Remove');
    if (confirm !== 'Remove') return;
    try {
      await repo.deleteWorktree(node.wt.path, false).catch(() => repo.deleteWorktree(node.wt!.path, true));
      await refreshAfter();
    } catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: remove failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.worktree.prune', async (node: NavNode) => {
    if (node.kind !== 'repo' && node.kind !== 'group') return;
    const repoId = node.kind === 'repo' ? node.meta.id : node.repoId;
    const repo = manager.getRepo(repoId);
    if (!repo) return;
    try { await repo.pruneWorktrees(); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: prune failed: ${String(e)}`); }
  }));

  // ── Branch/tag actions (node-signature) ──
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.branch.checkout', async (node: NavNode) => {
    if (node.kind !== 'branch') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.checkout(node.branch.isRemote ? node.branch.fullName : node.branch.name); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: checkout failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.branch.merge', async (node: NavNode) => {
    if (node.kind !== 'branch') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.merge(node.branch.fullName); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: merge failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.branch.rebase', async (node: NavNode) => {
    if (node.kind !== 'branch') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.rebase(node.branch.fullName); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: rebase failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.branch.delete', async (node: NavNode) => {
    if (node.kind !== 'branch') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete branch "${node.branch.name}"?`, { modal: true }, 'Delete');
    if (confirm !== 'Delete') return;
    try { await repo.deleteBranch(node.branch.name, false); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: delete branch failed: ${String(e)}`); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.nav.tag.checkout', async (node: NavNode) => {
    if (node.kind !== 'tag') return;
    const repo = manager.getRepo(node.repoId);
    if (!repo) return;
    try { await repo.checkoutTag(node.name); await refreshAfter(); }
    catch (e: unknown) { vscode.window.showErrorMessage(`Git Suite: checkout tag failed: ${String(e)}`); }
  }));

  return disposables;
}
