import * as path from 'path';
import * as vscode from 'vscode';
import type { StashEntry } from '../../types/messages';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';

type StashNode =
  | { kind: 'repo'; repoId: string; name: string }
  | { kind: 'stash'; repoId: string; repoRoot: string; stash: StashEntry }
  | { kind: 'file'; repoId: string; repoRoot: string; stashRef: string; file: { path: string; status: string } };

export class StashTreeProvider implements vscode.TreeDataProvider<StashNode> {
  private readonly _onDidChange = new vscode.EventEmitter<StashNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private stashesByRepo: { repoId: string; name: string; repoRoot: string; stashes: StashEntry[] }[] = [];

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
        const repo = this.manager.getRepo(m.id);
        if (!repo) return null;
        const stashes = await repo.stashList().catch(() => []);
        return { repoId: m.id, name: m.name, repoRoot: repo.rootPath, stashes };
      }));
      this.stashesByRepo = entries.filter((e): e is { repoId: string; name: string; repoRoot: string; stashes: StashEntry[] } =>
        !!e && e.stashes.length > 0);
      this.refresh();
    } catch { /* retry on next change */ }
  }

  getChildren(element?: StashNode): StashNode[] {
    if (!element) return this.stashesByRepo.map(r => ({ kind: 'repo', repoId: r.repoId, name: r.name }));
    if (element.kind === 'repo') {
      const r = this.stashesByRepo.find(x => x.repoId === element.repoId);
      if (!r) return [];
      return r.stashes.map(s => ({ kind: 'stash', repoId: r.repoId, repoRoot: r.repoRoot, stash: s }));
    }
    if (element.kind === 'stash') {
      return element.stash.files.map(f => ({
        kind: 'file', repoId: element.repoId, repoRoot: element.repoRoot, stashRef: element.stash.ref, file: f,
      }));
    }
    return [];
  }

  getTreeItem(node: StashNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.contextValue = 'gitsuite.stashRepo';
      return item;
    }
    if (node.kind === 'stash') {
      const item = new vscode.TreeItem(node.stash.message, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = `${node.stash.branch} · ${node.stash.files.length} files`;
      item.tooltip = `${node.stash.ref}\n${node.stash.message}\nbranch: ${node.stash.branch}\ndate: ${node.stash.date}`;
      item.contextValue = 'gitsuite.stash';
      return item;
    }
    const f = node.file;
    const item = new vscode.TreeItem(path.basename(f.path), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('file');
    item.description = f.status;
    item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, f.path));
    item.tooltip = `${f.path} (${f.status})`;
    item.contextValue = 'gitsuite.stashFile';
    item.command = {
      command: 'gitsuite.stash.openFileDiff',
      title: 'Open Changes',
      arguments: [node.repoRoot, node.stashRef, f.path, f.status],
    };
    return item;
  }
}
