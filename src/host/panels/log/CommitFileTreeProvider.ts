import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../../git/WorkspaceGitManager';
import { logUiState, type FileViewMode } from './LogUiState';
import { buildTree, collapseSingleChildDirs, type FileEntry, type TreeNode } from './fileTree';

type CommitFileNode =
  | { kind: 'file'; file: FileEntry; repoRoot: string }
  | { kind: 'dir'; node: TreeNode; repoRoot: string };

function statusDescription(f: FileEntry): string {
  const stat = f.status;
  const plus = f.added ?? 0;
  const minus = f.removed ?? 0;
  const nums = (plus || minus) ? ` +${plus} -${minus}` : '';
  return `${stat}${nums}`;
}

export class CommitFileTreeProvider implements vscode.TreeDataProvider<CommitFileNode> {
  private readonly _onDidChange = new vscode.EventEmitter<CommitFileNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private files: FileEntry[] = [];
  private repoRoot = '';

  constructor(private readonly manager: WorkspaceGitManager) {
    logUiState.onDidChangeSelection(() => this.loadSelected());
    logUiState.onDidChangeFileViewMode(() => this.refresh());
  }

  private async loadSelected(): Promise<void> {
    const sel = logUiState.selected;
    if (!sel) { this.files = []; this.repoRoot = ''; this.refresh(); return; }
    const repo = this.manager.getRepo(sel.repoId);
    if (!repo) { this.files = []; this.refresh(); return; }
    this.repoRoot = repo.rootPath;
    try {
      this.files = await repo.getCommitFiles(sel.hash, sel.parents);
    } catch {
      this.files = [];
    }
    this.refresh();
  }

  refresh(): void { this._onDidChange.fire(undefined); }

  getTreeItem(node: CommitFileNode): vscode.TreeItem {
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = String(node.node.fileCount);
      item.contextValue = 'gitsuite.logDir';
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      return item;
    }
    const f = node.file;
    const item = new vscode.TreeItem(path.basename(f.path), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('file');
    item.description = statusDescription(f);
    item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, f.path));
    item.tooltip = new vscode.MarkdownString(`${f.path}\n\nstatus: **${f.status}**${f.oldPath ? `  (was ${f.oldPath})` : ''}`);
    item.contextValue = 'gitsuite.logFile';
    const sel = logUiState.selected;
    if (sel) {
      item.command = {
        command: 'gitsuite.log.openFileDiff',
        title: 'Open Changes',
        arguments: [sel.repoId, sel.hash, f.path, f.status, f.oldPath, sel.parents],
      };
    }
    return item;
  }

  getChildren(element?: CommitFileNode): CommitFileNode[] {
    if (logUiState.fileViewMode === 'flat') {
      if (element) return [];
      return this.files.map(f => ({ kind: 'file' as const, file: f, repoRoot: this.repoRoot }));
    }
    // tree mode
    const root = collapseSingleChildDirs(buildTree(this.files));
    if (!element) {
      return [
        ...[...root.children.values()].map(c => (c.file
          ? { kind: 'file' as const, file: c.file, repoRoot: this.repoRoot }
          : { kind: 'dir' as const, node: c, repoRoot: this.repoRoot })),
      ];
    }
    if (element.kind === 'file') return [];
    return [...element.node.children.values()].map(c => (c.file
      ? { kind: 'file' as const, file: c.file, repoRoot: this.repoRoot }
      : { kind: 'dir' as const, node: c, repoRoot: this.repoRoot }));
  }
}
