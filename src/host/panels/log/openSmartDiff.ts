import * as path from 'path';
import * as vscode from 'vscode';
import type { GitService } from '../../git/GitService';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface SmartDiffArgs {
  hash: string;
  filePath: string;
  fileStatus?: string;
  oldPath?: string;
  parents?: string[];
  combined?: boolean;
}

/**
 * Open a diff editor for a file in a given commit, choosing the correct parent
 * / empty-tree side based on git status. Extracted from GitLogPanelProvider so
 * the native commit-file tree command can reuse it.
 */
export async function openSmartDiff(repo: GitService, msg: SmartDiffArgs): Promise<void> {
  const rootPath = repo.rootPath;
  const status = msg.fileStatus ?? 'M';
  const shortHash = msg.hash.slice(0, 8);
  const fileName = path.basename(msg.filePath);

  const gitUri = (ref: string, filePath: string): vscode.Uri => {
    const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
    return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
  };

  const resolveParent = async (index = 0): Promise<string | null> => {
    const parents = msg.parents?.filter(Boolean) ?? [];
    if (parents[index]) return parents[index];
    const list = await repo.getParents(msg.hash);
    return list[index] ?? null;
  };

  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  let title: string;

  if (status === 'A' || status === 'C') {
    leftUri = gitUri(EMPTY_TREE, msg.filePath);
    rightUri = gitUri(msg.hash, msg.filePath);
    title = `${fileName} (added in ${shortHash})`;
  } else if (status === 'D') {
    const parentRef = (await resolveParent()) ?? `${msg.hash}~1`;
    leftUri = gitUri(parentRef, msg.filePath);
    rightUri = gitUri(EMPTY_TREE, msg.filePath);
    title = `${fileName} (deleted in ${shortHash})`;
  } else if (status === 'R') {
    const oldFilePath = msg.oldPath ?? msg.filePath;
    const parentRef = (await resolveParent()) ?? `${msg.hash}~1`;
    leftUri = gitUri(parentRef, oldFilePath);
    rightUri = gitUri(msg.hash, msg.filePath);
    title = `${path.basename(oldFilePath)} → ${fileName} (renamed in ${shortHash})`;
  } else {
    let parentRef: string;
    if (msg.combined) {
      parentRef = (await repo.findParentWithFileDiff(msg.hash, msg.filePath, msg.parents ?? [])) ?? `${msg.hash}~1`;
    } else {
      parentRef = (await resolveParent(0)) ?? `${msg.hash}~1`;
    }
    const parentHasFile = await repo.gitObjectExists(parentRef, msg.filePath);
    if (!parentHasFile) {
      leftUri = gitUri(EMPTY_TREE, msg.filePath);
      rightUri = gitUri(msg.hash, msg.filePath);
      title = `${fileName} (added in ${shortHash})`;
    } else {
      leftUri = gitUri(parentRef, msg.filePath);
      rightUri = gitUri(msg.hash, msg.filePath);
      title = `${fileName} (${shortHash})`;
    }
  }

  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
}
