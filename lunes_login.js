const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

// ==================== 配置区域 ====================
const CONFIG = {
    name: 'LunesHost',
    baseUrl: 'https://betadash.lunes.host',
    loginPath: '/login?next=/',
    logoutPath: '/logout',
    
    selectors: {
        emailInput: 'input#email, input[name="email"], input[type="email"]',
        passwordInput: 'input#password, input[name="password"], input[type="password"]',
        loginButton: 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
        serverCard: 'a.server-card',
    },
    
    checkLoginSuccess: (url) => !url.includes('/login') && !url.includes('/error'),
    checkLoginError: (url) => url.includes('/login') && url.includes('error'),
};

// ==================== 企业微信配置 ====================
const WECHAT_KEY = process.env.WECHAT_KEY;
const WECHAT_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook';

// ==================== 调试输出 ====================
console.log('========== 环境变量调试 ==========');
console.log('WECHAT_KEY:', WECHAT_KEY ? '已设置' : '未设置');
console.log('USERS_JSON:', process.env.USERS_JSON ? '已设置' : '未设置');
console.log('===================================');

// 临时目录
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 隐藏邮箱敏感信息
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';
    const [name, domain] = email.split('@');
    if (name.length <= 3) return `***@${domain}`;
    return `${name.slice(0, 3)}***@${domain}`;
}

// 生成安全文件名
function getSafeUsername(username) {
    const masked = maskEmail(username);
    return masked.replace(/[^a-z0-9]/gi, '_');
}

// 截图（PNG格式）
async function captureScreenshot(page, filename) {
    const filepath = path.join(TEMP_DIR, filename);
    try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.screenshot({ 
            path: filepath,
            type: 'png',
            fullPage: false
        });
        
        const stats = fs.statSync(filepath);
        console.log(`📸 截图已保存: ${filename} (${(stats.size/1024).toFixed(2)}KB)`);
        return filepath;
    } catch (e) {
        console.error('截图失败:', e.message);
        return null;
    }
}

// 发送企业微信图片（使用 base64 + md5）
async function sendWechatImage(imagePath) {
    if (!WECHAT_KEY) {
        console.log('[企业微信] 未配置 WECHAT_KEY');
        return false;
    }

    if (!fs.existsSync(imagePath)) {
        console.log(`[企业微信] 文件不存在: ${imagePath}`);
        return false;
    }

    try {
        const imageData = fs.readFileSync(imagePath);
        const imageBase64 = imageData.toString('base64');
        const imageMd5 = crypto.createHash('md5').update(imageData).digest('hex');

        console.log(`[企业微信] 准备发送图片: ${path.basename(imagePath)}`);

        const url = `${WECHAT_WEBHOOK_BASE}/send?key=${WECHAT_KEY}`;
        
        const payload = {
            msgtype: 'image',
            image: {
                base64: imageBase64,
                md5: imageMd5
            }
        };

        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            maxBodyLength: 50 * 1024 * 1024,
            maxContentLength: 50 * 1024 * 1024
        });

        if (response.data && response.data.errcode === 0) {
            console.log('[企业微信] 图片发送成功');
            return true;
        } else {
            console.error('[企业微信] 图片发送失败:', response.data.errmsg);
            return false;
        }
    } catch (e) {
        console.error('[企业微信] 图片发送失败:', e.message);
        return false;
    }
}

// 发送企业微信文本消息
async function sendWechatText(text) {
    if (!WECHAT_KEY) {
        console.log('[企业微信] 未配置 WECHAT_KEY');
        return false;
    }

    try {
        const url = `${WECHAT_WEBHOOK_BASE}/send?key=${WECHAT_KEY}`;
        const payload = {
            msgtype: 'text',
            text: { content: text }
        };

        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        if (response.data && response.data.errcode === 0) {
            console.log('[企业微信] 文本消息已发送');
            return true;
        } else {
            console.error('[企业微信] 文本发送失败:', response.data.errmsg);
            return false;
        }
    } catch (e) {
        console.error('[企业微信] 文本发送失败:', e.message);
        return false;
    }
}

// 清理临时文件
function cleanupTempFiles() {
    try {
        if (fs.existsSync(TEMP_DIR)) {
            const files = fs.readdirSync(TEMP_DIR);
            for (const file of files) {
                fs.unlinkSync(path.join(TEMP_DIR, file));
            }
            console.log('[清理] 临时文件已清除');
        }
    } catch (e) {
        console.error('[清理] 失败:', e.message);
    }
}

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 配置: ${PROXY_CONFIG.server}`);
    } catch (e) {
        console.error('[代理] 格式无效');
        process.exit(1);
    }
}

// 注入脚本用于绕过 CF 检测
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    let screenX = getRandomInt(800, 1200);
    let screenY = getRandomInt(400, 600);
    try {
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio, found: true };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }
    console.log('启动 Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 错误:', e);
    }
    return [];
}

// 处理 Turnstile 人机认证
async function handleTurnstile(page, contextName = '未知') {
    console.log(`[${contextName}] 检查 Turnstile...`);
    const frames = page.frames();
    const turnstileFrame = frames.find(f => 
        f.url().includes('turnstile') || 
        f.url().includes('cloudflare') ||
        f.url().includes('challenges')
    );
    
    if (!turnstileFrame) {
        console.log(`[${contextName}] 未发现 Turnstile`);
        return { success: false, reason: 'not_found' };
    }
    
    console.log(`[${contextName}] 发现 Turnstile，尝试验证...`);
    
    try {
        await page.waitForTimeout(2000);
        
        const turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
        
        if (turnstileData && turnstileData.found) {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            
            if (box) {
                const clickX = box.x + (box.width * turnstileData.xRatio);
                const clickY = box.y + (box.height * turnstileData.yRatio);
                
                console.log(`[${contextName}] 精确点击: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await client.detach();
            }
        } else {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            
            if (box) {
                console.log(`[${contextName}] 点击 iframe 中心`);
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        
        await page.waitForTimeout(3000);
        
        for (let i = 0; i < 10; i++) {
            const isVerified = await turnstileFrame.evaluate(() => {
                const checkbox = document.querySelector('input[type="checkbox"]');
                return checkbox ? checkbox.checked : false;
            }).catch(() => false);
            
            if (isVerified) {
                console.log(`[${contextName}] Turnstile 验证成功`);
                return { success: true };
            }
            
            await page.waitForTimeout(500);
        }
        
        return { success: false, reason: 'timeout' };
        
    } catch (e) {
        console.error(`[${contextName}] Turnstile 错误:`, e.message);
        return { success: false, reason: 'error', error: e.message };
    }
}

// 获取服务器详情信息
async function getServerInsights(page) {
    try {
        await page.waitForSelector('text="Server Insights"', { timeout: 10000 });
        
        const info = await page.evaluate(() => {
            const data = {};
            
            const rows = document.querySelectorAll('div, tr, li');
            rows.forEach(row => {
                const text = row.innerText || '';
                
                if (text.includes('Identifier')) {
                    const match = text.match(/Identifier\s+([a-f0-9]+)/i);
                    if (match) data.identifier = match[1];
                }
                
                if (text.includes('Node')) {
                    const match = text.match(/Node\s+#?(\d+)/i);
                    if (match) data.node = match[1];
                }
                
                if (text.includes('Memory') && !text.includes('Server')) {
                    const match = text.match(/Memory\s+(\d+\s*MB)/i);
                    if (match) data.memory = match[1];
                }
                
                if (text.includes('Disk')) {
                    const match = text.match(/Disk\s+(\d+\s*MB)/i);
                    if (match) data.disk = match[1];
                }
                
                if (text.includes('CPU')) {
                    const match = text.match(/CPU\s+(\d+%)/i);
                    if (match) data.cpu = match[1];
                }
            });
            
            if (Object.keys(data).length === 0) {
                const allText = document.body.innerText;
                const identifierMatch = allText.match(/Identifier\s+([a-f0-9]{8})/i);
                const nodeMatch = allText.match(/Node\s+#?(\d+)/i);
                const memoryMatch = allText.match(/Memory\s+(\d+\s*MB)/i);
                const diskMatch = allText.match(/Disk\s+(\d+\s*MB)/i);
                const cpuMatch = allText.match(/CPU\s+(\d+%)/i);
                
                if (identifierMatch) data.identifier = identifierMatch[1];
                if (nodeMatch) data.node = nodeMatch[1];
                if (memoryMatch) data.memory = memoryMatch[1];
                if (diskMatch) data.disk = diskMatch[1];
                if (cpuMatch) data.cpu = cpuMatch[1];
            }
            
            return data;
        });
        
        console.log('获取到服务器信息:', info);
        return info;
        
    } catch (e) {
        console.error('获取服务器信息失败:', e.message);
        return {};
    }
}

// 主程序
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error('未找到用户，请检查 USERS_JSON 环境变量');
        process.exit(1);
    }

    if (PROXY_CONFIG && !(await checkProxy())) {
        console.error('[代理] 连接失败');
        process.exit(1);
    }

    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    if (!browser) {
        console.error('连接 Chrome 失败');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    }

    await page.addInitScript(INJECTED_SCRIPT);

    // 处理每个用户
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const maskedUser = maskEmail(user.username);
        const safeUser = getSafeUsername(user.username);
        
        console.log(`\n=== ${CONFIG.name} - 用户 ${i + 1}/${users.length}: ${maskedUser} ===`);
        
        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 先登出
            if (CONFIG.logoutPath) {
                await page.goto(`${CONFIG.baseUrl}${CONFIG.logoutPath}`).catch(() => {});
                await page.waitForTimeout(2000);
            }

            // 进入登录页
            console.log('导航到登录页...');
            const loginUrl = `${CONFIG.baseUrl}${CONFIG.loginPath}`;
            await page.goto(loginUrl);
            await page.waitForTimeout(2000);

            // 处理登录页 Turnstile
            await handleTurnstile(page, '登录页');
            
            // 输入凭据
            console.log('输入登录信息...');
            
            await page.waitForSelector(CONFIG.selectors.emailInput, { timeout: 10000 });
            await page.fill(CONFIG.selectors.emailInput, user.username);
            
            await page.waitForSelector(CONFIG.selectors.passwordInput, { timeout: 10000 });
            await page.fill(CONFIG.selectors.passwordInput, user.password);
            
            await page.waitForTimeout(500);

            // 再次检查 Turnstile
            await handleTurnstile(page, '登录前');
            
            // 点击登录按钮
            console.log('点击登录...');
            await page.click(CONFIG.selectors.loginButton);
            await page.waitForTimeout(4000);

            // 检查登录结果
            if (CONFIG.checkLoginError(page.url())) {
                let failReason = '未知错误';
                try {
                    const errorText = await page.locator('text=/incorrect|invalid|error|failed/i').first().innerText({ timeout: 2000 });
                    if (errorText) failReason = errorText;
                } catch (e) {}
                
                const msg = `❌ ${CONFIG.name} 登录失败\n用户: ${maskedUser}\n原因: ${failReason}`;
                console.log(msg);
                await sendWechatText(msg);
                continue;
            }

            console.log('✅ 登录成功');
            
            // 等待服务器列表加载
            await page.waitForTimeout(3000);
            
            // 截图1：服务器列表页
            console.log('截图1：服务器列表...');
            const screenshot1Path = await captureScreenshot(page, `${safeUser}_01_list.png`);
            if (screenshot1Path) {
                await sendWechatImage(screenshot1Path);
            }
            
            // 查找并点击第一个服务器卡片
            console.log('查找第一个服务器卡片...');
            let serverClicked = false;
            
            try {
                await page.waitForSelector(CONFIG.selectors.serverCard, { timeout: 10000 });
                const serverCards = await page.locator(CONFIG.selectors.serverCard).all();
                console.log(`找到 ${serverCards.length} 个服务器卡片`);
                
                if (serverCards.length > 0) {
                    await serverCards[0].scrollIntoViewIfNeeded();
                    await page.waitForTimeout(500);
                    await serverCards[0].click();
                    console.log('已点击第一个服务器卡片');
                    serverClicked = true;
                }
                
            } catch (e) {
                console.error('点击服务器失败:', e.message);
            }
            
            if (serverClicked) {
                // 等待详情页加载
                await page.waitForTimeout(3000);
                await page.waitForURL('**/servers/**', { timeout: 10000 });
                console.log('当前URL:', page.url());
                
                // 截图2：服务器详情页
                console.log('截图2：服务器详情...');
                const screenshot2Path = await captureScreenshot(page, `${safeUser}_02_detail.png`);
                if (screenshot2Path) {
                    await sendWechatImage(screenshot2Path);
                }
                
                // 获取 Server Insights 信息
                console.log('获取服务器信息...');
                const serverInfo = await getServerInsights(page);
                
                // 发送服务器信息
                const infoText = `服务器信息
用户: ${maskedUser}
Identifier: ${serverInfo.identifier || 'N/A'}
Node: ${serverInfo.node ? '#' + serverInfo.node : 'N/A'}
Memory: ${serverInfo.memory || 'N/A'}
Disk: ${serverInfo.disk || 'N/A'}
CPU: ${serverInfo.cpu || 'N/A'}`;
                
                await sendWechatText(infoText);
                
            } else {
                console.log('未找到可点击的服务器卡片');
                await sendWechatText('⚠️ 未找到服务器卡片');
            }

        } catch (err) {
            console.error(`处理出错:`, err);
            const errorMsg = `❌ ${CONFIG.name} 处理出错\n用户: ${maskedUser}\n错误: ${err.message}`;
            await sendWechatText(errorMsg);
        }
        
        console.log(`用户 ${maskedUser} 处理完成`);
        console.log('---');
        
        // 用户之间等待
        if (i < users.length - 1) {
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log('\n所有用户处理完成');
    
    // 清理临时文件
    cleanupTempFiles();
    
    try { await browser.close(); } catch (e) {}
    process.exit(0);
})();
