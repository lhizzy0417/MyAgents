# MyAgents Morandi Green

这个目录是给 MyAgents 做“可持续莫兰迪绿”的小工具箱。

## 解决什么问题

上游 MyAgents 更新后，直接安装新版本会把自定义颜色覆盖掉。

这里的思路不是“以后手工再改一次”，而是：

1. 你的 GitHub 仓库跟进官方更新
2. 自动重新套 Morandi 主题
3. 自动补齐打包前置项
4. 自动生成新的绿色版本线
5. 本机按钮只负责安装你自己的绿色最新版

## 文件

- `apply-theme.mjs`
  - 负责把主题变量和几个明显的暖橘强调色改成莫兰迪绿
- `prepare-build.sh`
  - 在套主题之外，顺手补齐构建要用到的 `cuse` 和 `mino`
- `升级后套用莫兰迪绿.command`
  - 双击就能开始的一键入口
- `MyAgents莫兰迪绿补丁.app`
  - 更像按钮的应用入口，双击后会自动唤起上面的脚本

## 以后升级怎么做

以后不需要你自己找源码目录，也不用手动放文件。

直接双击：

`/Users/hanako/Documents/New project 2/MyAgents-green/scripts/myagents-morandi/MyAgents莫兰迪绿补丁.app`

它会自动：

1. 在固定目录 `/private/tmp/MyAgents-green-fork` 下载或更新你的绿色仓库
2. 自动构建绿色版 App
3. 自动替换 `/Applications/MyAgents.app`

这条线默认使用你的仓库：

`https://github.com/lhizzy0417/MyAgents`

只要这个仓库已经同步了新的绿色版本，本机按钮就不需要再追官方仓库内部结构。

如果打包过程只出现签名相关提示，但本地 App 已经生成，脚本仍会继续安装。
如果窗口看起来停住了，优先看桌面日志最后几行；只要出现“安装完成”，就说明已经换好了。

## 日志

安装日志会放到桌面：

`~/Desktop/MyAgents-莫兰迪绿-安装日志.txt`

## 注意

- 这是“你的绿色版本线”，不是官方内置主题。
- 上游如果以后大改前端结构，自动同步脚本可能还是要小修一次。
- 但相比每次本机重新追官方构建细节，这已经稳很多了。
- 脚本会先把旧版应用备份为 `/Applications/MyAgents.app.backup-before-morandi`
- 想省心就直接双击 `MyAgents莫兰迪绿补丁.app`
