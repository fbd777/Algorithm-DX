# 本地安装与桌面快捷方式

## 下载入口

- [项目 v0.1.0 源码 ZIP](https://github.com/fbd777/Algorithm-DX/archive/refs/tags/v0.1.0.zip) · [版本发布记录](https://github.com/fbd777/Algorithm-DX/releases)
- [Node.js 官方下载](https://nodejs.org/en/download)：选择 24.x LTS，至少 24.15；Windows 通常选择 x64 MSI 安装程序。

项目 ZIP 需要先解压，不是独立 EXE 安装包。

## Windows 首次使用

1. 安装 Node.js 24.15 或更新版本，安装时保留加入 PATH 的选项。安装后重新打开终端或启动窗口。
2. 下载完整仓库并解压到自己有写权限的固定目录。
3. 双击根目录的 `create-desktop-shortcut.cmd`，在当前用户桌面创建 **Algorithm DX** 快捷方式。
4. 双击桌面快捷方式（首次启动自动创建 `data/algorithm-dx.sqlite` 和名为「我」的本人用户，不预设任何平台账号或登录凭据）。
5. 浏览器打开后，在「账号管理」中绑定自己的账号，再按平台说明配置所需凭据并同步。

运行时保留启动窗口，关闭窗口或按 Ctrl+C 可停止服务。关闭网页不会停止服务。若重复启动提示端口被占用，请使用原窗口中的服务地址，或关闭原服务后重新启动。

创建快捷方式本身不启动服务，不改数据库，也不会添加开机启动。暂未安装 Node.js 时也可以先创建快捷方式。

## 配置与其他启动方式

默认无需创建 `.env`。需要自定义时，将根目录 `.env.example` 复制为 `.env`，修改数据库路径和端口。含空格的值用双引号；凭据只填自己的，不随仓库发布。

```text
ALGORITHM_DX_DB_PATH="data/my practice.sqlite"
ALGORITHM_DX_DASHBOARD_PORT=8900
```

`npm start` 和桌面入口始终从项目根目录读取配置，相对数据库路径也相对于项目根目录。优先级为命令行 > 系统环境变量 > `.env` > 默认值。

```powershell
npm start -- --port 8900 --open
npm start -- --db "data/another.sqlite" --init-only
```

`--init-only` 只在数据库不存在时建库，不启动服务；已有数据库不修改。普通 `npm run dashboard` 保留原有入口，要求数据库已存在。

## 更新、移动和多份项目

旧版配置升级：先关闭旧 Dashboard 和同步进程，在项目根目录执行 `npm run config:migrate`，再启动新版。该命令将 `.env` 中的旧 `ALGO_*` 键名迁移为 `ALGORITHM_DX_*`，原文件备份留在已被 Git 忽略的 `.env.brand-*.backup`。凭据值和已有数据库路径保持不变；未显式配置路径但检测到旧默认数据库时，会自动写入指向旧文件的新版变量，避免创建空库。新安装默认使用 `data/algorithm-dx.sqlite`。新旧同名配置同时存在时会报错，不擅自选择。系统环境变量请自行改用新前缀，运行时不再兼容旧前缀。

更新代码时保留 `.env`、`data/` 和自己指定的数据文件。先停止旧服务；需要升级数据库时，先运行 `npm run backup`，再运行 `npm run db:init`，最后重新启动。启动入口不会自动覆盖或迁移已有数据库。

移动项目后，删除旧的桌面快捷方式，再从新目录创建。相对数据库路径随项目移动；自定义绝对路径需自行检查。桌面同名快捷方式若指向另一目录，工具会拒绝覆盖。

保留多份安装时可以指定不同名称，同时运行还需为每份配置不同端口：

```powershell
npm run desktop:shortcut -- -ShortcutName "Algorithm DX Test"
```

删除快捷方式不会删除项目或练习数据。

## macOS / Linux

安装 Node.js 24.15+，执行 `npm start`，按终端显示的地址打开浏览器。有桌面环境可用 `npm start -- --open`。`.cmd` 和快捷方式生成器仅适用于 Windows。

## 常见问题

- 找不到 Node.js：安装所需版本，并确认 `node --version` 能运行。
- 桌面创建失败：检查桌面目录是否可写、重定向桌面是否可访问；也可直接双击 `dashboard.cmd`。
- 浏览器未打开：保留服务窗口，手动访问窗口中显示的地址。
- 数据库版本不匹配：按更新步骤备份并迁移，不要删除旧库。
- 同步需要浏览器扩展或登录态：按帮助页及平台说明配置；快捷方式不会带入作者的账号或凭据。
