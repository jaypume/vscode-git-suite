import * as path from 'path';
import * as vscode from 'vscode';
import type { BranchInfo, RepoMeta } from '../../types/git';
import type { StashEntry, TagInfo } from '../../types/messages';
import type { WorktreeEntry } from '../../git/GitService';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';

type Bucket = 'branches' | 'tags' | 'stashes' | 'worktrees';

export type NavNode =
  | { kind: 'repo'; meta: RepoMeta }
  | { kind: 'group'; repoId: string; bucket: Bucket }
  | { kind: 'typeGroup'; bucket: Bucket }
  | { kind: 'branch'; repoId: string; branch: BranchInfo }
  | { kind: 'tag'; repoId: string; name: string }
  | { kind: 'stash'; repoId: string; repoRoot: string; stash: StashEntry }
  | { kind: 'stashFile'; repoId: string; repoRoot: string; stashRef: string; file: { path: string; status: string } }
  | { kind: 'worktree'; repoId: string; wt: WorktreeEntry };

const BUCKET_ICON: Record<Bucket, string> = {
  branches: 'git-branch', tags: 'tag', stashes: 'archive', worktrees: 'folder-library',
};

function baseName(b: BranchInfo): string {
  if (b.isRemote) {
    const n = b.name.replace(/^refs\/remotes\//, '');
    const idx = n.indexOf('/');
    return idx >= 0 ? n.slice(idx + 1) : n;
  }
  return b.name.replace(/^refs\/heads\//, '');
}

/**
 * Unified Git Navigator: branches / tags / stashes / worktrees in one native
 * TreeView, replacing the three separate views. Default grouping is by repo.
 */
export type NavGroupBy = 'byRepo' | 'byType' | 'flat';

export class NavigatorTreeProvider implements vscode.TreeDataProvider<NavNode> {
  private readonly _onDidChange = new vscode.EventEmitter<NavNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private groupBy: NavGroupBy = 'byRepo';
  private filteredRepoIds: Set<string> | null = null; // null = no filter (all repos)
  private branches: BranchInfo[] = [];
  private tags: TagInfo[] = [];
  private stashesByRepo = new Map<string, StashEntry[]>();
  private worktreesByRepo = new Map<string, WorktreeEntry[]>();
  private metas: RepoMeta[] = [];

  get currentGroupBy(): NavGroupBy { return this.groupBy; }
  get allMetas(): RepoMeta[] { return this.metas; }
  get activeFilter(): Set<string> | null { return this.filteredRepoIds; }

  /** Restrict visible repos to the given ids (null/empty = show all). */
  setFilteredRepoIds(ids: string[] | null): void {
    if (!ids || ids.length === 0) this.filteredRepoIds = null;
    else this.filteredRepoIds = new Set(ids);
    this.refresh();
  }

  private visibleMetas(): RepoMeta[] {
    if (!this.filteredRepoIds) return this.metas;
    return this.metas.filter(m => this.filteredRepoIds!.has(m.id));
  }

  setGroupBy(g: NavGroupBy): void {
    if (this.groupBy === g) return;
    this.groupBy = g;
    this.refresh();
  }

  constructor(private readonly manager: WorkspaceGitManager) {
    manager.onBranchChange(() => this.load());
    manager.onReposChange(() => this.load());
    manager.onWorktreeChange(() => this.load());
    setTimeout(() => this.load(), 500);
  }

  refresh(): void { this._onDidChange.fire(undefined); }

  private async load(): Promise<void> {
    try {
      const [branches, metas] = await Promise.all([this.manager.getAllBranches(), Promise.resolve(this.manager.getRepoMetas())]);
      this.branches = branches;
      this.metas = metas.filter(m => !m.isWorktree);

      const tagLists = await Promise.allSettled(this.metas.map(m => this.manager.getRepo(m.id)?.getTags()));
      const tags: TagInfo[] = [];
      this.metas.forEach((m, i) => {
        const r = tagLists[i];
        if (r?.status === 'fulfilled' && r.value) for (const t of r.value) tags.push({ ...t, repoId: m.id });
      });
      this.tags = tags;

      const stashLists = await Promise.allSettled(this.metas.map(m => this.manager.getRepo(m.id)?.stashList()));
      this.stashesByRepo = new Map();
      this.metas.forEach((m, i) => {
        const r = stashLists[i];
        if (r?.status === 'fulfilled' && r.value) this.stashesByRepo.set(m.id, r.value);
      });

      const wtLists = await Promise.allSettled(this.metas.map(m => this.manager.getWorktrees(m.id)));
      this.worktreesByRepo = new Map();
      this.metas.forEach((m, i) => {
        const r = wtLists[i];
        if (r?.status === 'fulfilled' && r.value) this.worktreesByRepo.set(m.id, r.value);
      });

      this.refresh();
    } catch { /* retry on next change event */ }
  }

  private branchesFor(repoId: string): BranchInfo[] {
    return this.branches
      .filter(b => b.repoId === repoId && !b.detachedTag && !b.detachedHash)
      .sort((a, b) => {
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
        if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
        return baseName(a).localeCompare(baseName(b));
      });
  }

  /** Flat (cross-repo) branch nodes — no merging, each carries its repoId. */
  private flatBranches(): NavNode[] {
    return this.branches
      .filter(b => !b.detachedTag && !b.detachedHash && this.isVisibleRepo(b.repoId))
      .sort((a, b) => baseName(a).localeCompare(baseName(b)))
      .map(b => ({ kind: 'branch', repoId: b.repoId, branch: b }));
  }

  private flatTags(): NavNode[] {
    return this.tags.filter(t => this.isVisibleRepo(t.repoId)).slice().sort((a, b) => a.name.localeCompare(b.name)).map(t => ({ kind: 'tag', repoId: t.repoId, name: t.name }));
  }

  private flatStashes(): NavNode[] {
    const out: NavNode[] = [];
    for (const m of this.visibleMetas()) {
      const repo = this.manager.getRepo(m.id);
      const root = repo?.rootPath ?? '';
      for (const s of (this.stashesByRepo.get(m.id) ?? [])) out.push({ kind: 'stash', repoId: m.id, repoRoot: root, stash: s });
    }
    return out;
  }

  private flatWorktrees(): NavNode[] {
    const out: NavNode[] = [];
    for (const m of this.visibleMetas()) {
      for (const w of (this.worktreesByRepo.get(m.id) ?? [])) {
        if (!w.isMain) out.push({ kind: 'worktree', repoId: m.id, wt: w });
      }
    }
    return out;
  }

  private isVisibleRepo(repoId: string): boolean {
    return !this.filteredRepoIds || this.filteredRepoIds.has(repoId);
  }

  getChildren(element?: NavNode): NavNode[] {
    // Root depends on grouping
    if (!element) {
      const metas = this.visibleMetas();
      if (this.groupBy === 'byRepo') return metas.map(m => ({ kind: 'repo', meta: m }));
      if (this.groupBy === 'byType') {
        const groups: NavNode[] = [];
        if (this.branches.some(b => this.isVisibleRepo(b.repoId))) groups.push({ kind: 'typeGroup', bucket: 'branches' });
        if (this.tags.some(t => this.isVisibleRepo(t.repoId))) groups.push({ kind: 'typeGroup', bucket: 'tags' });
        if (metas.some(m => (this.stashesByRepo.get(m.id) ?? []).length)) groups.push({ kind: 'typeGroup', bucket: 'stashes' });
        if (metas.some(m => (this.worktreesByRepo.get(m.id) ?? []).some(w => !w.isMain))) groups.push({ kind: 'typeGroup', bucket: 'worktrees' });
        return groups;
      }
      // flat: all items mixed, bucketed by type
      return [...this.flatBranches(), ...this.flatTags(), ...this.flatStashes(), ...this.flatWorktrees()];
    }

    // byType: typeGroup → items (stashes/worktrees keep repo sub-level for repoId)
    if (element.kind === 'typeGroup') {
      if (element.bucket === 'branches') return this.flatBranches();
      if (element.bucket === 'tags') return this.flatTags();
      if (element.bucket === 'stashes') return this.visibleMetas().filter(m => (this.stashesByRepo.get(m.id) ?? []).length).map(m => ({ kind: 'repo', meta: m }));
      if (element.bucket === 'worktrees') return this.visibleMetas().filter(m => (this.worktreesByRepo.get(m.id) ?? []).some(w => !w.isMain)).map(m => ({ kind: 'repo', meta: m }));
    }

    // byType: repo under stashes/worktrees typeGroup → its stashes/worktrees (not sub-grouped)
    if (element.kind === 'repo' && this.groupBy === 'byType') {
      const id = element.meta.id;
      const repo = this.manager.getRepo(id);
      const root = repo?.rootPath ?? '';
      const stashes = (this.stashesByRepo.get(id) ?? []).map(s => ({ kind: 'stash' as const, repoId: id, repoRoot: root, stash: s }));
      const wts = (this.worktreesByRepo.get(id) ?? []).filter(w => !w.isMain).map(w => ({ kind: 'worktree' as const, repoId: id, wt: w }));
      return [...stashes, ...wts];
    }

    if (element.kind === 'repo') {
      const repoId = element.meta.id;
      const groups: NavNode[] = [];
      if (this.branchesFor(repoId).length) groups.push({ kind: 'group', repoId, bucket: 'branches' });
      if (this.tags.filter(t => t.repoId === repoId).length) groups.push({ kind: 'group', repoId, bucket: 'tags' });
      if ((this.stashesByRepo.get(repoId) ?? []).length) groups.push({ kind: 'group', repoId, bucket: 'stashes' });
      if ((this.worktreesByRepo.get(repoId) ?? []).filter(w => !w.isMain).length) groups.push({ kind: 'group', repoId, bucket: 'worktrees' });
      return groups;
    }

    if (element.kind === 'group') {
      const { repoId, bucket } = element;
      if (bucket === 'branches') return this.branchesFor(repoId).map(b => ({ kind: 'branch', repoId, branch: b }));
      if (bucket === 'tags') return this.tags.filter(t => t.repoId === repoId).map(t => ({ kind: 'tag', repoId, name: t.name }));
      if (bucket === 'stashes') {
        const repo = this.manager.getRepo(repoId);
        const root = repo?.rootPath ?? '';
        return (this.stashesByRepo.get(repoId) ?? []).map(s => ({ kind: 'stash', repoId, repoRoot: root, stash: s }));
      }
      if (bucket === 'worktrees') return (this.worktreesByRepo.get(repoId) ?? []).filter(w => !w.isMain).map(w => ({ kind: 'worktree', repoId, wt: w }));
    }

    if (element.kind === 'stash') {
      return element.stash.files.map(f => ({ kind: 'stashFile', repoId: element.repoId, repoRoot: element.repoRoot, stashRef: element.stash.ref, file: f }));
    }

    return [];
  }

  getTreeItem(node: NavNode): vscode.TreeItem {
    switch (node.kind) {
      case 'repo': {
        const item = new vscode.TreeItem(node.meta.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'gitsuite.nav.repo';
        return item;
      }
      case 'group':
      case 'typeGroup': {
        const bucket = node.bucket;
        const item = new vscode.TreeItem(this.groupLabel(node, bucket), vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(BUCKET_ICON[bucket]);
        item.contextValue = node.kind === 'group' ? `gitsuite.nav.group.${bucket}` : `gitsuite.nav.typeGroup.${bucket}`;
        return item;
      }
      case 'branch': {
        const b = node.branch;
        const label = baseName(b);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(b.isRemote ? 'cloud' : 'git-branch');
        const parts: string[] = [];
        if (b.isHead) parts.push('current');
        if (b.aheadBehind && (b.aheadBehind.ahead || b.aheadBehind.behind)) parts.push(`↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}`);
        item.description = parts.join(' · ');
        item.tooltip = `${b.fullName}${b.isHead ? ' (HEAD)' : ''}`;
        item.contextValue = b.isHead ? 'gitsuite.nav.branch.local.head' : (b.isRemote ? 'gitsuite.nav.branch.remote' : 'gitsuite.nav.branch.local');
        return item;
      }
      case 'tag': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('tag');
        item.contextValue = 'gitsuite.nav.tag';
        return item;
      }
      case 'stash': {
        const item = new vscode.TreeItem(node.stash.message, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('archive');
        item.description = `${node.stash.branch} · ${node.stash.files.length} files`;
        item.tooltip = `${node.stash.ref}\n${node.stash.message}`;
        item.contextValue = 'gitsuite.nav.stash';
        return item;
      }
      case 'stashFile': {
        const item = new vscode.TreeItem(path.basename(node.file.path), vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file');
        item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, node.file.path));
        item.description = node.file.status;
        item.tooltip = `${node.file.path} (${node.file.status})`;
        item.contextValue = 'gitsuite.nav.stashFile';
        return item;
      }
      case 'worktree': {
        const wt = node.wt;
        const label = wt.branchShort || (wt.isDetached ? `(detached) ${wt.head.slice(0, 7)}` : wt.head.slice(0, 7));
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(wt.isMain ? 'root-folder' : 'folder-library');
        item.resourceUri = vscode.Uri.file(wt.path);
        const badges: string[] = [];
        if (wt.isInWorkspace) badges.push('in workspace');
        if (wt.isPrunable) badges.push('prunable');
        if (wt.isLocked) badges.push(wt.lockReason ? `locked: ${wt.lockReason}` : 'locked');
        item.description = badges.join(' · ');
        item.tooltip = `${wt.path}\n${wt.branchShort || '(detached)'}`;
        item.contextValue = wt.isLocked ? 'gitsuite.nav.worktree.locked' : 'gitsuite.nav.worktree';
        return item;
      }
    }
  }

  private groupLabel(node: { kind: 'group' | 'typeGroup'; repoId?: string }, bucket: Bucket): string {
    const count = node.kind === 'group'
      ? this.bucketCount(node.repoId!, bucket)
      : this.bucketCountAll(bucket);
    return `${bucket[0].toUpperCase()}${bucket.slice(1)}${count ? ` (${count})` : ''}`;
  }

  private bucketCount(repoId: string, bucket: Bucket): number {
    if (bucket === 'branches') return this.branchesFor(repoId).length;
    if (bucket === 'tags') return this.tags.filter(t => t.repoId === repoId).length;
    if (bucket === 'stashes') return (this.stashesByRepo.get(repoId) ?? []).length;
    return (this.worktreesByRepo.get(repoId) ?? []).filter(w => !w.isMain).length;
  }

  private bucketCountAll(bucket: Bucket): number {
    if (bucket === 'branches') return this.branches.length;
    if (bucket === 'tags') return this.tags.length;
    if (bucket === 'stashes') return [...this.stashesByRepo.values()].reduce((s, l) => s + l.length, 0);
    return [...this.worktreesByRepo.values()].reduce((s, l) => s + l.filter(w => !w.isMain).length, 0);
  }
}
