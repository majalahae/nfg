const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const RSSParser = require('rss-parser');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));

const rss = new RSSParser();

// helper: fetch article metadata (simple)
async function fetchArticleMeta(url) {
  // try RSS first by host
  try {
    const parsed = await rss.parseURL(url);
    // jika berhasil parse RSS, ambil item pertama
    if (parsed.items && parsed.items.length) {
      const it = parsed.items[0];
      return { title: it.title || '', excerpt: it.contentSnippet || '', image: it.enclosure?.url || '' };
    }
  } catch (e) {
    // ignore
  }

  // fallback: coba ambil OG tags
  try {
    const res = await axios.get(url);
    const html = res.data;
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i) || html.match(/<meta name="description" content="([^"]+)"/i);
    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    return {
      title: titleMatch ? titleMatch[1] : '',
      excerpt: descMatch ? descMatch[1] : '',
      image: imgMatch ? imgMatch[1] : ''
    };
  } catch (e) {
    return { title: '', excerpt: '', image: '' };
  }
}

// generate poster endpoint
app.post('/generate', async (req, res) => {
  /**
   * body: { url: string, template: 'bold'|'clean', size: {w,h} optional, author: string }
   */
  const { url, template = 'bold', size } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const meta = await fetchArticleMeta(url);

  // create HTML for poster
  const html = buildHtmlPoster(meta, url, template, size);

  // render with puppeteer
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const viewport = size && size.w && size.h ? { width: size.w, height: size.h } : { width: 1200, height: 1600 };
  await page.setViewport(viewport);

  await page.setContent(html, { waitUntil: 'networkidle0' });

  const filename = `/tmp/poster-${uuidv4()}.png`;
  await page.screenshot({ path: filename, fullPage: true });
  await browser.close();

  // send file
  res.setHeader('Content-Type', 'image/png');
  const stream = fs.createReadStream(filename);
  stream.pipe(res);

  // cleanup async
  stream.on('close', () => {
    fs.unlink(filename, () => {});
  });
});

function buildHtmlPoster(meta, url, template, size) {
  // simple inline CSS template; bisa diganti dengan template engine
  const w = (size && size.w) || 1200;
  const h = (size && size.h) || 1600;
  const title = escapeHtml(meta.title || 'Judul Tidak Tersedia');
  const excerpt = escapeHtml(meta.excerpt || 'Ringkasan tidak tersedia.');
  const img = meta.image || '';
  const source = url;

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      @font-face { font-family: 'InterVar'; src: local('Arial'); }
      body { margin:0; font-family: InterVar, Arial, sans-serif; }
      .canvas { width:${w}px; height:${h}px; display:flex; flex-direction:column; background:#fff; }
      .hero { flex: 1 0 auto; position:relative; }
      .hero img { width:100%; height:100%; object-fit:cover; filter: brightness(0.6); }
      .overlay { position:absolute; inset:0; display:flex; align-items:flex-end; padding:40px; }
      .title { color:#fff; font-size:56px; line-height:1.05; font-weight:700; text-shadow: 0 6px 18px rgba(0,0,0,0.45); }
      .meta { padding:28px; font-size:20px; color:#333; }
      .source { font-size:14px; color:#666; margin-top:12px; }
      .branding { position:absolute; right:20px; top:20px; background:rgba(0,0,0,0.4); color:#fff; padding:8px 12px; border-radius:8px; font-size:14px; }
    </style>
  </head>
  <body>
  <div class="canvas">
    <div class="hero">
      ${img ? `<img src="${img}" />` : `<div style="width:100%;height:100%;background:#ddd;display:flex;align-items:center;justify-content:center;color:#666;">No image</div>`}
      <div class="overlay">
        <div>
          <div class="title">${title}</div>
        </div>
        <div class="branding">Sumber: ${escapeHtml(new URL(source).hostname)}</div>
      </div>
    </div>
    <div class="meta">
      <div>${excerpt}</div>
      <div class="source">Read more: ${escapeHtml(source)}</div>
    </div>
  </div>
  </body>
  </html>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ready on', PORT));
