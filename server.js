const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');
const { extractRules, rulesToPromptConstraints } = require('./lib/rulesExtractor');
const { scoreFidelity } = require('./lib/fidelityScorer');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API request logging middleware ──────────
app.use('/api', (req, res, next) => {
  const start = Date.now();
  const { method, path: reqPath } = req;
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[api] ${method} /api${reqPath} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── Gemini: generate full HTML page from DESIGN.md ──────────
app.post('/api/generate-page', async (req, res) => {
  const { designMd, pageType, customPrompt } = req.body;
  if (!designMd) return res.status(400).json({ error: 'designMd required' });
  if (typeof designMd !== 'string') return res.status(400).json({ error: 'designMd must be a string' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const PAGE_TEMPLATES = {
    dashboard: {
      name: 'Dashboard 仪表盘',
      brief: 'A data-rich admin dashboard with: top navigation bar (logo + nav links + user avatar), left sidebar with 5-6 menu items, main content area with 4 KPI metric cards in a row (number + label + trend arrow), a large chart section (use inline SVG for a line or bar chart), a recent activity table (5 rows), and a notifications panel on the right.'
    },
    landing: {
      name: '落地页',
      brief: 'A marketing landing page with: sticky nav, large hero (headline + subtitle + CTA button + hero image placeholder), 3-column feature section (icon + title + desc), testimonial quote, pricing cards (3 tiers), FAQ accordion, and footer.'
    },
    product: {
      name: '商品详情页',
      brief: 'An e-commerce product detail page with: breadcrumb, left side large product image gallery + thumbnails, right side product info (title, price, rating, color options, size options, quantity selector, add-to-cart button, description tabs), related products grid below.'
    },
    settings: {
      name: '设置页',
      brief: 'An app settings page with: left sidebar menu (Profile, Notifications, Privacy, Billing, API), main form area with sections, toggle switches, input fields, avatar upload, and save button.'
    },
    pricing: {
      name: '定价页',
      brief: 'A pricing page with: headline, monthly/yearly toggle, 3-4 pricing tier cards (name, price, feature list with checkmarks, CTA button), feature comparison table below, FAQ section.'
    },
    blog: {
      name: '博客文章页',
      brief: 'A blog article page with: top navigation, article header (title in large type, author avatar + name + date, read time, category tag), hero/cover image, long-form article body (headings, paragraphs, blockquotes, inline code, an image with caption, a bulleted list), a table of contents sidebar on desktop (sticky), author bio card at bottom, related posts grid (3 cards with thumbnail + title + excerpt), comment section placeholder, and footer.'
    },
    portfolio: {
      name: '作品集',
      brief: 'A creative portfolio page with: minimal top nav (name/logo + contact), a large hero statement (designer/developer tagline), a masonry or grid gallery of 6-8 project cards (each with cover image placeholder, project name, category tag, hover overlay with "View" button), an about section (photo placeholder + short bio + skill tags), a testimonial quote, and a contact CTA section with email link.'
    },
    login: {
      name: '登录注册页',
      brief: 'An auth page with: centered card on a subtle gradient or pattern background, logo at top, tab toggle between Login and Sign Up, login form (email input, password input with show/hide toggle, "forgot password" link, submit button), sign-up form (name, email, password, confirm password, terms checkbox, submit), social login divider ("or continue with") and 3 social buttons (Google, GitHub, Apple icons), footer links (privacy, terms).'
    },
    profile: {
      name: '个人主页',
      brief: 'A user profile page with: cover/banner image area, circular avatar overlapping the banner, user name + handle + short bio, stats row (posts, followers, following counts), tab bar (Posts, Projects, Likes, About), content feed below showing 4-5 post cards (text + image + engagement counts), right sidebar with suggested users list and trending tags. Mobile: single column, tabs become horizontally scrollable.'
    },
    error: {
      name: '404 错误页',
      brief: 'A 404 error page with: centered layout, large decorative "404" text (creative typography or inline SVG illustration), a friendly headline ("页面走丢了" or similar), a short description paragraph, a search input field, a "返回首页" primary button, and 3-4 suggested page links below. The page should feel on-brand and have personality, not generic.'
    },
    changelog: {
      name: '更新日志',
      brief: 'A changelog/release notes page with: top nav, page title "更新日志" with subtitle, a timeline layout where each entry has: version badge (e.g. v2.4.0), date, release title, categorized items with colored tags (New/新功能 in green, Improved/优化 in blue, Fixed/修复 in amber, Breaking/破坏性变更 in red), each item is one line of description. Show 5-6 releases. Include a "Subscribe to updates" email input at top.'
    },
    docs: {
      name: '文档页',
      brief: 'A documentation page with: top nav (logo + search bar + version dropdown + GitHub link), left sidebar with nested navigation (Getting Started, Installation, Configuration, API Reference, Examples — with expandable sub-items), main content area with: breadcrumb, h1 title, "On this page" right sidebar (table of contents), content body with headings, paragraphs, a code block with syntax highlighting colors and copy button, a callout/admonition box (tip), a parameters table, and prev/next navigation at bottom.'
    },
    appShowcase: {
      name: 'App 展示页',
      brief: 'A mobile app showcase/download page with: sticky nav (logo + features link + download button), hero section with large phone mockup frame (use a colored rectangle as screen placeholder) + headline + subtitle + two download buttons (App Store and Google Play with icons), scrolling feature sections (alternating left-right layout: phone mockup + feature title + description + bullet points, 3 sections), a stats/social proof bar (downloads count, rating, reviews), testimonial cards carousel (3 cards), and a final CTA section with download buttons and QR code placeholder.'
    }
  };

  if (pageType && !PAGE_TEMPLATES[pageType]) {
    return res.status(400).json({ error: `不支持的页面类型: ${pageType}，请使用有效的页面类型` });
  }
  const template = PAGE_TEMPLATES[pageType] || PAGE_TEMPLATES.dashboard;

  // Trim DESIGN.md to key sections only (keep under 4000 chars)
  const trimmedMd = designMd.length > 4000
    ? designMd.substring(0, 4000) + '\n\n(truncated for brevity)'
    : designMd;

  const prompt = `Generate a complete HTML page following this design system.

DESIGN SYSTEM:
${trimmedMd}

PAGE: ${template.name} — ${template.brief}
${customPrompt ? `Extra: ${customPrompt}` : ''}

RULES:
- Single HTML file, all CSS in <style>, start with <!DOCTYPE html>
- Use EXACT colors/fonts/radius/shadows from the design system
- Load Google Fonts via @import if needed
- Responsive (media query at 768px)
- Inline SVG for icons and charts
- Chinese placeholder content (中文)
- Images: use colored div or picsum.photos
- Hover states on interactive elements
- Follow Do's/Don'ts from design system
- NO explanation, NO code fences, ONLY the HTML`;

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5, maxOutputTokens: 16384 }
  });

  const models = ['gemini-2.5-flash', 'gemini-2.5-pro'];

  // Classify Gemini errors into user-friendly Chinese messages
  function classifyError(statusCode, message) {
    if (statusCode === 401 || statusCode === 403) return 'Gemini API 密钥无效或权限不足，请检查配置';
    if (statusCode === 429) return 'Gemini API 调用次数超限，请稍后重试';
    if (statusCode >= 500) return 'AI 服务暂时不可用，请稍后重试';
    return message || '生成失败，请重试';
  }

  let lastError = '';
  let responded = false;
  const tryModel = (idx) => {
    if (responded) return;
    if (idx >= models.length) {
      responded = true;
      console.error('All page-gen models failed. Last error:', lastError);
      return res.status(503).json({ error: lastError || '所有 AI 模型暂时不可用，请稍后重试' });
    }
    const model = models[idx];
    console.log(`[generate-page] Trying ${model} for ${pageType}...`);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 65000
    };
    let settled = false;
    const settle = () => { if (settled) return false; settled = true; return true; };

    const r = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (!settle()) return;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            lastError = classifyError(resp.statusCode, json.error.message);
            console.log(`[generate-page] ${model} error (${resp.statusCode}): ${json.error.message}`);
            return tryModel(idx + 1);
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            const reason = json.candidates?.[0]?.finishReason || 'empty';
            lastError = `AI 未生成有效内容（${reason}），请重试`;
            console.log(`[generate-page] ${model}: empty response (${reason})`);
            return tryModel(idx + 1);
          }
          // Strip code fences: handle "Here's the HTML:\n```html\n...\n```" pattern
          let cleaned = text;
          const fenceStart = cleaned.search(/```html?\s*\n/i);
          if (fenceStart >= 0) cleaned = cleaned.substring(cleaned.indexOf('\n', fenceStart) + 1);
          cleaned = cleaned.replace(/\n?```\s*$/i, '').trim();
          // Basic HTML validation: must contain structural HTML tags
          if (!/<(html|body|div|section|main|header|footer|article|nav)[\s>]/i.test(cleaned)) {
            lastError = 'AI 生成的内容不是有效 HTML，请重试';
            console.log(`[generate-page] ${model}: invalid HTML (no tags found), ${cleaned.length} chars`);
            return tryModel(idx + 1);
          }
          console.log(`[generate-page] ${model} success, ${cleaned.length} chars`);
          responded = true;
          res.json({ html: cleaned, model, pageType });
        } catch (e) {
          lastError = '解析 AI 响应失败，请重试';
          console.log(`[generate-page] ${model} parse error: ${e.message}`);
          tryModel(idx + 1);
        }
      });
    });
    r.on('error', (err) => {
      if (!settle()) return;
      lastError = '无法连接 AI 服务，请检查网络连接';
      console.log(`[generate-page] ${model} network error: ${err.message}`);
      tryModel(idx + 1);
    });
    r.setTimeout(120000, () => {
      if (!settle()) return;
      lastError = 'AI 生成超时，请稍后重试';
      console.log(`[generate-page] ${model} timeout`);
      r.destroy();
      tryModel(idx + 1);
    });
    r.write(payload);
    r.end();
  };

  tryModel(0);
});

// ─── Extract Rules Contract from DESIGN.md ──────────
app.post('/api/extract-rules', (req, res) => {
  const { designMd } = req.body;
  if (!designMd) return res.status(400).json({ error: 'designMd required' });
  try {
    const result = extractRules(designMd);
    res.json(result);
  } catch (e) {
    console.error('[extract-rules]', e.message);
    res.status(500).json({ error: '规则提取失败: ' + e.message });
  }
});

// ─── Score generated HTML against source DESIGN.md ──────────
app.post('/api/score-fidelity', (req, res) => {
  const { html, designMd } = req.body;
  if (!html || !designMd) return res.status(400).json({ error: 'html and designMd required' });
  try {
    const score = scoreFidelity(html, designMd);
    res.json({ score });
  } catch (e) {
    console.error('[score-fidelity]', e.message);
    res.status(500).json({ error: '评分失败: ' + e.message });
  }
});

// ─── Generate page with rules enforcement + fidelity scoring ──────────
app.post('/api/generate-with-rules', async (req, res) => {
  const { designMd, pageType, customPrompt, sourceImage } = req.body;
  if (!designMd) return res.status(400).json({ error: 'designMd required' });

  let imagePart = null;
  if (typeof sourceImage === 'string' && sourceImage.startsWith('data:image/')) {
    if (sourceImage.length > 14 * 1024 * 1024) {
      return res.status(413).json({ error: '源图过大（>14MB）' });
    }
    const m = sourceImage.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) imagePart = { inline_data: { mime_type: m[1], data: m[2] } };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 未配置' });

  let rulesData;
  try {
    rulesData = extractRules(designMd);
  } catch (e) {
    return res.status(400).json({ error: '规则提取失败: ' + e.message });
  }

  const PAGE_TEMPLATES = {
    // App 页面
    list: 'A mobile-style list page with search bar, filter tabs, list items (avatar + title + subtitle + right-side meta), clean hierarchy. 390px wide mobile viewport.',
    detail: 'A mobile-style detail page with back nav, hero image/amount, info card sections, primary action button at bottom. 390px wide.',
    profile: 'A mobile user profile page with cover banner, circular avatar, name + bio, stats row (posts/followers/following), tab bar, content feed. 390px wide.',
    settings: 'A mobile settings page with grouped menu sections (account, notifications, privacy, about), toggle switches, chevron arrows, logout button. 390px wide.',
    login: 'A mobile auth page with logo, login/signup tab toggle, email + password inputs, social login buttons (WeChat/Apple/Google), forgot password link. 390px wide.',
    onboarding: 'A mobile onboarding/welcome page with large illustration placeholder, headline, subtitle, dot indicators, "Next" button. 390px wide.',
    search: 'A mobile search page with large search bar, recent searches, trending tags as pills, category grid. 390px wide.',
    dashboard: 'A data-rich admin dashboard with nav, sidebar, 4 KPI cards, chart section, activity table.',
    // PPT 幻灯片
    pptCover: 'A 16:9 presentation cover slide (1280x720px). Large title centered, subtitle below, company logo top-left, minimal decorative element. Bold but clean.',
    pptContent: 'A 16:9 presentation content slide (1280x720px). Title at top, 3-column layout with icon + heading + paragraph in each column. Consistent spacing.',
    pptData: 'A 16:9 presentation data slide (1280x720px). Title at top, large bar chart or line chart using inline SVG, key metric callout number, source footnote.',
    pptQuote: 'A 16:9 presentation quote slide (1280x720px). Large quotation marks, quote text centered in large font, attribution below. Dramatic whitespace.',
    pptEnd: 'A 16:9 presentation closing slide (1280x720px). "Thank you" or "Q&A" centered, contact info, social links. Matches cover slide style.',
    // 专题页
    topicActivity: 'A long-scroll campaign/activity page: sticky nav, full-width hero banner with countdown timer, benefit cards grid, rules accordion, CTA button fixed at bottom. Chinese content.',
    topicLaunch: 'A product launch page: hero with product image + tagline, feature showcase (alternating left-right sections), specs table, pre-order CTA, footer.',
    topicLanding: 'A marketing landing page: sticky header, hero with headline + CTA, social proof bar (logos), 3-feature section, testimonials, pricing cards, FAQ, footer.'
  };
  const brief = PAGE_TEMPLATES[pageType] || PAGE_TEMPLATES.list;
  const constraints = rulesToPromptConstraints(rulesData.rules, rulesData.context);
  const trimmedMd = designMd.length > 3500 ? designMd.substring(0, 3500) + '\n(truncated)' : designMd;

  const prompt = `Generate a complete HTML page that matches the VISUAL PERSONALITY of the attached reference image${imagePart ? '' : ' (no image provided — use DESIGN.md only)'} and follows these hard constraints.

${imagePart ? `VISUAL REFERENCE (image attached):
Match the attached screenshot's visual personality: accent colors, card variety, use of imagery/illustrations/badges, information density, decorative elements, overall "feel". The DESIGN.md is a coarse text summary; when it conflicts with the image, TRUST THE IMAGE. Do NOT produce a minimal black-and-white list just because the dominant colors are dark — if the reference has yellow badges, pink pills, green tags, COLORFUL CARDS, MAPS, ILLUSTRATIONS, your output must have similar richness.

` : ''}${constraints}

DESIGN SYSTEM REFERENCE (text summary):
${trimmedMd}

PAGE TO GENERATE: ${brief}
${customPrompt ? `Additional context: ${customPrompt}` : ''}

QUALITY BAR (avoid "generic AI output"):
- DO NOT produce an empty monotonous list — vary card types, sizes, content
- Use accent colors as badges/pills/highlights (not just background)
- Include inline SVG for icons AND at least 2 decorative visual elements (gradient, illustration, chart, map placeholder)
- Information density should roughly match the reference image

OUTPUT RULES:
- Single HTML file, all CSS in <style>, start with <!DOCTYPE html>
- Inline SVG for icons
- Chinese placeholder content where natural (中文)
- Responsive (media query at 768px)
- NO explanation, NO code fences, ONLY the HTML starting with <!DOCTYPE html>`;

  const callGemini = (promptText, modelOrder) => new Promise((resolve, reject) => {
    const parts = [{ text: promptText }];
    if (imagePart) parts.push(imagePart);
    const payload = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 16384 }
    });
    const tryModel = (idx) => {
      if (idx >= modelOrder.length) return reject(new Error('all models exhausted'));
      const model = modelOrder[idx];
      console.log(`[gen-with-rules] Trying ${model} for ${pageType}`);
      let settled = false;
      const settle = () => { if (settled) return false; settled = true; return true; };
      const r = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 65000
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          if (!settle()) return;
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.log(`[gen-with-rules] ${model} error: ${json.error.message}`);
              return tryModel(idx + 1);
            }
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return tryModel(idx + 1);
            let cleaned = text;
            const fenceStart = cleaned.search(/```html?\s*\n/i);
            if (fenceStart >= 0) cleaned = cleaned.substring(cleaned.indexOf('\n', fenceStart) + 1);
            cleaned = cleaned.replace(/\n?```\s*$/i, '').trim();
            if (!/<\w+[\s>]/i.test(cleaned)) return tryModel(idx + 1);
            resolve({ html: cleaned, model });
          } catch (e) {
            console.log(`[gen-with-rules] parse error: ${e.message}`);
            tryModel(idx + 1);
          }
        });
      });
      r.on('error', () => { if (settle()) tryModel(idx + 1); });
      r.setTimeout(65000, () => { if (settle()) { r.destroy(); tryModel(idx + 1); } });
      r.write(payload);
      r.end();
    };
    tryModel(0);
  });

  const FIDELITY_THRESHOLD = parseInt(process.env.FIDELITY_THRESHOLD || '70', 10);
  try {
    const first = await callGemini(prompt, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    let bestHtml = first.html;
    let bestModel = first.model;
    let bestScore = scoreFidelity(bestHtml, designMd, rulesData);
    console.log(`[gen-with-rules] ${first.model} attempt1 fidelity ${bestScore.total}/100`);

    if (bestScore.total < FIDELITY_THRESHOLD) {
      const failed = bestScore.rulesResults.filter(r => !r.passed);
      const failDesc = failed.slice(0, 6).map(r => {
        const actual = r.actual == null ? '' : ` (got: ${JSON.stringify(r.actual)})`;
        return `- ${r.label}${actual}`;
      }).join('\n');
      const retryPrompt = `${prompt}

PREVIOUS ATTEMPT SCORED ${bestScore.total}/100 — BELOW ACCEPTABLE THRESHOLD.
Failed constraints:
${failDesc || '(see constraints above)'}
Produce a NEW version that passes these constraints. Use only the colors and font sizes listed. Keep whitespace generous. Respect the hierarchy described.`;
      try {
        const retry = await callGemini(retryPrompt, ['gemini-2.5-pro']);
        const retryScore = scoreFidelity(retry.html, designMd, rulesData);
        console.log(`[gen-with-rules] retry ${retry.model} fidelity ${retryScore.total}/100 (was ${bestScore.total})`);
        if (retryScore.total > bestScore.total) {
          bestHtml = retry.html;
          bestModel = retry.model;
          bestScore = retryScore;
        }
      } catch (e) {
        console.log(`[gen-with-rules] retry failed: ${e.message}, keeping original`);
      }
    }

    res.status(200).json({ html: bestHtml, model: bestModel, pageType, rules: rulesData.rules, score: bestScore });
  } catch (e) {
    res.status(503).json({ error: '所有 AI 模型暂时不可用，请稍后重试' });
  }
});

// ─── Gemini Vision: analyze screenshot into DESIGN.md ──────────
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, userPrompt } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '请上传一张图片' });
  if (typeof imageBase64 !== 'string') return res.status(400).json({ error: '图片数据格式无效' });

  // Validate base64 size (~10MB image ≈ ~13.3MB base64)
  if (imageBase64.length > 14 * 1024 * 1024) {
    return res.status(413).json({ error: '图片文件过大，请压缩后重试（最大 10MB）' });
  }

  // Validate MIME type from data URI
  const mimeMatch = imageBase64.match(/^data:([^;]+);base64,/);
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!mimeMatch || !allowed.includes(mimeMatch[1])) {
    return res.status(400).json({ error: '仅支持 PNG、JPG、WebP 格式的图片' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 未配置，请在 .env 文件中设置' });

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';

  const prompt = `You are a design systems expert. Analyze this UI screenshot and generate a complete DESIGN.md file following Google Stitch's format.

${userPrompt ? `User intent: ${userPrompt}\n\n` : ''}IMPORTANT rules:
- Use DESCRIPTIVE language, not raw CSS values. Say "pill-shaped" not "border-radius: 999px".
- For colors, include descriptive name + exact hex + functional role.
- Output ONLY the markdown content, no code fences, no explanation.
- Must have exactly 9 sections numbered 1-9.

Required format:

# Design System Inspiration from Screenshot

## 1. Visual Theme & Atmosphere
(2-3 paragraphs describing mood, style, brand feel)

**Key Characteristics:**
- (bullet points about defining traits)

## 2. Color Palette & Roles

### Primary
- **Color Name** (\`#HEX\`): Role and usage description
(list 6-10 colors grouped by role)

## 3. Typography Rules

### Font Family
- **Primary**: Font name
- **Secondary**: Font name
- **Monospace**: Font name

### Hierarchy
| Role | Font | Size | Weight | Notes |
|------|------|------|--------|-------|
(5-8 rows)

## 4. Component Stylings

### Buttons
- Background: \`#HEX\`
- Text: \`#HEX\`
- Radius: Xpx
(+ Cards, Inputs, Badges sections)

## 5. Layout Principles

### Spacing System
- Base unit: Xpx
- Scale: (list values)

### Border Radius Scale
- Micro/Standard/Comfortable/Relaxed/Large values

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
(4-5 rows describing shadow levels)

## 7. Do's and Don'ts

### Do
- (3-5 bullet points)

### Don't
- (3-5 bullet points)

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | <640px | ... |
| Tablet | 640-1024px | ... |
| Desktop | >1024px | ... |

## 9. Agent Prompt Guide

### Quick Color Reference
- (list 6-8 key colors by role)

### Iteration Guide
1. (numbered steps)

Now analyze the screenshot and generate the DESIGN.md:`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
  });

  // Fill in missing sections (6/8/9) with sensible defaults from extracted data
  const ensureCompleteness = (md) => {
    const hasSection = (num) => new RegExp(`^##\\s+${num}\\.`, 'm').test(md);
    // Pull colors from section 2 for reference
    const colorMatches = [...md.matchAll(/\*\*([^*]+)\*\*\s*\(`(#[0-9a-fA-F]+)`\)/g)];
    const colors = colorMatches.map(m => ({ name: m[1].trim(), hex: m[2] }));
    const primary = colors.find(c => /primary|cta|brand|accent/i.test(c.name))?.hex || colors[4]?.hex || colors[0]?.hex || '#7C5CFC';
    const bg = colors.find(c => /background|base|canvas/i.test(c.name))?.hex || colors[0]?.hex || '#FFFFFF';
    const text = colors.find(c => /text|foreground|heading/i.test(c.name))?.hex || colors[2]?.hex || '#111111';
    // Pull font from section 3
    const fontMatch = md.match(/\*\*Primary\*\*:\s*([^\n]+)/);
    const font = fontMatch ? fontMatch[1].replace(/`/g, '').trim() : 'Inter';

    let result = md;

    if (!hasSection(6)) {
      result += `\n\n## 6. Depth & Elevation\n\n| Level | Treatment | Use |\n|-------|-----------|-----|\n| Flat (Level 0) | No shadow | Page background, inline content |\n| Subtle (Level 1) | \`0 2px 4px rgba(0,0,0,0.05)\` | Card hover hints |\n| Standard (Level 2) | \`0 4px 12px rgba(0,0,0,0.1)\` | Standard cards, panels |\n| Elevated (Level 3) | \`0 12px 32px rgba(0,0,0,0.15)\` | Dropdowns, popovers |\n| Deep (Level 4) | \`0 20px 48px rgba(0,0,0,0.25)\` | Modals, overlays |\n\nShadows should remain subtle and serve to reinforce the visual hierarchy without overwhelming the clean aesthetic.\n`;
    }

    if (!hasSection(8)) {
      result += `\n\n## 8. Responsive Behavior\n\n### Breakpoints\n\n| Name | Width | Key Changes |\n|------|-------|-------------|\n| Mobile | <640px | Single column layout, reduced heading sizes, stacked cards |\n| Tablet | 640-1024px | 2-column grids, moderate padding |\n| Desktop | 1024-1280px | Full multi-zone layout, 3-column feature grids |\n| Large Desktop | >1280px | Centered content with generous side margins |\n\n### Collapsing Strategy\n- Hero typography: scales down proportionally (e.g., 56px → 40px → 32px)\n- Navigation: horizontal links collapse to hamburger menu on mobile\n- Multi-column grids: 3-col → 2-col → 1-col stacked\n- Section spacing: 64px+ desktop → 32px mobile\n`;
    }

    if (!hasSection(9)) {
      const refs = colors.slice(0, 6).map(c => `- ${c.name}: \`${c.hex}\``).join('\n');
      result += `\n\n## 9. Agent Prompt Guide\n\n### Quick Color Reference\n${refs || `- Primary: \`${primary}\`\n- Background: \`${bg}\`\n- Text: \`${text}\``}\n\n### Iteration Guide\n1. Use \`${font}\` consistently for all text elements, with appropriate weights from the typography hierarchy.\n2. Primary brand color is \`${primary}\` — use it for CTAs, active states, and key interactive elements.\n3. Background canvas is \`${bg}\`; place cards and panels on this foundation.\n4. Maintain the established spacing scale; do not introduce arbitrary values.\n5. Keep border-radius values within the defined scale; consistency is more important than variety.\n6. When in doubt, defer to the "Do's and Don'ts" section to stay on-brand.\n\n### Example Prompt\n"Build a hero section following DESIGN.md: ${bg} background, ${font} headline at the largest size from the hierarchy, ${primary} CTA button using the Standard radius and shadow Level 2."\n`;
    }

    return result;
  };

  // Try models in order of preference, fall back on overload
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-flash-latest',
    'gemini-pro-latest'
  ];

  let responded = false;
  const sendResponse = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  const tryModel = (modelIdx) => {
    if (responded) return;
    if (modelIdx >= models.length) {
      return sendResponse(503, { error: '所有 AI 模型暂时不可用，请稍后重试' });
    }
    const model = models[modelIdx];
    console.log(`[analyze-image] Trying ${model}...`);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    let settled = false;
    const settle = () => { if (settled) return false; settled = true; return true; };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (!settle()) return;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const code = response.statusCode;
            const msg = json.error.message || '';
            console.log(`[analyze-image] ${model} error (${code}): ${msg}`);
            if (code === 401 || code === 403) {
              return sendResponse(500, { error: 'Gemini API 密钥无效或权限不足，请检查配置' });
            }
            if (code === 429) {
              if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
              return sendResponse(429, { error: 'Gemini API 调用次数超限，请稍后重试' });
            }
            if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
            return sendResponse(500, { error: 'AI 分析服务暂时不可用，请稍后重试' });
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            const reason = json.candidates?.[0]?.finishReason || 'empty';
            console.log(`[analyze-image] ${model}: empty response (${reason})`);
            if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
            return sendResponse(500, { error: 'AI 未能识别截图内容，请尝试更清晰的截图' });
          }
          const cleaned = text.replace(/^```markdown?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          const complete = ensureCompleteness(cleaned);
          console.log(`[analyze-image] ${model} success, ${complete.length} chars`);
          sendResponse(200, { content: complete, model });
        } catch (e) {
          console.error(`[analyze-image] ${model} parse error:`, e.message, data.substring(0, 200));
          if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
          sendResponse(500, { error: 'AI 响应解析失败，请重试' });
        }
      });
    });

    request.on('error', (err) => {
      if (!settle()) return;
      console.error(`[analyze-image] ${model} network error:`, err.message);
      if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
      sendResponse(500, { error: '无法连接 AI 服务，请检查网络连接' });
    });

    request.setTimeout(120000, () => {
      if (!settle()) return;
      console.log(`[analyze-image] ${model} timeout`);
      request.destroy();
      if (modelIdx < models.length - 1) return tryModel(modelIdx + 1);
      sendResponse(504, { error: 'AI 分析超时，请稍后重试' });
    });

    request.write(payload);
    request.end();
  };

  tryModel(0);
});

// Template catalog
const TEMPLATES_DIR = path.join(__dirname, 'templates');

const TEMPLATE_META = {
  airbnb: { name: 'Airbnb', category: 'Consumer', desc: 'Travel & hospitality' },
  airtable: { name: 'Airtable', category: 'Productivity', desc: 'Spreadsheet-database hybrid' },
  apple: { name: 'Apple', category: 'Consumer', desc: 'Premium hardware & software' },
  bmw: { name: 'BMW', category: 'Automotive', desc: 'Luxury automotive' },
  cal: { name: 'Cal.com', category: 'Developer', desc: 'Scheduling infrastructure' },
  claude: { name: 'Claude', category: 'AI', desc: 'AI assistant by Anthropic' },
  clay: { name: 'Clay', category: 'Enterprise', desc: 'Data enrichment' },
  clickhouse: { name: 'ClickHouse', category: 'Infrastructure', desc: 'Analytics database' },
  cohere: { name: 'Cohere', category: 'AI', desc: 'Enterprise AI platform' },
  coinbase: { name: 'Coinbase', category: 'Fintech', desc: 'Crypto exchange' },
  composio: { name: 'Composio', category: 'Developer', desc: 'AI agent tooling' },
  cursor: { name: 'Cursor', category: 'Developer', desc: 'AI code editor' },
  elevenlabs: { name: 'ElevenLabs', category: 'AI', desc: 'Voice AI' },
  expo: { name: 'Expo', category: 'Developer', desc: 'React Native framework' },
  ferrari: { name: 'Ferrari', category: 'Automotive', desc: 'Luxury sports cars' },
  figma: { name: 'Figma', category: 'Design', desc: 'Collaborative design tool' },
  framer: { name: 'Framer', category: 'Design', desc: 'Website builder' },
  hashicorp: { name: 'HashiCorp', category: 'Infrastructure', desc: 'Infrastructure automation' },
  ibm: { name: 'IBM', category: 'Enterprise', desc: 'Enterprise technology' },
  intercom: { name: 'Intercom', category: 'Enterprise', desc: 'Customer messaging' },
  kraken: { name: 'Kraken', category: 'Fintech', desc: 'Crypto exchange' },
  lamborghini: { name: 'Lamborghini', category: 'Automotive', desc: 'Supercar manufacturer' },
  'linear.app': { name: 'Linear', category: 'Developer', desc: 'Project management' },
  lovable: { name: 'Lovable', category: 'Developer', desc: 'AI app builder' },
  minimax: { name: 'MiniMax', category: 'AI', desc: 'AI model provider' },
  mintlify: { name: 'Mintlify', category: 'Developer', desc: 'Documentation platform' },
  miro: { name: 'Miro', category: 'Productivity', desc: 'Visual collaboration' },
  'mistral.ai': { name: 'Mistral AI', category: 'AI', desc: 'Open-weight LLMs' },
  mongodb: { name: 'MongoDB', category: 'Infrastructure', desc: 'Document database' },
  notion: { name: 'Notion', category: 'Productivity', desc: 'All-in-one workspace' },
  nvidia: { name: 'NVIDIA', category: 'Infrastructure', desc: 'GPU computing' },
  ollama: { name: 'Ollama', category: 'AI', desc: 'Local LLM runner' },
  'opencode.ai': { name: 'OpenCode', category: 'Developer', desc: 'AI coding' },
  pinterest: { name: 'Pinterest', category: 'Consumer', desc: 'Visual discovery' },
  posthog: { name: 'PostHog', category: 'Developer', desc: 'Product analytics' },
  raycast: { name: 'Raycast', category: 'Developer', desc: 'Productivity launcher' },
  renault: { name: 'Renault', category: 'Automotive', desc: 'Automotive manufacturer' },
  replicate: { name: 'Replicate', category: 'AI', desc: 'ML model hosting' },
  resend: { name: 'Resend', category: 'Developer', desc: 'Email for developers' },
  revolut: { name: 'Revolut', category: 'Fintech', desc: 'Digital banking' },
  runwayml: { name: 'Runway', category: 'AI', desc: 'AI video generation' },
  sanity: { name: 'Sanity', category: 'Developer', desc: 'Content platform' },
  semrush: { name: 'Semrush', category: 'Enterprise', desc: 'Marketing toolkit' },
  sentry: { name: 'Sentry', category: 'Developer', desc: 'Error monitoring' },
  spacex: { name: 'SpaceX', category: 'Consumer', desc: 'Space technology' },
  spotify: { name: 'Spotify', category: 'Consumer', desc: 'Music streaming' },
  stripe: { name: 'Stripe', category: 'Fintech', desc: 'Payment infrastructure' },
  supabase: { name: 'Supabase', category: 'Developer', desc: 'Open-source Firebase' },
  superhuman: { name: 'Superhuman', category: 'Productivity', desc: 'Email client' },
  tesla: { name: 'Tesla', category: 'Automotive', desc: 'Electric vehicles' },
  'together.ai': { name: 'Together AI', category: 'AI', desc: 'AI inference' },
  uber: { name: 'Uber', category: 'Consumer', desc: 'Ride-hailing' },
  vercel: { name: 'Vercel', category: 'Developer', desc: 'Frontend cloud' },
  voltagent: { name: 'VoltAgent', category: 'Developer', desc: 'AI agent framework' },
  warp: { name: 'Warp', category: 'Developer', desc: 'AI terminal' },
  webflow: { name: 'Webflow', category: 'Design', desc: 'Visual web builder' },
  wise: { name: 'Wise', category: 'Fintech', desc: 'International transfers' },
  'x.ai': { name: 'xAI', category: 'AI', desc: 'Grok AI' },
  zapier: { name: 'Zapier', category: 'Productivity', desc: 'Workflow automation' }
};

// List all available templates
app.get('/api/templates', (req, res) => {
  const templates = Object.entries(TEMPLATE_META).map(([id, meta]) => ({
    id,
    ...meta,
    installed: fs.existsSync(path.join(TEMPLATES_DIR, id, 'DESIGN.md'))
  }));
  res.json(templates);
});

// Get a template's DESIGN.md content
app.get('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  if (!TEMPLATE_META[id]) return res.status(404).json({ error: '模版不存在' });

  const filePath = path.join(TEMPLATES_DIR, id, 'DESIGN.md');

  // If already downloaded, serve it
  if (fs.existsSync(filePath)) {
    const cached = fs.readFileSync(filePath, 'utf-8');
    if (cached && cached.length > 100) {
      return res.json({ content: cached });
    }
    // Cached file is invalid, remove and re-download
    fs.unlinkSync(filePath);
  }

  // Download via npx getdesign
  const tmpDir = `/tmp/designmd_${Date.now()}`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    let npxError = null;
    try {
      execSync(`npx getdesign@latest add ${id}`, {
        cwd: tmpDir,
        timeout: 30000,
        stdio: 'pipe',
        env: { ...process.env, HOME: tmpDir }
      });
    } catch (e) {
      npxError = e;
      console.log(`[template] npx getdesign add ${id} failed: ${e.message?.substring(0, 200)}`);
    }

    // Search for the file in multiple locations
    const searchPaths = [
      path.join(tmpDir, 'DESIGN.md'),
      path.join(tmpDir, id, 'DESIGN.md'),
      path.join(tmpDir, 'node_modules', '.cache', id, 'DESIGN.md')
    ];

    let content = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        content = fs.readFileSync(p, 'utf-8');
        break;
      }
    }

    // Also search recursively
    if (!content) {
      try {
        const result = execSync(`find ${tmpDir} -name "DESIGN.md" -type f 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim();
        if (result && fs.existsSync(result)) {
          content = fs.readFileSync(result, 'utf-8');
        }
      } catch {}
    }

    // Cleanup tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Validate content: must be >100 chars and contain at least one ## heading
    if (content && content.length > 100 && /^##\s+/m.test(content)) {
      fs.mkdirSync(path.join(TEMPLATES_DIR, id), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return res.json({ content });
    }

    // Determine specific error
    if (npxError && /ETIMEDOUT|timeout/i.test(npxError.message)) {
      return res.status(504).json({ error: '模版下载超时，请稍后重试' });
    }
    if (content && content.length <= 100) {
      return res.status(502).json({ error: '模版内容不完整，请稍后重试' });
    }
    res.status(500).json({ error: '模版下载失败，请稍后重试' });
  } catch (err) {
    // Cleanup on error
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.error('Template fetch error:', err.message);
    res.status(500).json({ error: '获取模版失败，请稍后重试' });
  }
});

// ─── Gemini: AI edit DESIGN.md with natural language ──────────
app.post('/api/edit-design', async (req, res) => {
  const { designMd, command } = req.body;
  if (!designMd || !command) return res.status(400).json({ error: 'designMd and command required' });
  if (typeof designMd !== 'string' || typeof command !== 'string') return res.status(400).json({ error: 'designMd and command must be strings' });
  if (!command.trim()) return res.status(400).json({ error: '编辑指令不能为空' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let trimmedDesignMd = designMd;
  if (designMd.length > 8000) {
    console.warn(`[edit-design] designMd truncated from ${designMd.length} to 8000 chars`);
    trimmedDesignMd = designMd.substring(0, 8000) + '\n(truncated)';
  }

  const prompt = `You are a design system editor. The user wants to modify this DESIGN.md file.

CURRENT DESIGN.MD:
${trimmedDesignMd}

USER COMMAND: ${command}

RULES:
- Apply the user's requested change to the DESIGN.md
- Keep the same 9-section structure and markdown format
- Only modify sections relevant to the command
- If the user says "改成" / "变成" / "change to", update the specific value
- If the user says "加" / "添加" / "add", insert new content in the appropriate section
- If the user says "删" / "去掉" / "remove", remove the specified content
- Common changes: colors, fonts, border-radius, shadows, spacing, components, do's/don'ts
- Output ONLY the complete modified DESIGN.md, no explanation, no code fences
- Preserve all existing content that wasn't changed`;

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  });

  const models = ['gemini-2.5-flash', 'gemini-2.5-pro'];
  let lastError = '';
  let responded = false;
  const send = (status, body) => { if (responded) return; responded = true; res.status(status).json(body); };

  const tryModel = (idx) => {
    if (responded) return;
    if (idx >= models.length) {
      return send(503, { error: lastError || '所有 AI 模型暂时不可用，请稍后重试' });
    }
    const model = models[idx];
    console.log(`[edit-design] Trying ${model}: "${command}"`);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000
    };
    let settled = false;
    const settle = () => { if (settled) return false; settled = true; return true; };
    const r = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (!settle()) return;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const code = resp.statusCode;
            lastError = json.error.message || 'API error';
            console.log(`[edit-design] ${model} error (${code}): ${lastError}`);
            if (code === 401 || code === 403) return send(500, { error: 'Gemini API 密钥无效或权限不足，请检查配置' });
            if (code === 429) { if (idx < models.length - 1) return tryModel(idx + 1); return send(429, { error: 'AI 调用次数超限，请稍后重试' }); }
            return tryModel(idx + 1);
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            lastError = `${model}: empty response`;
            if (idx < models.length - 1) return tryModel(idx + 1);
            return send(500, { error: 'AI 未能生成修改结果，请重试' });
          }
          const cleaned = text.replace(/^```markdown?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          console.log(`[edit-design] ${model} success, ${cleaned.length} chars`);
          send(200, { content: cleaned, model });
        } catch (e) {
          lastError = `Parse error: ${e.message}`;
          if (idx < models.length - 1) return tryModel(idx + 1);
          send(500, { error: 'AI 响应解析失败，请重试' });
        }
      });
    });
    r.on('error', (err) => { if (!settle()) return; lastError = err.message; if (idx < models.length - 1) return tryModel(idx + 1); send(500, { error: '无法连接 AI 服务，请检查网络' }); });
    r.setTimeout(60000, () => { if (!settle()) return; lastError = `${model} timeout`; r.destroy(); if (idx < models.length - 1) return tryModel(idx + 1); send(504, { error: 'AI 编辑超时，请稍后重试' }); });
    r.write(payload);
    r.end();
  };

  tryModel(0);
});

// Extract design language from URL using puppeteer
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (typeof url !== 'string') return res.status(400).json({ error: 'URL must be a string' });
  if (url.length > 2048) return res.status(400).json({ error: 'URL 过长，请检查输入' });

  // Validate URL format
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: '仅支持 http/https 协议的网址' });
    }
  } catch {
    return res.status(400).json({ error: 'URL 格式无效，请输入正确的网址' });
  }

  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const designData = await page.evaluate(() => {
      const allElements = document.querySelectorAll('*');
      const colors = new Map();
      const fonts = new Map();
      const fontSizes = new Set();
      const borderRadii = new Set();
      const shadows = new Set();
      const spacings = new Set();
      const fontWeights = new Set();
      const lineHeights = new Set();
      const letterSpacings = new Set();

      for (const el of allElements) {
        const style = getComputedStyle(el);

        const bg = style.backgroundColor;
        const fg = style.color;
        const border = style.borderColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          colors.set(bg, (colors.get(bg) || 0) + 1);
        }
        if (fg) colors.set(fg, (colors.get(fg) || 0) + 1);
        if (border && border !== 'rgba(0, 0, 0, 0)' && border !== fg) {
          colors.set(border, (colors.get(border) || 0) + 1);
        }

        const ff = style.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
        if (ff) fonts.set(ff, (fonts.get(ff) || 0) + 1);

        const fs = parseFloat(style.fontSize);
        if (fs > 0) fontSizes.add(fs);

        const fw = style.fontWeight;
        if (fw) fontWeights.add(fw);

        const lh = style.lineHeight;
        if (lh && lh !== 'normal') lineHeights.add(lh);

        const ls = style.letterSpacing;
        if (ls && ls !== 'normal' && ls !== '0px') letterSpacings.add(ls);

        const br = style.borderRadius;
        if (br && br !== '0px') borderRadii.add(br);

        const bs = style.boxShadow;
        if (bs && bs !== 'none') shadows.add(bs);

        const pt = parseFloat(style.paddingTop);
        const pb = parseFloat(style.paddingBottom);
        const pl = parseFloat(style.paddingLeft);
        const pr = parseFloat(style.paddingRight);
        [pt, pb, pl, pr].forEach(v => { if (v > 0 && v <= 128) spacings.add(v); });
      }

      function rgbaToHex(rgba) {
        const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return rgba;
        const r = parseInt(match[1]).toString(16).padStart(2, '0');
        const g = parseInt(match[2]).toString(16).padStart(2, '0');
        const b = parseInt(match[3]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`.toUpperCase();
      }

      const sortedColors = [...colors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([c, count]) => ({ value: rgbaToHex(c), count, raw: c }));

      const sortedFonts = [...fonts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f, count]) => ({ name: f, count }));

      const sortedSizes = [...fontSizes].sort((a, b) => a - b);
      const sortedRadii = [...borderRadii].slice(0, 8);
      const sortedSpacings = [...new Set([...spacings].map(v => Math.round(v / 4) * 4))]
        .filter(v => v > 0)
        .sort((a, b) => a - b)
        .slice(0, 10);

      return {
        colors: sortedColors,
        fonts: sortedFonts,
        fontSizes: sortedSizes,
        fontWeights: [...fontWeights].sort(),
        borderRadii: sortedRadii,
        shadows: [...shadows].slice(0, 6),
        spacings: sortedSpacings,
        letterSpacings: [...letterSpacings].slice(0, 5),
        title: document.title
      };
    });

    await browser.close();
    browser = null;
    res.json(designData);
  } catch (err) {
    console.error('[extract] Error:', err.message);
    // Classify Puppeteer errors into user-friendly messages with proper HTTP status codes
    const msg = err.message || '';
    let userMsg, statusCode;
    if (msg.includes('TimeoutError') || msg.includes('timeout') || msg.includes('Navigation timeout')) {
      userMsg = '页面加载超时，该网站响应过慢，请稍后重试';
      statusCode = 504;
    } else if (msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('getaddrinfo')) {
      userMsg = '域名无法解析，请检查网址是否正确';
      statusCode = 502;
    } else if (msg.includes('ERR_SSL') || msg.includes('SSL') || msg.includes('certificate')) {
      userMsg = '该网站 SSL 证书有问题，无法安全连接';
      statusCode = 502;
    } else if (msg.includes('ERR_CONNECTION_REFUSED')) {
      userMsg = '连接被拒绝，该网站可能已下线';
      statusCode = 502;
    } else if (msg.includes('ERR_CONNECTION_RESET') || msg.includes('ECONNRESET')) {
      userMsg = '连接被重置，请稍后重试';
      statusCode = 502;
    } else if (msg.includes('ERR_INTERNET_DISCONNECTED') || msg.includes('ENETUNREACH')) {
      userMsg = '网络不可用，请检查网络连接';
      statusCode = 502;
    } else if (msg.includes('Failed to launch') || msg.includes('Could not find') || msg.includes('spawn') || msg.includes('ENOENT')) {
      userMsg = '浏览器引擎启动失败，请检查 Puppeteer 安装';
      statusCode = 500;
    } else {
      userMsg = '无法访问该网站: ' + msg;
      statusCode = 500;
    }
    res.status(statusCode).json({ error: userMsg });
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
});

// ─── Global Express error handler ──────────
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大（超过 15MB），请减小文件大小后重试' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体格式无效，请检查输入' });
  }
  console.error('[express error]', err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  }
});

// ─── Process crash handlers ──────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.listen(PORT, () => {
  console.log(`DesignMD Tool running on http://localhost:${PORT}`);
});
