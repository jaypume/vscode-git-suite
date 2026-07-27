/**
 * File-tree construction for the native commit-file TreeView.
 *
 * Ported from src/webview/gitLog/components/CommitDetail.tsx (buildTree /
 * computeFileCounts / collapseSingleChildDirs). Pure logic, no DOM deps.
 */

export interface FileEntry {
  path: string;
  status: string;
  added?: number;
  removed?: number;
  oldPath?: string;
}

export interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  file: FileEntry | null;
  fileCount: number;
}

function makeNode(name: string, fullPath: string): TreeNode {
  return { name, fullPath, children: new Map(), file: null, fileCount: 0 };
}

export function buildTree(files: FileEntry[]): TreeNode {
  const root = makeNode('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, makeNode(part, accumulated));
      node = node.children.get(part)!;
      if (i === parts.length - 1) node.file = f;
    }
  }
  computeFileCounts(root);
  return root;
}

export function computeFileCounts(node: TreeNode): number {
  if (node.file) { node.fileCount = 1; return 1; }
  let count = 0;
  for (const child of node.children.values()) count += computeFileCounts(child);
  node.fileCount = count;
  return count;
}

/** Collapse single-child dir chains (a/b/c → one node), IntelliJ-style. */
export function collapseSingleChildDirs(node: TreeNode): TreeNode {
  if (node.file) return node;
  if (node.children.size === 1) {
    const [, child] = node.children.entries().next().value as [string, TreeNode];
    if (!child.file) {
      const collapsed = collapseSingleChildDirs(child);
      const joinedName = node.name ? `${node.name}/${collapsed.name}` : collapsed.name;
      return { ...collapsed, name: joinedName };
    }
  }
  const newChildren = new Map<string, TreeNode>();
  for (const [k, v] of node.children) newChildren.set(k, collapseSingleChildDirs(v));
  return { ...node, children: newChildren };
}
