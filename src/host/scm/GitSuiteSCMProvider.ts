import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { FileStatus, GitFileStatus, RepoStatus } from '../types/git';

/** VS Code ThemeColor per git status, mirroring built-in git decorations. */
function statusThemeColor(s: GitFileStatus): vscode.ThemeColor | undefined {
  switch (s) {
    case 'modified': return new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
    case 'added': return new vscode.ThemeColor('gitDecoration.addedResourceForeground');
    case 'deleted': return new vscode.ThemeColor('gitDecoration.deletedResourceForeground');
    case 'renamed':
    case 'copied': return new vscode.ThemeColor('gitDecoration.renamedResourceForeground');
    case 'untracked': return new vscode.ThemeColor('gitDecoration.untrackedResourceForeground');
    case 'conflicted': return new vscode.ThemeColor('gitDecoration.conflictingResourceForeground');
    default: return undefined;
  }
}

function statusLetter(s: GitFileStatus): string {
  switch (s) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'untracked': return 'U';
    case 'conflicted': return 'C';
    default: return '?';
  }
}

interface RepoSCM {
  control: vscode.SourceControl;
  staged: vscode.SourceControlResourceGroup;
  changes: vscode.SourceControlResourceGroup;
}

/**
 * Owns one SourceControl per non-worktree repo. Files come from the shared
 * WorkspaceGitManager status stream; staging/unstaging/discard/commit happen
 * via gitsuite.scm.* commands (registered in registerSCM).
 */
export class GitSuiteSCMProvider implements vscode.Disposable {
  private readonly byRepo = new Map<string, RepoSCM>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: WorkspaceGitManager) {
    this.sync();
    this.disposables.push(manager.onReposChange(() => this.sync()));
    this.disposables.push(manager.onStatusChange(status => this.onStatus(status)));
  }

  /** Snapshot of managed SourceControls, for command handlers. */
  getControl(repoId: string): RepoSCM | undefined { return this.byRepo.get(repoId); }

  private sync(): void {
    const metas = this.manager.getRepoMetas().filter(m => !m.isWorktree);
    const seen = new Set<string>();

    for (const m of metas) {
      seen.add(m.id);
      if (!this.byRepo.has(m.id)) this.createRepo(m.id, m.name, m.rootPath);
    }
    // Drop controls for vanished repos
    for (const id of [...this.byRepo.keys()]) {
      if (!seen.has(id)) { this.byRepo.get(id)?.control.dispose(); this.byRepo.delete(id); }
    }
  }

  private createRepo(repoId: string, name: string, rootPath: string): void {
    const control = vscode.scm.createSourceControl(`gitsuite-${repoId}`, `Git Suite: ${name}`, vscode.Uri.file(rootPath));
    control.inputBox.enabled = true;
    control.acceptInputCommand = { command: 'gitsuite.scm.commit', title: 'Commit', arguments: [repoId] };
    const staged = control.createResourceGroup('staged', 'Staged Changes');
    const changes = control.createResourceGroup('changes', 'Changes');
    staged.hideWhenEmpty = true;
    changes.hideWhenEmpty = true;
    this.byRepo.set(repoId, { control, staged, changes });
  }

  private onStatus(status: WorkspaceStatus): void {
    for (const repo of status.repos) this.updateRepo(repo);
  }

  private updateRepo(repo: RepoStatus): void {
    const scm = this.byRepo.get(repo.repoId);
    if (!scm) return;
    scm.staged.resourceStates = repo.stagedFiles.map(f => this.toResource(f, scm.staged, true));
    scm.changes.resourceStates = repo.unstagedFiles.map(f => this.toResource(f, scm.changes, false));
  }

  private toResource(f: FileStatus, group: vscode.SourceControlResourceGroup, staged: boolean): vscode.SourceControlResourceState {
    const uri = vscode.Uri.file(f.absolutePath);
    const color = statusThemeColor(f.status);
    const letter = statusLetter(f.status);
    return {
      resourceUri: uri,
      decorations: {
        tooltip: `${f.path} (${letter}${staged ? ', staged' : ''})`,
        strikeThrough: f.status === 'deleted',
        faded: false,
        color,
      },
      command: { command: 'gitsuite.scm.openDiff', title: 'Open Changes', arguments: [f.repoId, f.path, staged] },
    };
    void group;
  }

  dispose(): void {
    for (const { control } of this.byRepo.values()) control.dispose();
    this.byRepo.clear();
    for (const d of this.disposables) d.dispose();
  }
}
