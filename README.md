LAN Web P2P File Transfer System
这是一个基于 WebRTC P2P 和 HTML5 Streams API 实现的局域网免安装文件传输系统。公网服务仅按出口 IP 发现同一局域网中的设备并转发 WebRTC 信令；文字和文件始终在设备间直接传输。若无法建立局域网直连，便不能聊天或传输文件。

核心特性
零服务器流量：云端仅做信令打洞交换，文件数据完全在局域网内点对点传输。

仅局域网直连：不配置 TURN 中继，不通过服务器转发任何文件或聊天内容。

流式无上限传输：基于 HTML5 Streams API 与 File System Access API，数据边收边落盘，内存占用固定。

目录结构
Plaintext
.
├── backend                 # Node.js 信令服务器
│   ├── package.json
│   └── server.js
└── frontend                # 前端静态网页
    ├── index.html
    └── client.js
快速开始
1. 后端信令服务器部署
进入 backend 目录，安装依赖并启动服务：

Bash
cd backend
npm install
node server.js
默认在 http://localhost:3000 监听。生产环境建议使用 Nginx 反向代理并配置 HTTPS。

2. 前端部署与运行
前端为纯静态页面。由于 WebRTC 强制安全上下文要求，本地开发或部署必须满足以下条件之一：

本地测试：直接通过 http://localhost 或 [http://127.0.0.1](http://127.0.0.1) 访问。

跨设备测试：必须配置 HTTPS 证书，否则浏览器将禁用 RTCPeerConnection 和 showSaveFilePicker API。

将 frontend 目录托管至任意静态 Web 服务器（如 Nginx、Caddy 或 VSCode Live Server），配置 client.js 中的服务器连接地址即可。

技术实现逻辑
局域网配对机制
[设备 A] ── WebSocket ──> [云端信令 (识别出口公网 IP: 123.x.x.x)]
                                                              │
                                                        自动归入同网房间
                                                              │
[设备 B] ── WebSocket ──> <──────────┘
传输管线 (防 OOM 架构)
[发送端文件] ──> File.stream() ──> 分块读取 (16KB) ──> WebRTC DataChannel
                                                             │
                                                             ▼
[接收端硬盘] <── WritableStream <── 边收边落盘 ──────────────┘
注意：若局域网内的防火墙策略阻止 WebRTC 直连，连接会失败；本项目不会降级到服务器中继。
