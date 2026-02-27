const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ==================== 配置区域 ====================
const CONFIG = {
    name: 'LunesHost',
    baseUrl: 'https://betadash.lunes.host',
    loginPath: '/login?next=/',
    logoutPath: '/logout',
    dashboardPath: '/dashboard',
    
    // 登录页面元素配置
    selectors: {
        emailInput: 'input#email, input[name="email"], input[type="email"]',
        passwordInput: 'input#password, input[name="password"], input[type="password"]',
        loginButton: 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button.btn-primary',
    },
    
    // 登录成功/失败判断
    checkLoginSuccess: (url) => url.includes('/dashboard') || url.includes('/home') || (!url.includes('/login') && !url.includes('/error')),
    checkLoginError: (url) => url.includes('/login') || url.includes('/error') || url.includes('failed'),
    
    // 任务配置
    tasks: [
        {
            name: '获取账户信息',
            action: async (page) => {
                await page.waitForTimeout(3000);
                
                const info = await page.evaluate(() => {
                    const data = {};
                    const elements = document.querySelectorAll('div, span, p, td');
                    elements.forEach(el => {
                        const text = el.innerText || '';
                        
                        if (text.includes('Balance') || text.includes('Credits') || text.includes('余额')) {
                            const match = text.match(/[\d.]+/);
                            if (match) data.balance = match[0];
                        }
                        
                        if (text.includes('Server') || text.includes('Services')) {
                            const match = text.match(/\d+/);
                            if (match) data.servers = match[0];
                        }
                        
                        if (text.includes('Welcome') || el.className.includes('user')) {
                            data.welcome = text.trim();
                        }
                    });
                    
                    return data;
                });
                
                return info;
            }
        }
    ]
};

// ==================== 企业微信配置 ====================
const WECHAT_KEY = process.env.WECHAT_KEY;
const WECHAT_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';

// ==================== 调试输出 ====================
console.log('========== 环境变量调试 ==========');
console.log('WECHAT_KEY:', WECHAT_KEY ? '已设置' : '未设置');
console.log('USERS_JSON:', process.env.USERS_JSON ? '已设置' : '未设置');
console.log('===================================');

// 截图目录
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
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

// 保存截图
async function saveScreenshot(page, filename) {
    const filepath = path.join(SCREENSHOT_DIR, filename);
    try {
        await page.screenshot({ path: filepath, fullPage: true });
        console.log(`📸 截图已保存: ${filename}`);
        return filepath;
    } catch (e) {
        console.error('截图失败:', e.message);
        return null;
    }
}

// 发送企业微信消息
async function sendWechatMessage(text) {
    if (!WECHAT_KEY) {
        console.log('[企业微信] 未配置 WECHAT_KEY，跳过发送');
        return;
    }

    try {
        const url = `${WECHAT_WEBHOOK_BASE}?key=${WECHAT_KEY}`;
        const payload = {
            msgtype: 'text',
            text: { content: text }
        };

        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        if (response.data?.errcode === 0) {
            console.log('[企业微信] 消息已发送');
        } else {
            console.error('[企业微信] 发送失败:', response.data?.errmsg || '未知错误');
        }
    } catch (e) {
        console.error('[企业微信] 发送失败:', e.message);
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
            await saveScreenshot(page, `${CONFIG.name}_${safeUser}_01_login.png`);

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
            
            await saveScreenshot(page, `${CONFIG.name}_${safeUser}_02_after_login.png`);

            // 检查登录结果
            if (CONFIG.checkLoginError(page.url())) {
                let failReason = '未知错误';
                try {
                    const errorText = await page.locator('text=/incorrect|invalid|error|failed/i').first().innerText({ timeout: 2000 });
                    if (errorText) failReason = errorText;
                } catch (e) {}
                
                const msg = `❌ ${CONFIG.name} 登录失败\n用户: ${maskedUser}\n原因: ${failReason}`;
                console.log(msg);
                await sendWechatMessage(msg);
                continue;
            }

            console.log('✅ 登录成功');
            
            // 执行配置的任务
            for (const task of CONFIG.tasks) {
                console.log(`执行任务: ${task.name}...`);
                try {
                    const result = await task.action(page);
                    const msg = `✅ ${CONFIG.name} - ${task.name}\n用户: ${maskedUser}\n结果: ${JSON.stringify(result, null, 2)}`;
                    console.log(msg);
                    await sendWechatMessage(msg);
                } catch (taskError) {
                    const msg = `❌ ${CONFIG.name} - ${task.name} 失败\n用户: ${maskedUser}\n错误: ${taskError.message}`;
                    console.error(msg);
                    await sendWechatMessage(msg);
                }
            }

        } catch (err) {
            console.error(`处理出错:`, err);
            const msg = `❌ ${CONFIG.name} 处理出错\n用户: ${maskedUser}\n错误: ${err.message}`;
            await sendWechatMessage(msg);
        }
        
        console.log(`用户 ${maskedUser} 处理完成`);
        console.log('---');
    }

    console.log('\n所有用户处理完成');
    try { await browser.close(); } catch (e) {}
    process.exit(0);
})();
