生产环境部署文档
1. 环境准备
在 Ubuntu / Debian 服务器上执行以下初始化命令：

Bash
# 1. 更新系统包
sudo apt update && sudo apt upgrade -y

# 2. 安装 Node.js (LTS v20) 及 Nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 3. 安装全局进程管理器 PM2
sudo npm install pm2 -g

# 4. 安装 SSL 证书工具 Certbot
sudo apt install certbot python3-certbot-nginx -y
2. 后端服务部署 (PM2)
将 backend 文件夹上传至服务器（例如 /var/www/rtc-project/backend）。

Bash
# 进入后端目录
cd /var/www/rtc-project/backend

# 安装生产依赖
npm install --production

# 使用 PM2 启动服务并设置开机自启
pm2 start server.js --name "rtc-backend"
pm2 save
pm2 startup
3. 前端静态文件配置
将 frontend 文件夹中的 index.html 和 client.js 上传至服务器的静态目录（例如 /var/www/rtc-project/frontend）。

前端会自动使用当前页面的域名连接 `/socket.io/`，无需手动修改 `client.js`。例如页面为 `https://aaa.com/shareFiles` 时，信令连接会自动使用 `https://aaa.com`。

4. Nginx 反向代理与 HTTPS 配置
WebRTC 强制要求安全上下文（HTTPS）。创建或修改 Nginx 配置文件 /etc/nginx/sites-available/rtc-project：

Nginx
server {
    listen 80;
    server_name yourdomain.com; # 替换为你的域名
    return 301 https://$host$request_uri; # 强制 HTTP 跳转 HTTPS
}

server {
    listen 443 ssl;
    server_name yourdomain.com; # 替换为你的域名

    # 静态前端页面托管
    location / {
        root /var/www/rtc-project/frontend;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 后端 WebSocket 信令服务反向代理
    location /socket.io/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        
        # 维持 WebSocket 长连接所需请求头
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 传递真实 IP 用于局域网匹配
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
启用配置并检查 Nginx 语法：

Bash
sudo ln -s /etc/nginx/sites-available/rtc-project /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
5. 申请 SSL 证书 (Let's Encrypt)
通过 Certbot 自动化配置 Nginx 的 SSL 证书：

Bash
sudo certbot --nginx -d yourdomain.com
根据提示输入邮箱并同意协议，Certbot 会自动修改 Nginx 配置并加载证书。完成后，双端即可通过 [https://yourdomain.com](https://yourdomain.com) 建立安全的 P2P 局域网连接。
