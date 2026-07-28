# Git Suite 原生化改造实验记录

> 记录于回退前(commit `bc57d72` 之后到 `HEAD` 的全部实验)。本次实验结论:**放弃纯原生方向,回归 webview**。本文档留存以备后查。

## 背景

Git Suite 原有两个核心 webview:`gitsuite.commitPanel`(提交面板)和 `gitsuite.gitLog`(日志面板)。实验目标是把它们尽可能改成 VS Code 原生 UI(TreeView / SourceControl),减少自绘、获得原生体验。

## 需求与方案演进

### 阶段一:Git Log 混合改造(已完成,后回退)
- **需求**:Git Log 的分支侧栏、提交文件树迁原生,保留 graph webview
- **方案**:
  - 分支/Tag → 原生 TreeView(活动栏容器 `gitsuite-log-sidebar`)
  - 提交文件树 → 原生 TreeView(底部 panel,`gitsuite.commitFileTree`)
  - 状态共享:host 端 `LogUiState` + `LOG_SELECT_COMMIT` 消息驱动文件树
  - FileDecorationProvider 给文件上 git 状态色(自定义 scheme `gitsuite-log-file://`)
- **效果**:graph webview 瘦身,侧栏/文件树原生化,功能正常

### 阶段二:Commit 部分原生化(已完成,后回退)
- **需求**:Stash / Worktrees 迁原生 TreeView
- **方案**:`gitsuite.stash` / `gitsuite.worktrees` 原生视图 + 右键菜单(pop/apply/drop、open/lock/remove)
- **反复**:先迁原生 → 用户觉得多视图凌乱 → 加回 webview tab → 最终确认 webview 内自绘非原生 → 又改回纯原生删 webview tab

### 阶段三:统一 Navigator 视图(已完成,后回退)
- **需求**:三个分散视图(Branches/Stash/Worktrees)合并成一个 Navigator,借鉴 extensions-bookmark 的 grouping/过滤/排序
- **方案**:
  - 单 `gitsuite.navigator` TreeView,默认按 repo 分组(repo → Branches/Tags/Stashes/Worktrees → 条目)
  - view title Group By 子菜单切换 byRepo/byType/flat(纯内存,不持久化)
  - Filter Repositories(QuickPick 多选)
  - **inline hover 按钮**(`view/item/context` 的 `group: inline`):分支 checkout、stash pop/apply/drop、worktree open/remove
  - repo 行 eye 按钮:激活 → 同步 Git Log + 打开 SCM 视图
  - 分支排序:primary(main/master)最前 → HEAD → local/remote → 字母;HEAD 分支绿色 icon + 实心圆标记

### 阶段四:Commit Changes 改 SourceControl(已完成,后回退)
- **需求**:Commit 面板也原生,Changes 用 VS Code 原生 SCM
- **方案**:
  - per-repo `vscode.scm.createSourceControl`(每 repo 一个 SourceControl,Staged/Changes 分组)
  - commit 走 inputBox 的 `acceptInputCommand`(✓ 按钮提交)
  - stage/unstage/discard 命令 + `scm/resourceState/context`、`scm/resourceGroup/context` 菜单
  - Amend / Commit&Push / AI 生成 message 挂 `scm/title` 和 `scm/repository`
- **接受的功能损失**:changelists、simplified 勾选、勾选持久化、多仓一次性 commit pill、UnifiedCommitForm 分裂下拉、AI 表单按钮、路径压缩、hover 多按钮——全删或降级为命令

## 遇到的 VS Code 平台限制(决定性)

这些限制是放弃纯原生的根本原因:

1. **webview 无法嵌入原生组件**——webview 内的元素全是自绘(右键菜单、列表行、hover 按钮都拿不到原生)。要原生交互就必须用原生 TreeView/SCM,不能放 webview 里。

2. **原生 TreeView 没有 textarea**——commit message 输入在原生 TreeView 里无解,只能引入 SourceControl 用 inputBox(或弹 InputBox,体验差)。

3. **自建 SourceControl 与内置 git 冲突**——同 repo 会有两套变更视图(inputBox/badge 双计)。实测可接受,但本质是重复。

4. **SCM repository 展开后只能显示 resource groups(文件)**——无法在里面放分支树/任意自定义内容。repository 展开看分支做不到。

5. **SCM API 不暴露"当前选中 repository"**——没有 active/selected/focused 状态,没有事件,没有持久 context key。`scmProvider` context key 仅菜单项触发时瞬时注入,代码读不到。

6. **SCM 是"所有 repo 并列"模型,无"切换"**——每个 SourceControl 独立常驻,不存在"选中一个、列表切到它"。多仓一次性 commit 在 SCM 模型下不自然。

7. **原生 TreeView 无 per-row hover 多按钮**——只有 `group: inline` 的单排骨序 icon 按钮(Navigator 用了这个),无法复刻 webview 的自定义 hover 按钮组。

8. **原生 TreeView 无"互斥展开"(手风琴)**——展开一个 repo 自动折叠其他做不到,只能用 eye 激活近似。

9. **VS Code 视图展开/折叠状态由 VS Code 记忆**——`visibility: collapsed` 只对首次安装生效,无法每次启动强制折叠。

10. **原生 SCM commit 按钮无分裂下拉/Amend checkbox/AI overlay**——`acceptInputCommand` 只能挂一个命令,富表单功能只能降级为菜单/命令。

## 最终决策

**放弃纯原生,回归 webview。** 原因:
- JetBrains 风格的富交互(changelists、多仓 pill、分裂下拉、AI、hover 多按钮、路径压缩)是产品核心卖点,原生 SCM/TreeView 表达力不足,强行原生化=大幅砍功能。
- webview 虽然是自绘,但能精确实现 JetBrains 体验,且字体/主题/icon 已通过 CSS 变量 + codicon 做到原生一致性。
- 原生化的收益(键盘导航/原生右键)不抵功能损失。

main 分支 reset 回 `bc57d72`(pujie.git-suite v0.9.2 发布点),从头再来。所有原生实验代码已 push 到备份分支归档。

## 可保留的设计经验(供 webview 重做参考)

- **inline hover 按钮** 的交互模式(Navigator 验证过)可借鉴到 webview
- **分组/过滤/排序** 的 UI 组织(借鉴 extensions-bookmark)
- **状态色** 用 `gitDecoration.*` ThemeColor / CSS 变量
- **per-row action** 在 webview 里比原生更灵活(可自定义位置/样式)
- **AI 生成 message** 的 prompt 与 diff 收集逻辑(`src/host/ai/generateCommitMessage.ts`,已抽共享)
