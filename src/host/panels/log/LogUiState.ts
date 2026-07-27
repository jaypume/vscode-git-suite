import * as vscode from 'vscode';
import type { CommitNode } from '../../types/git';

/**
 * Shared UI state for the Git Log area.
 *
 * The graph stays in the webview, but the commit-file tree and branch tree are
 * native TreeViews. They cannot read webview state directly, so the host holds
 * the shared selection here and emits change events.
 */
export interface SelectedCommit {
  repoId: string;
  hash: string;
  parents: string[];
  isStash?: boolean;
  message?: string;
  shortHash?: string;
}

export type FileViewMode = 'tree' | 'flat';

class LogUiStateImpl {
  private _selected: SelectedCommit | null = null;
  private _fileViewMode: FileViewMode = 'tree';
  private readonly _onChange = new vscode.EventEmitter<SelectedCommit | null>();
  private readonly _onViewModeChange = new vscode.EventEmitter<FileViewMode>();

  readonly onDidChangeSelection = this._onChange.event;
  readonly onDidChangeFileViewMode = this._onViewModeChange.event;

  get selected(): SelectedCommit | null { return this._selected; }

  setSelectedCommit(commit: CommitNode | SelectedCommit | null): void {
    if (!commit) {
      if (this._selected === null) return;
      this._selected = null;
    } else {
      const next: SelectedCommit = 'shortHash' in commit && 'message' in commit
        ? { repoId: commit.repoId, hash: commit.hash, parents: commit.parents, isStash: commit.isStash, message: commit.message, shortHash: commit.shortHash }
        : commit;
      this._selected = next;
    }
    this._onChange.fire(this._selected);
  }

  get fileViewMode(): FileViewMode { return this._fileViewMode; }

  setFileViewMode(mode: FileViewMode): void {
    if (this._fileViewMode === mode) return;
    this._fileViewMode = mode;
    this._onViewModeChange.fire(mode);
  }
}

export const logUiState = new LogUiStateImpl();
