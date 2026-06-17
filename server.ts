import express from 'express';
import path from 'path';
import fs from 'fs';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import { createServer as createViteServer } from 'vite';
import cron from 'node-cron';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.cwd(), 'db.json');

const TARGET_DOUYIN_ACCOUNTS = [
  '@阿良良木历-咕嘎',
  '@Boti',
  '@昙花若只一现',
  '@峦城山师妹',
  '@月晴',
  '@罗德岛下雪了'
];

interface DiscoveredVideo {
  id: string;
  title: string;
  playUrl: string;
  coverUrl: string;
  localPath: string;
  duration: number;
  addedAt: string;
  author?: string;
}

interface AppState {
  tokens: any | null;
  logs: { time: string; status: string; message: string }[];
  isBotRunning: boolean;
  downloadedCount: number;
  uploadedCount: number;
  processedVideoIds: string[];
  processedVideoTitles?: string[];
  processedVideoUrls?: string[];
  blacklistedVideoIds: string[];
  lastRunTimestamp?: number;
  pendingQueue?: DiscoveredVideo[];
  lastCrawlTimestamp?: number;
  downloadCycle?: number;
}

const SCRAPED_DIR = path.join(process.cwd(), 'scraped_videos');
if (!fs.existsSync(SCRAPED_DIR)) {
  fs.mkdirSync(SCRAPED_DIR, { recursive: true });
}

function readState(): AppState {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(data) as AppState;
      if (parsed.downloadedCount === undefined) parsed.downloadedCount = 0;
      if (parsed.uploadedCount === undefined) parsed.uploadedCount = 0;
      if (parsed.processedVideoIds === undefined) parsed.processedVideoIds = [];
      if (parsed.processedVideoTitles === undefined) parsed.processedVideoTitles = [];
      if (parsed.processedVideoUrls === undefined) parsed.processedVideoUrls = [];
      if (parsed.blacklistedVideoIds === undefined) parsed.blacklistedVideoIds = [];
      if (parsed.lastRunTimestamp === undefined) parsed.lastRunTimestamp = 0;
      if (parsed.pendingQueue === undefined) parsed.pendingQueue = [];
      if (parsed.lastCrawlTimestamp === undefined) parsed.lastCrawlTimestamp = 0;
      if (parsed.downloadCycle === undefined) parsed.downloadCycle = 0;
      parsed.processedVideoIds = parsed.processedVideoIds.map(id => String(id));
      return parsed;
    }
  } catch (e) {
    console.error('Error reading db.json', e);
  }
  return {
    tokens: null,
    logs: [],
    isBotRunning: false,
    downloadedCount: 0,
    uploadedCount: 0,
    processedVideoIds: [],
    processedVideoTitles: [],
    processedVideoUrls: [],
    blacklistedVideoIds: [],
    lastRunTimestamp: 0,
    pendingQueue: [],
    lastCrawlTimestamp: 0,
    downloadCycle: 0
  };
}

function writeState(state: AppState) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error writing db.json', e);
  }
}

let isWorkflowExecuting = false;

function addLog(status: string, message: string) {
  const state = readState();
  state.logs.unshift({ time: new Date().toISOString(), status, message });
  if (state.logs.length > 50) state.logs = state.logs.slice(0, 50);
  writeState(state);
  console.log(`[${status}] ${message}`);
}

function cleanAllTempVideos() {
  try {
    const files = fs.readdirSync(process.cwd());
    let rootDeleted = 0;
    for (const file of files) {
      if (file.startsWith('downloaded_') && file.endsWith('.mp4')) {
        const fullPath = path.join(process.cwd(), file);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          rootDeleted++;
        }
      }
    }

    const state = readState();
    const queuedPaths = (state.pendingQueue || []).map(v => path.resolve(v.localPath));
    let dirDeleted = 0;
    if (fs.existsSync(SCRAPED_DIR)) {
      const scrapedFiles = fs.readdirSync(SCRAPED_DIR);
      for (const file of scrapedFiles) {
        const fullPath = path.resolve(SCRAPED_DIR, file);
        if (!queuedPaths.includes(fullPath) && file.endsWith('.mp4')) {
          fs.unlinkSync(fullPath);
          dirDeleted++;
        }
      }
    }

    if (rootDeleted > 0 || dirDeleted > 0) {
      console.log(`Cleaned up: ${rootDeleted} loose files, ${dirDeleted} untracked files from scraped_videos.`);
    }
  } catch (err) {
    console.error('Failed to clear temp files:', err);
  }
}

app.get('/api/status', (req, res) => {
  const state = readState();

  if (state.isBotRunning && !isWorkflowExecuting && state.tokens) {
    const lastRun = state.lastRunTimestamp || 0;
    const elapsed = Date.now() - lastRun;
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (elapsed >= TWO_HOURS) {
      addLog('INFO', 'Bot heartbeat: 2 hours elapsed since last upload. Starting upload cycle.');
      runVideoWorkflow().catch(err => {
        console.error('Auto upload run failed:', err);
      });
    }
  }

  if (state.isBotRunning && state.tokens && (!state.pendingQueue || state.pendingQueue.length < 3)) {
    const lastCrawl = state.lastCrawlTimestamp || 0;
    const minutesSinceLastCrawl = (Date.now() - lastCrawl) / (60 * 1000);
    if (minutesSinceLastCrawl >= 2) {
      console.log('Low queue detected. Continuous background discovery triggered.');
      runDiscoveryWorkflow().catch(err => {
        console.error('Proactive bg discovery failed:', err);
      });
    }
  }

  res.json({
    connected: !!state.tokens,
    isBotRunning: state.isBotRunning,
    logs: state.logs,
    downloadedCount: state.downloadedCount,
    uploadedCount: state.uploadedCount,
    pendingQueue: state.pendingQueue || [],
    isWorkflowExecuting,
    downloadCycle: state.downloadCycle
  });
});

app.post('/api/bot/toggle', (req, res) => {
  const { running } = req.body;
  const state = readState();
  state.isBotRunning = !!running;

  if (!!running) {
    state.lastRunTimestamp = 0;
  }

  writeState(state);
  addLog('INFO', `Bot is now ${running ? '🟢 ACTIVATED (24/7 Mode)' : '⛔ STOPPED'}`);

  if (!!running && state.tokens) {
    runDiscoveryWorkflow().then(() => {
      runVideoWorkflow().catch(err => {
        console.error('Initial auto upload run failed on start:', err);
      });
    }).catch(err => {
      console.error('Initial discovery flow failed on start:', err);
    });
  }

  res.json({ success: true, isBotRunning: state.isBotRunning });
});

function getOAuthClient(req: express.Request) {
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || 'UNCONFIGURED_CLIENT_ID',
    process.env.GOOGLE_CLIENT_SECRET || 'UNCONFIGURED_CLIENT_SECRET',
    `${appUrl}/api/auth/callback`
  );
}

app.get('/api/auth/url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') {
    return res.status(400).json({ error: 'GOOGLE_CLIENT_ID is not configured in environment variables.' });
  }

  const oauth2Client = getOAuthClient(req);
  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.json({ url: authUrl });
});

app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    res.status(400).send('No code provided');
    return;
  }

  try {
    const oauth2Client = getOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(code);

    const state = readState();
    state.tokens = tokens;
    writeState(state);
    addLog('SUCCESS', '✅ YouTube account connected successfully!');

    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0f172a;">
          <div style="text-align: center; color: white;">
            <h1>🎉 Success!</h1>
            <p>YouTube account connected. Bot is ready to run 24/7!</p>
            <p style="color: #94a3b8; font-size: 14px;">This window will close automatically...</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              setTimeout(() => window.close(), 2000);
            } else {
              window.location.href = '/';
            }
          </script>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error('OAuth callback error', err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let disableGeminiUntil = 0;
let lastGeminiCallTime = 0;

async function fetchFromRapidAPI(accountHandle: string): Promise<any[]> {
  const rapidApiKey = process.env.RAPID_API_KEY;
  const rapidApiHost = process.env.RAPID_API_HOST || 'douyin-api.p.rapidapi.com';

  if (!rapidApiKey) {
    console.error('RAPID_API_KEY not configured');
    return [];
  }

  try {
    const url = `https://${rapidApiHost}/user/search?keyword=${encodeURIComponent(accountHandle)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': rapidApiKey,
        'X-RapidAPI-Host': rapidApiHost
      }
    });

    if (!response.ok) {
      console.warn(`Rapid API failed for account "${accountHandle}": ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const videos = data?.data?.videos || data?.videos || [];

    return videos.filter((v: any) => {
      const duration = v.duration || v.video_duration || 0;
      const hasPlayUrl = v.download_url || v.play_url || v.video_url;
      const isHighQuality = v.quality === 'high' || v.resolution?.includes('720') || v.resolution?.includes('1080');
      const noWatermark = !v.has_watermark && !v.watermark_url && !v.watermarked;

      return duration >= 15 && hasPlayUrl && isHighQuality && noWatermark;
    });
  } catch (err: any) {
    console.error(`Rapid API error for account ${accountHandle}:`, err.message);
    return [];
  }
}

function hasChineseText(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

async function checkForCopyright(videoPath: string, title: string): Promise<boolean> {
  const copyrightKeywords = [
    'copyright', '©', '™', 'official music video', 'music video',
    'ost', 'soundtrack', 'song', 'music', 'cover',
    '版权', '音乐', '歌曲', '官方', 'official'
  ];
  const titleLower = title.toLowerCase();

  return copyrightKeywords.some(kw => titleLower.includes(kw));
}

async function runDiscoveryWorkflow(): Promise<number> {
  const state = readState();
  if (!state.isBotRunning) return 0;

  if (state.downloadedCount >= 100) {
    addLog('WARN', '⏸️ 100 videos downloaded. Taking a break. Will resume when queue drops below 50.');
    state.downloadCycle = 1;
    writeState(state);
    return 0;
  }

  if (state.downloadCycle === 1 && state.downloadedCount >= 50) {
    addLog('INFO', '⏳ Queue still above 50. Continuing break...');
    return 0;
  }

  if (state.downloadCycle === 1 && state.downloadedCount < 50) {
    addLog('SUCCESS', '🚀 Queue dropped below 50. Resuming downloads!');
    state.downloadCycle = 0;
    writeState(state);
  }

  const queue = state.pendingQueue || [];
  const targetQueueSize = 6;
  if (queue.length >= targetQueueSize) return 0;

  let addedCount = 0;
  addLog('INFO', '🔍 24/7 Discovery: Scanning target Douyin accounts...');

  for (const account of TARGET_DOUYIN_ACCOUNTS) {
    const currentQueue = readState().pendingQueue || [];
    if (currentQueue.length >= targetQueueSize) break;

    try {
      console.log(`📥 Fetching videos from: ${account}`);
      const videos = await fetchFromRapidAPI(account);

      if (videos.length === 0) {
        console.warn(`No videos found for account ${account}`);
        continue;
      }

      const sortedVideos = [...videos].sort((a: any, b: any) => {
        const timeA = a.create_time || a.created_at || 0;
        const timeB = b.create_time || b.created_at || 0;
        return timeB - timeA;
      });

      for (const video of sortedVideos.slice(0, 5)) {
        const checkQueue = readState().pendingQueue || [];
        if (checkQueue.length >= targetQueueSize) break;

        const vId = String(video.video_id || video.id || '');
        const vTitle = String(video.title || '').trim();
        const currentState = readState();

        if (currentState.blacklistedVideoIds?.includes(vId)) {
          console.log(`⛔ Blacklisted: ${vId}`);
          continue;
        }

        if (hasChineseText(vTitle)) {
          addLog('WARN', `❌ Rejected: Chinese text detected. "${vTitle.substring(0, 50)}..."`);
          currentState.blacklistedVideoIds.push(vId);
          writeState(currentState);
          continue;
        }

        const hasCopyright = await checkForCopyright(video.download_url || '', vTitle);
        if (hasCopyright) {
          addLog('WARN', `❌ Rejected: Copyright/Music detected. "${vTitle.substring(0, 50)}..."`);
          currentState.blacklistedVideoIds.push(vId);
          writeState(currentState);
          continue;
        }

        if (video.has_watermark) {
          addLog('WARN', `❌ Rejected: Watermark detected. ID: ${vId}`);
          currentState.blacklistedVideoIds.push(vId);
          writeState(currentState);
          continue;
        }

        const downloadUrl = video.download_url || video.play_url || video.video_url;
        if (!downloadUrl) continue;

        try {
          const uuid = Math.floor(Math.random() * 10000000);
          const localVideoPath = path.join(SCRAPED_DIR, `video_${vId}_${uuid}.mp4`);

          console.log(`⬇️ Downloading: ${vId} from ${account}`);
          const vidRes = await fetch(downloadUrl);
          if (vidRes.ok) {
            const buffer = await vidRes.arrayBuffer();
            fs.writeFileSync(localVideoPath, Buffer.from(buffer));

            const newVideo: DiscoveredVideo = {
              id: vId,
              title: vTitle,
              playUrl: downloadUrl,
              coverUrl: video.cover || video.origin_cover || '',
              localPath: localVideoPath,
              duration: video.duration || 0,
              addedAt: new Date().toISOString(),
              author: account
            };

            const updatedState = readState();
            if (!updatedState.pendingQueue) updatedState.pendingQueue = [];
            const isDuplicate = updatedState.pendingQueue.some(item => item.id === vId);

            if (!isDuplicate) {
              updatedState.pendingQueue.push(newVideo);
              updatedState.downloadedCount += 1;
              writeState(updatedState);
              addLog('SUCCESS', `📥 Downloaded: "${vTitle.substring(0, 40)}..." from ${account}`);
              addedCount++;
            } else {
              if (fs.existsSync(localVideoPath)) fs.unlinkSync(localVideoPath);
            }
          }
        } catch (downloadErr) {
          console.error(`Download failed for video ${vId}:`, downloadErr);
        }
      }
    } catch (e) {
      console.error(`Discovery error for account ${account}:`, e);
    }
  }

  const finalState = readState();
  finalState.lastCrawlTimestamp = Date.now();
  writeState(finalState);
  return addedCount;
}

async function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'douyin-youtube-bot'
      }
    }
  });
}

async function getOrCreateNextVideoForUpload() {
  let state = readState();
  if (!state.pendingQueue || state.pendingQueue.length === 0) {
    addLog('INFO', '⏳ No videos in queue. Initiating discovery...');
    await runDiscoveryWorkflow();
    state = readState();
  }

  const nextItem = state.pendingQueue && state.pendingQueue[0];
  if (!nextItem) {
    throw new Error('All potential videos were rejected or unavailable.');
  }

  if (!fs.existsSync(nextItem.localPath)) {
    addLog('WARN', `⚠️ Video file missing on disk: ${nextItem.localPath}`);
    state.pendingQueue.shift();
    writeState(state);
    return getOrCreateNextVideoForUpload();
  }

  let finalTitle = `Amazing AI Animation #shorts`;
  let finalDescription = 'Check out this stunning animation! Like and subscribe for more! #shorts #animation #ai';
  let finalTags = ['ai', 'animation', 'shorts'];

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY' && Date.now() > disableGeminiUntil) {
    try {
      if (lastGeminiCallTime > 0) {
        const elapsed = Date.now() - lastGeminiCallTime;
        if (elapsed < 3000) await sleep(3000 - elapsed);
      }
      lastGeminiCallTime = Date.now();

      const ai = await getGeminiClient();
      const prompt = `You are a YouTube content expert. Generate metadata for this video.

Video Title: "${nextItem.title}"

Return ONLY valid JSON (no markdown, no code blocks):
{
  "title": "Engaging title under 60 chars with #shorts #ai",
  "description": "2-3 sentence description in English only",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}

Requirements:
- Title in English ONLY, max 60 characters
- Description in English ONLY
- All tags in English
- Include #shorts and #ai in title`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt
      });

      if (response.text) {
        try {
          const rawJsonText = response.text
            .replace(/^```json\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
          const generatedData = JSON.parse(rawJsonText);
          if (generatedData.title) finalTitle = generatedData.title;
          if (generatedData.description) finalDescription = generatedData.description;
          if (generatedData.tags && Array.isArray(generatedData.tags)) finalTags = generatedData.tags;
        } catch (parseErr) {
          console.error('Failed to parse Gemini JSON:', parseErr);
        }
      }
    } catch (e) {
      console.error('Gemini metadata generation error:', e);
      addLog('WARN', '⚠️ Gemini failed, using fallback metadata');
    }
  }

  return {
    item: nextItem,
    videoPath: nextItem.localPath,
    title: finalTitle,
    description: finalDescription,
    tags: finalTags
  };
}

async function runVideoWorkflow() {
  if (isWorkflowExecuting) {
    console.log('⏳ Upload already in-progress. Skipping.');
    return;
  }
  isWorkflowExecuting = true;

  cleanAllTempVideos();

  const state = readState();
  if (!state.isBotRunning) {
    isWorkflowExecuting = false;
    return;
  }
  if (!state.tokens) {
    addLog('ERROR', '❌ No YouTube account connected.');
    isWorkflowExecuting = false;
    return;
  }

  let uploadedVideoRef: any = null;
  try {
    addLog('INFO', '📦 Getting next video from queue...');
    const videoData = await getOrCreateNextVideoForUpload();
    uploadedVideoRef = videoData.item;

    const titleHasChinese = hasChineseText(videoData.item.title);
    const descHasChinese = hasChineseText(videoData.description);
    if (titleHasChinese || descHasChinese) {
      addLog('ERROR', `❌ Upload rejected: Chinese text detected. ID: ${videoData.item.id}`);
      state.blacklistedVideoIds.push(uploadedVideoRef.id);
      if (state.pendingQueue) {
        state.pendingQueue = state.pendingQueue.filter(item => item.id !== uploadedVideoRef.id);
      }
      writeState(state);
      if (fs.existsSync(uploadedVideoRef.localPath)) {
        fs.unlinkSync(uploadedVideoRef.localPath);
      }
      isWorkflowExecuting = false;
      return;
    }

    const hasCopyright = await checkForCopyright(videoData.videoPath, videoData.title);
    if (hasCopyright) {
      addLog('ERROR', `❌ Upload rejected: Copyright detected. ID: ${videoData.item.id}`);
      state.blacklistedVideoIds.push(uploadedVideoRef.id);
      if (state.pendingQueue) {
        state.pendingQueue = state.pendingQueue.filter(item => item.id !== uploadedVideoRef.id);
      }
      writeState(state);
      if (fs.existsSync(uploadedVideoRef.localPath)) {
        fs.unlinkSync(uploadedVideoRef.localPath);
      }
      isWorkflowExecuting = false;
      return;
    }

    addLog('INFO', `📤 Uploading: "${videoData.title}"...`);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials(state.tokens);

    oauth2Client.on('tokens', (tokens) => {
      const st = readState();
      if (tokens.refresh_token) {
        st.tokens.refresh_token = tokens.refresh_token;
      }
      st.tokens.access_token = tokens.access_token;
      st.tokens.expiry_date = tokens.expiry_date;
      writeState(st);
    });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: videoData.title,
          description: videoData.description,
          tags: videoData.tags,
          categoryId: '1',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(videoData.videoPath),
      },
    });

    addLog('SUCCESS', `✅ Uploaded to YouTube! Video ID: ${res.data.id}`);

    const stateAfterUpload = readState();
    stateAfterUpload.uploadedCount += 1;

    const targetId = String(uploadedVideoRef.id);
    if (!stateAfterUpload.processedVideoIds.includes(targetId)) {
      stateAfterUpload.processedVideoIds.push(targetId);
    }

    if (stateAfterUpload.pendingQueue) {
      stateAfterUpload.pendingQueue = stateAfterUpload.pendingQueue.filter(item => item.id !== targetId);
    }
    writeState(stateAfterUpload);

    if (fs.existsSync(uploadedVideoRef.localPath)) {
      try {
        fs.unlinkSync(uploadedVideoRef.localPath);
        addLog('INFO', `🗑️ Deleted from server: ${uploadedVideoRef.localPath}`);
      } catch (err) {
        console.error('Unlink failed:', err);
      }
    }
  } catch (error: any) {
    let errMsg = error.message;
    if (errMsg?.includes('YouTube Data API v3 has not been used')) {
      errMsg = 'Enable "YouTube Data API v3" in Google Cloud Developer Console.';
    }
    addLog('ERROR', `❌ Upload failed: ${errMsg}`);
    console.error('Workflow error:', error);

    if (uploadedVideoRef) {
      const stateOnFail = readState();
      if (stateOnFail.pendingQueue) {
        stateOnFail.pendingQueue = stateOnFail.pendingQueue.filter(item => item.id !== uploadedVideoRef.id);
      }
      writeState(stateOnFail);

      if (fs.existsSync(uploadedVideoRef.localPath)) {
        try {
          fs.unlinkSync(uploadedVideoRef.localPath);
        } catch (e) {}
      }
    }
  } finally {
    isWorkflowExecuting = false;

    const finalState = readState();
    finalState.lastRunTimestamp = Date.now();
    writeState(finalState);

    cleanAllTempVideos();
  }
}

app.post('/api/bot/force-run', async (req, res) => {
  res.json({ message: 'Triggered manual run' });
  runVideoWorkflow();
});

app.post('/api/bot/reset-downloads', (req, res) => {
  const state = readState();
  state.downloadedCount = 0;
  state.downloadCycle = 0;
  writeState(state);
  addLog('SUCCESS', '🔄 Download counter reset.');
  res.json({ success: true, downloadedCount: 0 });
});

app.delete('/api/bot/queue/:id', (req, res) => {
  const { id } = req.params;
  const state = readState();

  const pendingQueue = state.pendingQueue || [];
  const videoToDelete = pendingQueue.find(item => item.id === id);

  if (!videoToDelete) {
    return res.status(404).json({ error: 'Video not found in queue' });
  }

  if (videoToDelete.localPath && fs.existsSync(videoToDelete.localPath)) {
    try {
      fs.unlinkSync(videoToDelete.localPath);
    } catch (err) {
      console.error(`Failed to unlink file:`, err);
    }
  }

  state.pendingQueue = pendingQueue.filter(item => item.id !== id);
  if (!state.processedVideoIds.includes(id)) {
    state.processedVideoIds.push(id);
  }

  writeState(state);
  cleanAllTempVideos();

  addLog('INFO', `Removed: "${videoToDelete.title}"`);

  res.json({ success: true, pendingQueue: state.pendingQueue });
});

cron.schedule('0 */2 * * *', () => {
  const state = readState();
  if (state.isBotRunning) {
    console.log('⏰ Cron triggered: 2-hour upload cycle');
    runVideoWorkflow();
  }
});

app.get('/api/bot/cron-trigger', async (req, res) => {
  const state = readState();
  if (state.isBotRunning) {
    addLog('INFO', 'External cron webhook triggered.');
    await runVideoWorkflow();
    res.json({ message: 'Upload cycle completed.' });
  } else {
    res.json({ message: 'Bot is stopped, ignoring cron trigger' });
  }
});

async function startServer() {
  cleanAllTempVideos();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🤖 Douyin→YouTube Bot Server running on http://localhost:${PORT}`);
    console.log(`📍 Target Accounts: ${TARGET_DOUYIN_ACCOUNTS.join(', ')}`);
    console.log(`⏰ Upload Cycle: Every 2 hours (24/7)`);
    console.log(`\n✅ Ready to connect YouTube account!\n`);
    addLog('INFO', '🚀 Bot server started and ready!');
  });
}

startServer();
