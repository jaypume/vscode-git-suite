import React, { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLogStore } from './store/logStore';
import { CommitList } from './components/CommitList';
import { CommitFiltersBar } from './components/CommitFiltersBar';
import { assignLanes } from './utils/graphLayout';
import type { GraphLayout } from './utils/graphLayout';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const LOAD_STEP = 150;


function App() {
  const store = useLogStore();
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeVersion(v => v + 1));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const filterRepoRef = useRef<(repoId: string | null, branch?: string | null) => void>(() => {});
  // Prevents concurrent requests
  const loadingInFlightRef = useRef(false);
  // Current requestId — used to discard responses from superseded requests
  const activeRequestIdRef = useRef<string | null>(null);

  const send = useCallback((msg: LogToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const request = useCallback(<T extends HostToLogMsg>(msg: LogToHostMsg): Promise<T> => {
    return new Promise((resolve) => {
      const reqId = generateId();
      const m = { ...msg, requestId: reqId } as LogToHostMsg & { requestId: string };
      pendingRef.current.set(reqId, r => resolve(r as T));
      getVsCodeApi().postMessage(m);
    });
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
        return;
      }

      switch (msg.type) {
        case 'LOG_INIT_DATA':
          // setRepos/setBranches unconditionally overwrite (not merge), while iconTheme is
          // conditional. So the host MUST send repos+branches+iconTheme in ONE message —
          // splitting them (e.g. {repos,branches} then {iconTheme}) would set repos/branches
          // to undefined on the second message. undockedPanel/main.tsx mirrors this exactly.
          store.setRepos(msg.repos, msg.hasWorkspaceFolder, msg.aiEnabled);
          store.setBranches(msg.branches);
          if (msg.iconTheme) store.setIconTheme(msg.iconTheme);
          break;
        case 'LOG_COMMITS_BATCH': {
          const match = msg.requestId === activeRequestIdRef.current;
          if (!match) break;
          loadingInFlightRef.current = false;
          store.appendCommits(msg.commits, msg.isLast);
          break;
        }
        case 'LOG_COMMIT_FILES':
          // Only process responses that belong to the selected commit (no requestId = legacy broadcast)
          // Responses with requestId are handled by pendingRef or the popover's own listener
          if (!msg.requestId) store.setCommitFiles(msg.files);
          break;
        case 'LOG_REFS_UPDATE':
          store.updateBranches(msg.repoId, msg.branches);
          break;
        case 'LOG_TAGS_UPDATE':
          store.updateTags(msg.repoId, msg.tags);
          break;
        case 'LOG_REFRESH':
          reloadRef.current();
          break;
        case 'LOG_BRANCH_OP_RESULT':
          if (!msg.ok && msg.error) {
            console.error('Branch operation failed:', msg.error);
          }
          break;
        case 'LOG_SCROLL_TO_COMMIT':
          filterRepoRef.current(msg.repoId, null);
          store.setPendingScrollHash(msg.hash);
          break;
        case 'LOG_FILTER_BY_REPO':
          filterRepoRef.current(msg.repoId, msg.branch ?? null);
          break;
        case 'LOG_STASHES_BATCH':
          store.setStashes(msg.stashCommits);
          break;
        case 'LOG_REMOTES_RESULT':
          break;
        case 'LOG_DESELECT_FILE': {
          const cur = store.selectedFile;
          if (cur && (msg.filePath.endsWith('/' + cur.path) || msg.filePath.endsWith('\\' + cur.path) || msg.filePath === cur.path)) {
            store.selectFile(null);
          }
          break;
        }
      }
    };
    window.addEventListener('message', handler);

    // Initial load
    const initReqId = generateId();
    activeRequestIdRef.current = initReqId;
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: [],
      limit: LOAD_STEP,
      skip: 0,
      requestId: initReqId,
    });

    return () => window.removeEventListener('message', handler);
  }, []);


  const sendAppendRequest = useCallback((f: import('./store/logStore').CommitFilters, skip: number) => {
    if (loadingInFlightRef.current) return;
    loadingInFlightRef.current = true;
    const reqId = generateId();
    activeRequestIdRef.current = reqId;
    useLogStore.getState().setBackgroundLoading(true);
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: f.repoId ? [f.repoId] : [],
      limit: LOAD_STEP,
      skip,
      requestId: reqId,
      filterText: f.text || undefined,
      filterAuthor: f.author || undefined,
      filterBranch: f.branch || undefined,
      // git --after and --before are exclusive; use time suffixes to make the range fully inclusive
      filterDateFrom: f.dateFrom ? `${f.dateFrom}T00:00:00` : undefined,
      filterDateTo: f.dateTo ? `${f.dateTo}T23:59:59` : undefined,
    } satisfies LogToHostMsg);
  }, []);

  const loadMore = useCallback(() => {
    const s = useLogStore.getState();
    if (loadingInFlightRef.current || !s.hasMore) return;
    sendAppendRequest(s.commitFilters, s.commits.length);
  }, [sendAppendRequest]);

  const reloadCommits = useCallback((overrides?: Partial<import('./store/logStore').CommitFilters>) => {
    loadingInFlightRef.current = false;
    const f = { ...useLogStore.getState().commitFilters, ...overrides };
    useLogStore.getState().resetCommits();
    sendAppendRequest(f, 0);
  }, [sendAppendRequest]);

  // Keep reloadRef current so the message handler (mounted once) always calls the latest version
  reloadRef.current = reloadCommits;

  const handleLoadMore = useCallback(() => {
    loadMore();
  }, [loadMore]);

  // When a commit is selected, load its files
  // Commit-file list is now provided by the native TreeView (host side),
  // driven by LOG_SELECT_COMMIT. No webview request needed.

  const repoColors = useMemo(() => {
    const map: Record<string, string> = {};
    store.repos.forEach(r => { map[r.id] = r.color; });
    return map;
  }, [store.repos]);

  const isFiltered = !!(
    store.commitFilters.text ||
    store.commitFilters.author ||
    store.commitFilters.branch ||
    store.commitFilters.dateFrom ||
    store.commitFilters.dateTo
  );

  // Merge stashes into the commit list, filtering by branch if a branch filter is active
  const commitsWithStashes = useMemo(() => {
    const branchFilter = store.commitFilters.branch;
    const visibleStashes = branchFilter
      ? store.stashes.filter(s => s.stashBranch === branchFilter)
      : store.stashes;
    if (visibleStashes.length === 0) return store.commits;
    const merged = [...store.commits, ...visibleStashes];
    merged.sort((a, b) => new Date(b.committerDate).getTime() - new Date(a.committerDate).getTime());
    return merged;
  }, [store.commits, store.stashes, store.commitFilters.branch]);

  // assignLanes is expensive — run it off the render path via useEffect + rAF
  // so scroll events never block the UI thread waiting for layout recalc.
  const [graphLayout, setGraphLayout] = useState<GraphLayout>(() =>
    assignLanes(commitsWithStashes, isFiltered)
  );

  const layoutRafRef = useRef<number | null>(null);
  const pendingCommitsRef = useRef(commitsWithStashes);
  const pendingFilteredRef = useRef(isFiltered);
  pendingCommitsRef.current = commitsWithStashes;
  pendingFilteredRef.current = isFiltered;

  useEffect(() => {
    if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current);
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = null;
      // Skip the recalc when there are no commits yet — the empty graph is meaningless and
      // this avoids one wasted pass during startup (before the first commit batch arrives).
      if (pendingCommitsRef.current.length === 0) return;
      setGraphLayout(assignLanes(pendingCommitsRef.current, pendingFilteredRef.current));
    });
    return () => { if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current); };
  }, [commitsWithStashes, isFiltered, themeVersion]);

  const currentBranchByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => { if (b.isHead && !b.isRemote) map[b.repoId] = b.name; });
    return map;
  }, [store.branches]);

  // Authoritative HEAD hash per repo — from branch metadata, not commit refs.
  // Used to show the HEAD badge on exactly the right commit regardless of ref timing.
  const headHashByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => {
      if (!b.isRemote && b.isHead) {
        if (b.lastCommitHash) map[b.repoId] = b.lastCommitHash;
        else if (b.detachedFullHash) map[b.repoId] = b.detachedFullHash;
      }
    });
    return map;
  }, [store.branches]);

  // text/author are debounced inside DebouncedInput; branch/date/repo fire immediately
  const handleFilterChange = useCallback((key: keyof import('./store/logStore').CommitFilters, value: string) => {
    store.setCommitFilters({ [key]: value });
    if (key === 'text' || key === 'author') {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => reloadCommits({ [key]: value }), 0);
    } else {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      reloadCommits({ [key]: value });
    }
  }, [reloadCommits]);

  const handleRepoChange = useCallback((repoId: string | null) => {
    store.setCommitFilters({ repoId });
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits({ repoId });
  }, [reloadCommits]);
  filterRepoRef.current = (repoId: string | null, branch?: string | null) => {
    const filters: { repoId: string | null; branch?: string } = { repoId };
    if (branch) filters.branch = branch;
    store.setCommitFilters(filters);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(filters);
  };

  const handleClearFilters = useCallback(() => {
    const cleared = { text: '', author: '', branch: '', dateFrom: '', dateTo: '', repoId: null };
    store.setCommitFilters(cleared);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(cleared);
  }, [reloadCommits]);

  const showNoRepo = store.repos.length === 0 && store.initialized;
  const noRepoOverlay = showNoRepo ? (
    <div style={noRepoOverlayStyle}>
      {!store.hasWorkspaceFolder ? (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            You have not yet opened a folder.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '200px' }}>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_OPEN_FOLDER' })}>Open Folder</button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CLONE_REPO' })}>Clone Repository</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.
          </div>
          <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_INIT_REPO' })}>
            Initialize Repository
          </button>
        </>
      )}
    </div>
  ) : null;

  return (
    <div style={{ ...appStyle, position: 'relative' }} onContextMenu={e => e.preventDefault()}>
      {noRepoOverlay}
      {/* Filters bar (contains Fetch All on the right) */}
      <CommitFiltersBar
        filters={store.commitFilters}
        branches={store.branches}
        tags={store.tags}
        repos={store.repos}
        onFilterChange={handleFilterChange}
        onRepoChange={handleRepoChange}
        onClear={handleClearFilters}
        onFetchAll={() => send({ type: 'LOG_FETCH_ALL' })}
        onUndock={(target) => send({ type: 'LOG_UNDOCK', target } as LogToHostMsg)}
      />

      {/* Main layout — graph only; branches + commit files moved to native TreeViews */}
      <div style={{ ...mainLayout, visibility: showNoRepo ? 'hidden' : 'visible' }}>
        {/* Commit list (center) */}
        <CommitList
          layout={graphLayout}
          selectedHash={store.selectedCommit ? `${store.selectedCommit.hash}:${store.selectedCommit.repoId}` : null}
          repoColors={repoColors}
          repos={store.repos}
          currentBranchByRepo={currentBranchByRepo}
          headHashByRepo={headHashByRepo}
          onSelect={(commit) => {
            store.selectCommit(commit);
            // Notify host so the native commit-file tree follows the selection.
            if (commit) {
              send({ type: 'LOG_SELECT_COMMIT', repoId: commit.repoId, hash: commit.hash, parents: commit.parents, isStash: commit.isStash, message: commit.message, shortHash: commit.shortHash });
            }
          }}
          onLoadMore={handleLoadMore}
          hasMore={store.hasMore}
          storeHasMore={store.hasMore}
          loading={store.loadingCommits}
          backgroundLoading={store.backgroundLoading}
          scrollToHash={store.pendingScrollHash}
          onScrolledToHash={() => store.setPendingScrollHash(null)}
          aiEnabled={store.aiEnabled}
          themeVersion={themeVersion}
        />
      </div>
    </div>
  );
}

const noRepoOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 10,
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: '12px', padding: '24px',
  background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
};

const initRepoBtnStyle: React.CSSProperties = {
  background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
  fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: 500,
};

const secondaryBtnStyle: React.CSSProperties = {
  background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
  border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
  fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: 500,
};

const appStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  overflow: 'hidden',
  userSelect: 'none',
};


const mainLayout: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  overflow: 'hidden',
  userSelect: 'none',
};


createRoot(document.getElementById('root')!).render(<App />);
