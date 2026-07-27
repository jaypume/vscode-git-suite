import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { GitSuiteSCMProvider } from './GitSuiteSCMProvider';
import { generateCommitMessage } from '../ai/generateCommitMessage';

/**
 * Register the native SourceControl provider (per-repo) and its commands.
 */
export function registerSCM(manager: WorkspaceGitManager): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const provider = new GitSuiteSCMProvider(manager);
  disposables.push(provider);

  const repoOf = (uri: vscode.Uri): string | undefined => {
    // repoId is encoded in the SourceControl id "gitsuite-<repoId>"; resolve via rootPath match
    const meta = manager.getRepoMetas().find(m => uri.fsPath.startsWith(m.rootPath));
    return meta?.id;
  };

  // ── Open diff ──
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.openDiff', async (repoId: string, filePath: string) => {
    const repo = manager.getRepo(repoId);
    if (!repo) return;
    await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(`${repo.rootPath}/${filePath}`));
  }));

  // ── Stage / Unstage / Discard (per resource, take resourceStates[]) ──
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.stage', async (...states: vscode.SourceControlResourceState[]) => {
    for (const s of states) {
      if (!s.resourceUri) continue;
      const id = repoOf(s.resourceUri);
      const repo = id && manager.getRepo(id);
      if (repo) await repo.stageFiles([s.resourceUri.fsPath.slice(repo.rootPath.length + 1)]).catch(() => {});
    }
    await manager.getAllStatusesFresh();
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.unstage', async (...states: vscode.SourceControlResourceState[]) => {
    for (const s of states) {
      if (!s.resourceUri) continue;
      const id = repoOf(s.resourceUri);
      const repo = id && manager.getRepo(id);
      if (repo) await repo.unstageFiles([s.resourceUri.fsPath.slice(repo.rootPath.length + 1)]).catch(() => {});
    }
    await manager.getAllStatusesFresh();
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.discard', async (...states: vscode.SourceControlResourceState[]) => {
    const ok = await vscode.window.showWarningMessage(
      `Discard changes in ${states.length} file(s)? This cannot be undone.`, { modal: true }, 'Discard');
    if (ok !== 'Discard') return;
    for (const s of states) {
      if (!s.resourceUri) continue;
      const id = repoOf(s.resourceUri);
      const repo = id && manager.getRepo(id);
      if (repo) await repo.discardFile(s.resourceUri.fsPath.slice(repo.rootPath.length + 1)).catch(() => {});
    }
    await manager.getAllStatusesFresh();
  }));

  // ── Stage All / Unstage All / Discard All (take a SourceControlResourceGroup) ──
  const groupIdOf = (group?: vscode.SourceControlResourceGroup): string | undefined => group?.id;
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.stageAll', async (group?: vscode.SourceControlResourceGroup) => {
    void groupIdOf;
    const repoId = group?.resourceStates.find(s => s.resourceUri && repoOf(s.resourceUri)) && repoOf(group!.resourceStates[0].resourceUri!);
    const repo = repoId && manager.getRepo(repoId);
    if (repo) { await repo.stageAll(); await manager.getAllStatusesFresh(); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.unstageAll', async (group?: vscode.SourceControlResourceGroup) => {
    const repoId = group?.resourceStates.find(s => s.resourceUri && repoOf(s.resourceUri)) && repoOf(group!.resourceStates[0].resourceUri!);
    const repo = repoId && manager.getRepo(repoId);
    if (repo) { await repo.unstageAll(); await manager.getAllStatusesFresh(); }
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.discardAll', async (group?: vscode.SourceControlResourceGroup) => {
    const ok = await vscode.window.showWarningMessage('Discard all changes in this group?', { modal: true }, 'Discard');
    if (ok !== 'Discard' || !group) return;
    const repoId = group.resourceStates.find(s => s.resourceUri && repoOf(s.resourceUri)) && repoOf(group.resourceStates[0].resourceUri!);
    const repo = repoId && manager.getRepo(repoId);
    if (repo) {
      for (const s of group.resourceStates) {
        if (s.resourceUri) await repo.discardFile(s.resourceUri.fsPath.slice(repo.rootPath.length + 1)).catch(() => {});
      }
      await manager.getAllStatusesFresh();
    }
  }));

  // ── Commit (inputBox acceptInput), Amend, Commit & Push ──
  const doCommit = async (repoId: string, amend: boolean, andPush: boolean) => {
    const scm = provider.getControl(repoId);
    const repo = manager.getRepo(repoId);
    if (!scm || !repo) return;
    const message = scm.control.inputBox.value.trim();
    if (!message) { vscode.window.showWarningMessage('Commit message is empty.'); return; }
    try {
      await repo.commit(message, amend);
      if (andPush) await repo.push();
      scm.control.inputBox.value = '';
      await manager.getAllStatusesFresh();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Git Suite: commit failed: ${String(e)}`);
    }
  };
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.commit', (repoId: string) => doCommit(repoId, false, false)));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.commitAmend', async (repoId: string) => {
    const scm = provider.getControl(repoId);
    const repo = manager.getRepo(repoId);
    if (!scm || !repo) return;
    // pre-fill message from last commit if empty
    if (!scm.control.inputBox.value.trim()) {
      try { scm.control.inputBox.value = await repo.getLastCommitMessage(); } catch { /* keep empty */ }
    }
    await doCommit(repoId, true, false);
  }));
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.commitAndPush', (repoId: string) => doCommit(repoId, false, true)));

  // ── AI: generate commit message into the inputBox ──
  disposables.push(vscode.commands.registerCommand('gitsuite.scm.aiMessage', async (repoId: string) => {
    const scm = provider.getControl(repoId);
    if (!scm) return;
    try {
      scm.control.inputBox.value = 'Generating…';
      const msg = await generateCommitMessage(manager, repoId);
      scm.control.inputBox.value = msg;
    } catch (e: unknown) {
      scm.control.inputBox.value = '';
      vscode.window.showErrorMessage(`Git Suite: AI message failed: ${String(e)}`);
    }
  }));

  return disposables;
}
