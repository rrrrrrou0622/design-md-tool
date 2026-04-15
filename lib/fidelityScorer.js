// Score how faithfully generated HTML follows a source DESIGN.md.
// Returns a total score (0-100) across 3 dimensions + per-rule pass/fail.
// Regex-based analysis only — no puppeteer/DOM rendering (fast, cheap).

const { extractRules } = require('./rulesExtractor');

function hexesIn(str) {
  return (str.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
    .map(h => h.toUpperCase())
    .filter(h => h.length === 4 || h.length === 7); // skip 8-digit alpha hex
}

function expandShortHex(h) {
  if (h.length === 4) {
    return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  return h;
}

function hexDistance(a, b) {
  const ra = parseInt(a.slice(1, 3), 16), ga = parseInt(a.slice(3, 5), 16), ba = parseInt(a.slice(5, 7), 16);
  const rb = parseInt(b.slice(1, 3), 16), gb = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  return Math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2);
}

function scoreColor(html, sourceColors) {
  if (!sourceColors.length) return 70;
  const genColors = [...new Set(hexesIn(html).map(expandShortHex))];
  if (!genColors.length) return 50;
  // For each generated color, find nearest source color
  let matched = 0;
  for (const g of genColors) {
    const nearest = Math.min(...sourceColors.map(s => hexDistance(g, s)));
    if (nearest < 40) matched++;
  }
  return Math.round((matched / genColors.length) * 100);
}

function scoreDensity(html, targetWhitespace) {
  // Crude whitespace heuristic: ratio of padding/margin/gap CSS values to content length
  const paddings = (html.match(/(?:padding|margin|gap)\s*:\s*([\d.]+)(?:px|rem)/gi) || [])
    .map(m => parseFloat(m.match(/[\d.]+/)[0]))
    .filter(n => n > 0);
  if (!paddings.length) return 50;
  const avgSpacing = paddings.reduce((a, b) => a + b, 0) / paddings.length;
  // Expected: avgSpacing ~16-32 = tight, 32-48 = normal, 48+ = generous
  const actualPercent = Math.min(60, Math.round(avgSpacing * 1.0 + 20));
  const diff = Math.abs(actualPercent - targetWhitespace);
  const score = Math.max(0, 100 - diff * 2);
  return Math.round(score);
}

function scoreHierarchy(html, context) {
  // Check that headings actually use the declared title weight
  const headings = html.match(/<h[1-3][^>]*>/gi) || [];
  if (!headings.length) return 70;

  const weightTargets = {
    light: [300],
    regular: [400],
    medium: [500],
    semibold: [600],
    bold: [700]
  };
  const targetWeights = weightTargets[context.titleWeight] || [400, 500];

  let matched = 0;
  for (const h of headings) {
    const wMatch = h.match(/font-weight\s*:\s*(\d{3}|light|regular|medium|semibold|bold|\d)/i);
    if (!wMatch) { matched++; continue; } // if not specified, defer to inherited/unspecified — assume ok
    const w = wMatch[1];
    const weightNum = /^\d+$/.test(w) ? parseInt(w) : { light: 300, regular: 400, medium: 500, semibold: 600, bold: 700 }[w.toLowerCase()];
    if (targetWeights.some(t => Math.abs(t - weightNum) <= 50)) matched++;
  }
  return Math.round((matched / headings.length) * 100);
}

function evaluateRules(html, rules, context, sourceColors) {
  return rules.map(rule => {
    switch (rule.id) {
      case 'accent-colors': {
        const genColors = [...new Set(hexesIn(html).map(expandShortHex))];
        const neutrals = ['#FFFFFF', '#000000', '#F5F5F5', '#FAFAFA', '#F0F0F0', '#E5E5E5', '#D4D4D4', '#A1A1AA', '#71717A', '#52525B', '#3F3F46', '#27272A', '#18181B'];
        const accents = genColors.filter(c => !neutrals.some(n => hexDistance(c, n) < 30));
        return {
          id: rule.id,
          label: rule.label,
          passed: accents.length <= rule.target + 1,
          actual: accents.length,
          target: rule.target,
          severity: accents.length <= rule.target + 1 ? 'ok' : (accents.length <= rule.target + 3 ? 'warning' : 'fail')
        };
      }
      case 'corner-radius': {
        const radii = [...new Set((html.match(/border-radius\s*:\s*([\d.]+)px/gi) || [])
          .map(m => Math.round(parseFloat(m.match(/[\d.]+/)[0]))))];
        const close = radii.filter(r => Math.abs(r - rule.target) <= 2);
        const ratio = radii.length ? close.length / radii.length : 1;
        return {
          id: rule.id,
          label: rule.label,
          passed: ratio >= 0.6,
          actual: radii.join(','),
          target: `${rule.target}px`,
          severity: ratio >= 0.8 ? 'ok' : (ratio >= 0.5 ? 'warning' : 'fail')
        };
      }
      case 'title-weight': {
        const weightMap = { light: 300, regular: 400, medium: 500, semibold: 600, bold: 700 };
        const targetNum = weightMap[rule.target] || 500;
        const headings = html.match(/<h[1-3][^>]*style="[^"]*font-weight\s*:\s*(\d{3}|light|regular|medium|semibold|bold)/gi) || [];
        let matchCount = 0;
        headings.forEach(h => {
          const m = h.match(/font-weight\s*:\s*(\d{3}|light|regular|medium|semibold|bold)/i);
          if (!m) return;
          const w = /^\d+$/.test(m[1]) ? parseInt(m[1]) : weightMap[m[1].toLowerCase()];
          if (Math.abs(w - targetNum) <= 50) matchCount++;
        });
        const ratio = headings.length ? matchCount / headings.length : 1;
        return {
          id: rule.id,
          label: rule.label,
          passed: ratio >= 0.5 || headings.length === 0,
          actual: rule.target,
          target: rule.target,
          severity: ratio >= 0.7 || headings.length === 0 ? 'ok' : 'warning'
        };
      }
      case 'whitespace': {
        const paddings = (html.match(/(?:padding|margin|gap)\s*:\s*([\d.]+)(?:px|rem)/gi) || [])
          .map(m => parseFloat(m.match(/[\d.]+/)[0]));
        const avg = paddings.length ? paddings.reduce((a, b) => a + b, 0) / paddings.length : 0;
        const actualPercent = Math.min(60, Math.round(avg + 20));
        return {
          id: rule.id,
          label: rule.label,
          passed: actualPercent >= rule.target,
          actual: `${actualPercent}%`,
          target: `${rule.target}%`,
          severity: actualPercent >= rule.target ? 'ok' : (actualPercent >= rule.target - 5 ? 'warning' : 'fail')
        };
      }
      case 'focal-points': {
        const ctas = (html.match(/<(button|a)\b[^>]*class="[^"]*(btn|cta|button|primary)/gi) || []).length;
        return {
          id: rule.id,
          label: rule.label,
          passed: ctas <= rule.target * 3,
          actual: ctas,
          target: rule.target,
          severity: ctas <= rule.target * 2 ? 'ok' : (ctas <= rule.target * 3 ? 'warning' : 'fail')
        };
      }
      default:
        return { id: rule.id, label: rule.label, passed: true, actual: null, target: rule.target, severity: 'ok' };
    }
  });
}

function scoreFidelity(html, designMd, precomputedRules) {
  if (!html || !designMd) throw new Error('html and designMd required');

  const { rules, context } = precomputedRules || extractRules(designMd);
  const sourceColors = context.dominantColors;

  const color = scoreColor(html, sourceColors);
  const density = scoreDensity(html, context.whitespaceTarget);
  const hierarchy = scoreHierarchy(html, context);
  const total = Math.round((color + density + hierarchy) / 3);

  const rulesResults = evaluateRules(html, rules, context, sourceColors);

  return {
    total,
    dimensions: { color, density, hierarchy },
    rulesResults
  };
}

module.exports = { scoreFidelity };
