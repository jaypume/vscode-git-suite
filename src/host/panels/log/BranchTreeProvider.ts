import * as vscode from 'vscode';
import type { BranchInfo, TagInfo } from '../../types/git';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';

type BranchNode =
  | { kind: 'category'; label: string; contextValue: string }
  | { kind: 'branch'; merged: MergedBranch }
  | { kind: 'tag'; name: string; repoIds: string[] };

interface MergedBranch {
  baseName: string;
  isHead: boolean;
  isRemote: boolean;
  repoIds: string[];
  ahead?: number;
  behind?: number;
}

const PRIMARY = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

function stripRemotePrefix(name: string): string {
  for (const p of ['refs/remotes/', 'refs/heads/']) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  // origin/foo, upstream/foo → foo (keep remote distinction via isRemote)
  const idx = name.indexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function mergeBranches(branches: BranchInfo[]): MergedBranch[] {
  const map = new Map<string, MergedBranch>();
  for (const b of branches) {
    const baseName = b.isRemote ? stripRemotePrefix(b.name) : b.name;
    const ex = map.get(baseName);
    if (ex) {
      if (!ex.repoIds.includes(b.repoId)) ex.repoIds.push(b.repoId);
      if (b.isHead) ex.isHead = true;
      if (b.aheadBehind) { ex.ahead = (ex.ahead ?? 0) + b.aheadBehind.ahead; ex.behind = (ex.behind ?? 0) + b.aheadBehind.behind; }
    } else {
      map.set(baseName, {
        baseName, isHead: b.isHead, isRemote: b.isRemote, repoIds: [b.repoId],
        ahead: b.aheadBehind?.ahead, behind: b.aheadBehind?.behind,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    const ap = PRIMARY.has(a.baseName) ? 0 : 1;
    const bp = PRIMARY.has(b.baseName) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.baseName.localeCompare(b.baseName);
  });
}

function mergeTags(tags: TagInfo[]): { name: string; repoIds: string[] }[] {
  const map = new Map<string, { name: string; repoIds: string[] }>();
  for (const t of tags) {
    const ex = map.get(t.name);
    if (ex) { if (!ex.repoIds.includes(t.repoId)) ex.repoIds.push(t.repoId); }
    else map.set(t.name, { name: t.name, repoIds: [t.repoId] });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchNode> {
  private readonly _onDidChange = new vscode.EventEmitter<BranchNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private local: MergedBranch[] = [];
  private remote: MergedBranch[] = [];
  private tags: { name: string; repoIds: string[] }[] = [];

  constructor(private readonly manager: WorkspaceGitManager) {
    manager.onBranchChange(() => this.load());
    manager.onReposChange(() => this.load());
    // initial load (deferred — repos may still be initializing)
    setTimeout(() => this.load(), 500);
  }

  refresh(): void { this._onDidChange.fire(undefined); }

  private async load(): Promise<void> {
    try {
      const all = await this.manager.getAllBranches();
      this.local = mergeBranches(all.filter(b => !b.isRemote));
      this.remote = mergeBranches(all.filter(b => b.isRemote));
      // tags
      const tagLists = await Promise.allSettled(
        this.manager.getRepoMetas().filter(m => !m.isWorktree).map(m => this.manager.getRepo(m.id)?.getTags()),
      );
      const tags: TagInfo[] = [];
      tagLists.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          const meta = this.manager.getRepoMetas().filter(m => !m.isWorktree)[i];
          for (const t of r.value) tags.push({ ...t, repoId: meta.id });
        }
      });
      this.tags = mergeTags(tags);
      this.refresh();
    } catch { /* ignore — will retry on next change */ }
  }

  getChildren(element?: BranchNode): BranchNode[] {
    if (!element) {
      const cats: BranchNode[] = [];
      if (this.local.length) cats.push({ kind: 'category', label: 'Local', contextValue: 'gitsuite.catLocal' });
      if (this.remote.length) cats.push({ kind: 'category', label: 'Remote', contextValue: 'gitsuite.catRemote' });
      if (this.tags.length) cats.push({ kind: 'category', label: 'Tags', contextValue: 'gitsuite.catTags' });
      return cats;
    }
    if (element.kind === 'category') {
      if (element.contextValue === 'gitsuite.catLocal') return this.local.map(b => ({ kind: 'branch', merged: b }));
      if (element.contextValue === 'gitsuite.catRemote') return this.remote.map(b => ({ kind: 'branch', merged: b }));
      return this.tags.map(t => ({ kind: 'tag', name: t.name, repoIds: t.repoIds }));
    }
    return [];
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
    if (node.kind === 'category') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = node.contextValue;
      return item;
    }
    if (node.kind === 'tag') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('tag');
      item.contextValue = 'gitsuite.tag';
      item.tooltip = node.repoIds.join(', ');
      return item;
    }
    const b = node.merged;
    const item = new vscode.TreeItem(b.baseName, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(b.isRemote ? 'cloud' : 'git-branch');
    item.label = { label: b.baseName, highlights: [] };
    if (b.isHead) item.label = { label: b.baseName }; // keep label; italic via description
    const parts: string[] = [];
    if (b.ahead || b.behind) parts.push(`↑${b.ahead ?? 0} ↓${b.behind ?? 0}`);
    if (b.repoIds.length > 1) parts.push(`${b.repoIds.length} repos`);
    item.description = [b.isHead ? 'current' : null, ...parts].filter(Boolean).join(' · ');
    item.contextValue = b.isRemote ? 'gitsuite.branch.remote' : 'gitsuite.branch.local';
    item.tooltip = `${b.baseName}\nrepos: ${b.repoIds.join(', ')}`;
    return item;
  }
}
