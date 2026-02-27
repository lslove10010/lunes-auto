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

// 截图为 PNG（Python 代码用的 PNG）
async function captureScreenshot(page, filename) {
    const filepath = path.join(TEMP_DIR, filename);
    try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.screenshot({ 
            path: filepath,
            type: 'png',
            fullPage: true  // Python 代码用的 full_page=True
        });
        
        const stats = fs.statSync(filepath);
        console.log(`📸 截图已保存: ${filename} (${(stats.size/1024).toFixed(2)}KB)`);
        return filepath;
    } catch (e) {
        console.error('截图失败:', e.message);
        return null;
    }
}

// 发送企业微信图片（使用 base64 + md5，参考 Python 代码）
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
        // 读取文件并计算 base64 和 md5
        const imageData = fs.readFileSync(imagePath);
        const imageBase64 = imageData.toString('base64');
        const imageMd5 = crypto.createHash('md5').update(imageData).digest('hex');

        console.log(`[企业微信] 准备发送图片: ${path.basename(imagePath)}`);
        console.log(`[企业微信] 图片大小: ${(imageData.length/1024).toFixed(2)}KB`);
        console.log(`[企业微信] MD5: ${imageMd5}`);

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

        console.log('[企业微信] 响应:', response.data);

        if (response.data && response.data.errcode === 0) {
            console.log('[企业微信] 图片发送成功');
            return true;
        } else {
            console.error('[企业微信] 图片发送失败:', response.data.errmsg);
            return false;
        }
    } catch (e) {
        console.error('[企业微信] 图片发送失败:', e.message);
        if (e.response) {
            console.error('[企业微信] 错误响应:', e.response.data);
        }
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
            text: { 
                content: text,
                mentioned_list: [],
                mentioned_mobile_list: []
            }
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
        '--window-size=1920,1080',
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

// 获取服务器详情信息（参考 Python 代码）
async function getServerStats(page) {
    const stats = {};
    
    try {
        // 等待 Uptime 出现
        await page.waitForSelector("text=Uptime", { state: 'visible', timeout: 20000 });
        console.log("找到 'Uptime' 元素，页面已加载");
        
        // 提取 Address
        try {
            const addressText = await page.locator("text=node22.lunes.host, text=Address").innerText({ timeout: 5000 });
            if (addressText) {
                stats.address = addressText.trim();
                console.log(`提取到 address: ${stats.address}`);
            }
        } catch (e) {
            // 忽略
        }
        
        // 卡片提取
        const cards = await page.locator("div.grid > div, div[class*='card'], div[class*='stat'], div[class*='bg-'], section, article").all();
        console.log(`找到 ${cards.length} 个潜在统计卡片`);
        
        for (const card of cards) {
            try {
                const text = await card.innerText();
                if (!text) continue;
                
                const lowerText = text.toLowerCase();
                
                if (lowerText.includes("uptime")) {
                    stats.uptime = text.replace(/uptime/i, "").replace(":", "").trim();
                } else if (lowerText.includes("cpu load") || (lowerText.includes("cpu") && lowerText.includes("load"))) {
                    stats.cpu_load = text.replace(/cpu load/i, "").replace(":", "").trim();
                } else if (lowerText.includes("memory") && !lowerText.includes("network")) {
                    stats.memory = text.replace(/memory/i, "").replace(":", "").trim();
                } else if (lowerText.includes("disk")) {
                    stats.disk = text.replace(/disk/i, "").replace(":", "").trim();
                } else if (lowerText.includes("inbound") || lowerText.includes("network (inbound)")) {
                    stats.network_in = text.replace(/network \(inbound\)/i, "").replace(/inbound/i, "").replace(":", "").trim();
                } else if (lowerText.includes("outbound") || lowerText.includes("network (outbound)")) {
                    stats.network_out = text.replace(/network \(outbound\)/i, "").replace(/outbound/i, "").replace(":", "").trim();
                }
            } catch (e) {
                // 忽略单个卡片错误
            }
        }
        
        // 保底：整个 body 文本
        if (Object.keys(stats).length < 4) {
            console.log("卡片提取不完整，使用 body 文本保底");
            const bodyText = await page.innerText('body');
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l);
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].toLowerCase();
                if (line.includes("uptime") && i + 1 < lines.length) {
                    stats.uptime = lines[i + 1];
                }
                if ((line.includes("cpu load") || (line.includes("cpu") && line.includes("load"))) && i + 1 < lines.length) {
                    stats.cpu_load = lines[i + 1];
                }
                if (line.includes("memory") && !line.includes("network") && i + 1 < lines.length) {
                    stats.memory = lines[i + 1];
                }
                if (line.includes("disk") && i + 1 < lines.length) {
                    stats.disk = lines[i + 1];
                }
                if ((line.includes("inbound") || line.includes("network in")) && i + 1 < lines.length) {
                    stats.network_in = lines[i + 1];
                }
                if ((line.includes("outbound") || line.includes("network out")) && i + 1 < lines.length) {
                    stats.network_out = lines[i + 1];
                }
            }
        }
        
        console.log(`提取成功: ${JSON.stringify(stats)}`);
        
    } catch (e) {
        console.error(`提取统计信息失败: ${e.message}`);
        stats.error = e.message;
    }
    
    return stats;
}

// 格式化统计信息
function formatStatsMessage(stats, username) {
    // 打码 server ID
    let address = stats.address || 'N/A';
    if (address.includes('564fec71')) {
        address = address.replace('564fec71', '***');
    }
    
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    
    const lines = [];
    lines.push("🖥️ 服务器状态监控");
    lines.push("");
    lines.push(`👤 用户: ${username}`);
    lines.push(`📍 地址: ${address}`);
    lines.push(`⏱️ 运行时间: ${stats.uptime || 'N/A'}`);
    lines.push(`💻 CPU 负载: ${stats.cpu_load || 'N/A'}`);
    lines.push(`🧠 内存使用: ${stats.memory || 'N/A'}`);
    lines.push(`💾 磁盘使用: ${stats.disk || 'N/A'}`);
    lines.push(`📥 网络入站: ${stats.network_in || 'N/A'}`);
    lines.push(`📤 网络出站: ${stats.network_out || 'N/A'}`);
    lines.push("");
    lines.push(`更新时间: ${beijingTime}`);
    
    return lines.join('\n');
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
            await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

            // 处理登录页 Turnstile
            await handleTurnstile(page, '登录页');
            
            // 输入凭据
            console.log('输入登录信息...');
            
            await page.waitForSelector(CONFIG.selectors.emailInput, { timeout: 10000 });
            await page.fill(CONFIG.selectors.emailInput, user.username);
            
            await page.waitForSelector(CONFIG.selectors.passwordInput, { timeout: 10000 });
            await page.fill(CONFIG.selectors.passwordInput, user.password);

            // 截图：登录信息填写后
            const loginFilledScreenshot = await captureScreenshot(page, `${safeUser}_login_filled.png`);

            // 再次检查 Turnstile
            await handleTurnstile(page, '登录前');
            
            // 点击登录按钮
            console.log('点击登录...');
            try {
                await page.getByRole('button', { name: 'Login', exact: false }).click({ timeout: 10000 });
            } catch (e) {
                await page.locator("button:has-text('Login')").click({ timeout: 10000 });
            }
            
            await page.waitForTimeout(1000);
            
            // 截图：点击登录后
            const afterClickScreenshot = await captureScreenshot(page, `${safeUser}_after_click.png`);
            await sendWechatImage(afterClickScreenshot);
            
            // 等待页面加载
            await page.waitForLoadState('networkidle', { timeout: 20000 });
            await page.waitForTimeout(2500);

            // 检查登录结果
            const currentUrl = page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/error')) {
                // 检查是否有 webapphost 文字
                const hasWebapphost = await page.locator('text=webapphost').count() > 0;
                if (!hasWebapphost) {
                    const failScreenshot = await captureScreenshot(page, `${safeUser}_login_failed.png`);
                    await sendWechatImage(failScreenshot);
                    
                    const msg = `❌ ${CONFIG.name} 登录失败\n用户: ${maskedUser}\nURL: ${currentUrl}`;
                    await sendWechatText(msg);
                    continue;
                }
            }

            console.log('✅ 登录成功');
            console.log(`当前 URL: ${currentUrl}`);
            
            // 截图：Dashboard
            const dashboardScreenshot = await captureScreenshot(page, `${safeUser}_dashboard.png`);
            await sendWechatImage(dashboardScreenshot);
            
            // 发送登录成功通知
            const successMsg = `✅ 登录成功！\n用户: ${maskedUser}\n页面: ${currentUrl}`;
            await sendWechatText(successMsg);
            
            // 查找并点击 webapphost
            console.log('查找 webapphost...');
            await page.waitForSelector('text=webapphost', { timeout: 10000 });
            
            const webapphostLink = page.locator('text=webapphost').first;
            const isVisible = await webapphostLink.isVisible();
            
            if (!isVisible) {
                throw new Error('未找到 webapphost 链接');
            }
            
            console.log('点击进入 webapphost...');
            await webapphostLink.click();
            
            // 等待详情页加载
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(3000);
            
            const detailUrl = page.url();
            console.log(`进入服务器详情页: ${detailUrl.replace('564fec71', '***')}`);
            
            // 截图：服务器详情
            const detailScreenshot = await captureScreenshot(page, `${safeUser}_server_detail.png`);
            await sendWechatImage(detailScreenshot);
            
            // 提取服务器统计信息
            console.log('提取服务器统计信息...');
            const stats = await getServerStats(page);
            
            // 发送统计信息
            const statsMessage = formatStatsMessage(stats, maskedUser);
            await sendWechatText(statsMessage);

        } catch (err) {
            console.error(`处理出错:`, err);
            
            // 尝试截图错误页面
            try {
                const errorScreenshot = await captureScreenshot(page, `${safeUser}_error.png`);
                await sendWechatImage(errorScreenshot);
            } catch (e) {
                // 忽略截图错误
            }
            
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
