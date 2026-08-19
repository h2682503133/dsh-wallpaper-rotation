# dsh-wallpaper-rotation

[![npm](https://img.shields.io/npm/v/dsh-wallpaper-rotation)](https://www.npmjs.com/package/dsh-wallpaper-rotation)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness WebUI 壁纸轮换插件：**多张本地图片定时轮换** + **亮/暗主题各一组壁纸**，纯官方插件机制实现，零核心代码改动。

- **npm**: https://www.npmjs.com/package/dsh-wallpaper-rotation
- **GitHub**: https://github.com/h2682503133/dsh-wallpaper-rotation

- 定时轮换：默认每 5 分钟换一张，间隔可在设置里调整
- 主题分组：`light/`、`dark/` 子目录分别对应亮色/暗色主题，根目录文件为两主题通用；切换主题立即换组
- 半透明表面：侧边栏/对话区表面自动变得半透明透出壁纸，透明度可调
- 两图层交叉淡入淡出切换，不闪烁
- 设置实时生效、自动持久化（跟随 DSH settings 服务）
- 壁纸开关：关闭后完全恢复默认纯色界面

## 安装

```sh
dsh plugin --profile web add dsh-wallpaper-rotation
```

或从本地目录安装：

```sh
dsh plugin --profile web add D:/path/to/dsh-wallpaper-rotation
```

重启 DSH 后生效。

## 壁纸文件夹结构

配置里的「壁纸文件夹」按以下规则扫描：

```
wallpapers/
├── light/          # 亮色主题壁纸（任意图片格式）
│   ├── a.jpg
│   └── b.png
├── dark/           # 暗色主题壁纸
│   ├── c.jpg
│   └── d.webp
└── e.jpg           # 根目录 = 两主题通用
```

支持的格式：JPG / PNG / WebP / GIF / BMP / AVIF。

## 使用

1. 重启 DSH 后打开 WebUI
2. 进入 **设置 → 插件** 找到「壁纸轮换」卡片
3. 填写壁纸文件夹路径（回车保存），按需调整轮换间隔、壁纸不透明度、侧边栏/对话区表面透明度
4. 点击「重新扫描文件夹」立即应用

切换亮/暗主题时壁纸组即时切换。

## 卸载

```sh
dsh plugin --profile web remove dsh-wallpaper-rotation
```

重启后界面完全恢复默认（壁纸层与表面 token 覆写全部回收）。

## 工作原理

| 部分 | 机制 |
|---|---|
| 壁纸层 | 自建 fixed 图层，插入应用 frame 首位（`[data-shell-overlay]` 锚点），位于内容之下 |
| 半透明表面 | 读取 `body` 上当前主题的 `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill` 原值，覆写为 `color-mix(..., transparent)`；主题切换时先还原再重读重算 |
| 轮换 | 定时器 + 双图层 opacity 交叉淡入淡出，切换前预加载图片 |
| 主题分组 | `MutationObserver` 监听 `body[data-ds-dark-theme]` |
| 设置 | `settings.plugin.item` 槽位卡片 + host 配置端点（回环 + 同源校验） |

## 安全边界

- 所有路由仅接受回环连接；配置写操作还需同源 `Origin`
- 图片路径校验防目录穿越，仅限配置文件夹内文件
- 不读取、不上传任何外部内容

## License

MIT
