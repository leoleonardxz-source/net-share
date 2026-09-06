LAN Web P2P File Transfer System
这是一个基于 WebRTC P2P 和 HTML5 Streams API 实现的局域网免安装大文件文件传输系统。通过云端信令服务器匹配同出口 IP 的设备，强制注入真实内网 IP 绕过 mDNS 限制，并利用流式读写解决浏览器传输超大文件（20GB+）时的内存溢出（OOM）问题。

核心特性
零服务器流量：云端仅做信令打洞交换，文件数据完全在局域网内点对点传输。

突破 mDNS 限制：本地提取真实 192.168.x.x 内网 IP 并重写 SDP，大幅提升局域网内打洞成功率。

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
[设备 A (局域网 IP: 192.168.1.5)] ── WebSocket ──> [云端信令 (识别出口公网 IP: 123.x.x.x)]
                                                              │
                                                        自动归入同网房间
                                                              │
[设备 B (局域网 IP: 192.168.1.8)] ── WebSocket ──> <──────────┘
传输管线 (防 OOM 架构)
[发送端文件] ──> File.stream() ──> 分块读取 (16KB) ──> WebRTC DataChannel
                                                             │
                                                             ▼
[接收端硬盘] <── WritableStream <── 边收边落盘 ──────────────┘
注意：若局域网内存在强防火墙策略彻底封死 UDP 高位端口，WebRTC 将触发 failed 状态，系统将在控制台抛出降级提示。