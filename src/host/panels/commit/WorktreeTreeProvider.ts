import * as vscode from 'vscode';
import type { WorktreeEntry } from '../../git/GitService';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';

type WorktreeNode =
  | { kind: 'repo'; repoId: string; name: string }
  | { kind: 'worktree'; repoId: string; wt: WorktreeEntry };

export class WorktreeTreeProvider implements vscode.TreeDataProvider<WorktreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<WorktreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private byRepo: { repoId: string; name: string; worktrees: WorktreeEntry[] }[] = [];

  constructor(private readonly manager: WorkspaceGitManager) {
    manager.onReposChange(() => this.load());
    manager.onBranchChange(() => this.load());
    setTimeout(() => this.load(), 500);
  }

  refresh(): void { this._onDidChange.fire(undefined); }

  private async load(): Promise<void> {
    try {
      const metas = this.manager.getRepoMetas().filter(m => !m.isWorktree);
      const entries = await Promise.all(metas.map(async m => {
        const wts = await this.manager.getWorktrees(m.id).catch(() => []);
        return { repoId: m.id, name: m.name, worktrees: wts };
      }));
      this.byRepo = entries.filter(e => e.worktrees.length > 0);
      this.refresh();
    } catch { /* retry on next change */ }
  }

  getChildren(element?: WorktreeNode): WorktreeNode[] {
    if (!element) return this.byRepo.map(r => ({ kind: 'repo', repoId: r.repoId, name: r.name }));
    if (element.kind === 'repo') {
      const r = this.byRepo.find(x => x.repoId === element.repoId);
      if (!r) return [];
      return r.worktrees.map(wt => ({ kind: 'worktree', repoId: r.repoId, wt }));
    }
    return [];
  }

  getTreeItem(node: WorktreeNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.contextValue = 'gitsuite.wtRepo';
      return item;
    }
    const wt = node.wt;
    const label = wt.branchShort || (wt.isDetached ? `(detached) ${wt.head.slice(0, 7)}` : wt.head.slice(0, 7));
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(wt.isMain ? 'root-folder' : 'folder-library');
    item.resourceUri = vscode.Uri.file(wt.path);
    const badges: string[] = [];
    if (wt.isMain) badges.push('main');
    if (wt.isInWorkspace) badges.push('in workspace');
    if (wt.isPrunable) badges.push('prunable');
    if (wt.isLocked) badges.push(wt.lockReason ? `locked: ${wt.lockReason}` : 'locked');
    item.description = badges.join(' · ');
    item.tooltip = `${wt.path}\n${wt.branchShort || '(detached)'} · ${wt.head.slice(0, 7)}${wt.isLocked ? `\nlocked: ${wt.lockReason ?? ''}` : ''}`;
    item.contextValue = wt.isLocked ? 'gitsuite.worktree.locked' : 'gitsuite.worktree';
    item.command = { command: 'gitsuite.worktree.openInExplorer', title: 'Reveal', arguments: [wt.path] };
    return item;
  }
}
