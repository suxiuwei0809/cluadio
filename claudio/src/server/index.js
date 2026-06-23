// ============================================================
// index.js — Claudio Fastify 入口
// 启动串联：env 校验 → netease 登录 → 路由注册 → 静态服务 → 监听
// ============================================================

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { config } from 'dotenv';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// 加载 .env
config();

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

// ---- 启动前校验 ----

function validateEnv() {
  const required = [
    'DEEPSEEK_API_KEY',
    'FISH_AUDIO_KEY'
  ];
  const optional = [
    'NETEASE_PHONE',
    'NETEASE_PASSWORD',
    'OPENWEATHER_KEY',
    'FEISHU_APP_ID'
  ];

  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[启动失败] 缺少必需环境变量: ${missing.join(', ')}`);
    console.error('请复制 .env.example 为 .env 并填入对应密钥');
    process.exit(1);
  }

  const skipped = optional.filter(k => !process.env[k]);
  if (skipped.length > 0) {
    console.warn(`[警告] 未配置可选服务: ${skipped.join(', ')}，对应功能将不可用`);
  }

  console.log('[启动] 环境变量校验通过');
}

// ---- Fastify 实例 ----

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' }
    }
  }
});

// ---- 插件注册 ----

async function registerPlugins() {
  // CORS（开发阶段）
  await app.register(fastifyCors, {
    origin: true,
    credentials: true
  });

  // WebSocket
  await app.register(fastifyWebsocket);

  // 静态资源（Vite 开发模式下由 Vite 代理，生产模式直接托管 dist）
  const distPath = join(process.cwd(), 'dist');
  const publicPath = join(process.cwd(), 'public');
  const staticRoot = existsSync(distPath) ? distPath : publicPath;

  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    decorateReply: false
  });

  // 额外注册 fallback 音频目录
  const fallbackPath = join(process.cwd(), 'src', 'data', 'fallback');
  await app.register(fastifyStatic, {
    root: fallbackPath,
    prefix: '/data/fallback/',
    decorateReply: false
  });

  // SPA fallback：非 API 请求兜底到 index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/stream')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  console.log('[启动] 插件注册完成');
}

// ---- 初始化外部服务 ----

async function initServices() {
  // 网易云登录（Spec 6.1）
  try {
    const { ensureLogin } = await import('./netease.js');
    await ensureLogin();
  } catch (err) {
    console.warn('[启动] 网易云登录失败，音乐服务将降级运行:', err.message);
  }

  // 清理过期 URL 缓存
  try {
    const { cleanExpiredCache } = await import('./netease.js');
    await cleanExpiredCache();
  } catch {}

  // ffmpeg 可用性检测
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(execFile);
    await execAsync('ffmpeg', ['-version'], { timeout: 5000 });
    console.log('[启动] ffmpeg 可用');
  } catch {
    console.warn('[启动] ffmpeg 不可用，TTS 转码将降级为 WAV');
  }

  // 确保缓存目录存在
  const { mkdir } = await import('fs/promises');
  await mkdir(join(process.cwd(), 'src', 'data', 'cache', 'tts'), { recursive: true });

  console.log('[启动] 外部服务初始化完成');
}

// ---- 启动 ----

async function start() {
  // 1. 环境变量校验
  validateEnv();

  // 2. 注册 Fastify 插件
  await registerPlugins();

  // 3. 初始化外部服务
  await initServices();

  // 4. 注册 API 路由
  const { registerRoutes } = await import('./router.js');
  await registerRoutes(app);

  // 5. 启动监听
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`\n🎵 Claudio 已就绪 → http://localhost:${port}`);
    console.log('   WS 端点: ws://localhost:' + port + '/stream');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// ---- 优雅退出 ----

process.on('SIGINT', async () => {
  console.log('\n[关闭] 收到 SIGINT，正在退出...');
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[关闭] 收到 SIGTERM，正在退出...');
  await app.close();
  process.exit(0);
});

start();
