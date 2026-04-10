const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Gemini Vision: analyze screenshot into DESIGN.md ──────────
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, userPrompt } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Image required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

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
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
  });

  // Try models in order of preference, fall back on overload
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-flash-latest',
    'gemini-pro-latest'
  ];

  const tryModel = (modelIdx) => {
    if (modelIdx >= models.length) {
      return res.status(503).json({ error: 'All Gemini models overloaded, please try again later' });
    }
    const model = models[modelIdx];
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const msg = json.error.message || '';
            console.log(`${model} error (${response.statusCode}): ${msg}`);
            // Try next model on any recoverable error
            if (modelIdx < models.length - 1) {
              return tryModel(modelIdx + 1);
            }
            return res.status(500).json({ error: msg || 'Gemini API error' });
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            // Some models return empty when image rejected — try next
            return tryModel(modelIdx + 1);
          }
          // Strip markdown code fences if present
          const cleaned = text.replace(/^```markdown?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          res.json({ content: cleaned, model });
        } catch (e) {
          console.error('Parse error:', e, data.substring(0, 500));
          tryModel(modelIdx + 1);
        }
      });
    });

    request.on('error', (err) => {
      console.error(`${model} request error:`, err);
      tryModel(modelIdx + 1);
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
  if (!TEMPLATE_META[id]) return res.status(404).json({ error: 'Template not found' });

  const filePath = path.join(TEMPLATES_DIR, id, 'DESIGN.md');

  // If already downloaded, serve it
  if (fs.existsSync(filePath)) {
    return res.json({ content: fs.readFileSync(filePath, 'utf-8') });
  }

  // Download via fetch from getdesign.md API
  try {
    const https = require('https');
    const fetchMd = (url) => new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'DesignMD-Tool' } }, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          return fetchMd(resp.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resp.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${resp.statusCode}`)));
      }).on('error', reject);
    });

    // Try npx in isolated tmp dir
    const tmpDir = `/tmp/designmd_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      execSync(`npx getdesign@latest add ${id}`, {
        cwd: tmpDir,
        timeout: 30000,
        stdio: 'pipe',
        env: { ...process.env, HOME: tmpDir }
      });
    } catch {}

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

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (content && content.length > 100) {
      fs.mkdirSync(path.join(TEMPLATES_DIR, id), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return res.json({ content });
    }

    res.status(500).json({ error: '模版下载失败，请稍后重试' });
  } catch (err) {
    console.error('Template fetch error:', err.message);
    res.status(500).json({ error: '获取模版失败: ' + err.message });
  }
});

// Extract design language from URL using puppeteer
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
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
    res.json(designData);
  } catch (err) {
    console.error('Extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`DesignMD Tool running on http://localhost:${PORT}`);
});
