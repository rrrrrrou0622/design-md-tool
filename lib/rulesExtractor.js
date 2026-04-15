// Extract "Rules Contract" from a DESIGN.md.
// Reads the existing 9-section Stitch format and distills it into 5 enforceable rules.
// Does not modify DESIGN.md itself — only derives rules at generation time.

function extractSection(md, headingPattern) {
  const re = new RegExp(`##\\s+${headingPattern}[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
  const m = md.match(re);
  return m ? m[0] : '';
}

function countAccentColors(md) {
  const colorSection = extractSection(md, '2\\.\\s*Color');
  // Count colors marked as primary / accent / cta / brand
  const accentPattern = /\*\*[^*]*(?:primary|accent|cta|brand)[^*]*\*\*\s*\(`(#[0-9a-fA-F]+)`\)/gi;
  const matches = [...colorSection.matchAll(accentPattern)];
  return Math.max(1, new Set(matches.map(m => m[1].toUpperCase())).size);
}

function extractPrimaryRadius(md) {
  const section = extractSection(md, '(5\\.\\s*Layout|Border Radius)');
  const radii = (section.match(/\d+px/g) || []).map(r => parseInt(r)).filter(n => n > 0 && n <= 64);
  if (!radii.length) return 8;
  // Most common radius (mode), fallback to smallest
  const counts = {};
  radii.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return parseInt(sorted[0][0]);
}

function extractTitleWeight(md) {
  const section = extractSection(md, '3\\.\\s*Typography');
  const weightMatch = section.match(/(?:h1|heading|title|display)[^\n]*?(\d{3}|thin|light|regular|medium|semibold|semi-bold|bold|extrabold|black)/i);
  if (!weightMatch) return 'medium';
  const w = weightMatch[1].toLowerCase();
  if (/^\d+$/.test(w)) {
    const n = parseInt(w);
    if (n <= 300) return 'light';
    if (n <= 450) return 'regular';
    if (n <= 550) return 'medium';
    if (n <= 650) return 'semibold';
    return 'bold';
  }
  return w.replace('semi-bold', 'semibold');
}

function extractWhitespaceTarget(md) {
  const section = extractSection(md, '(5\\.\\s*Layout|Spacing)');
  const spacings = (section.match(/\d+px/g) || []).map(s => parseInt(s)).filter(n => n > 0);
  if (!spacings.length) return 30;
  const maxSpacing = Math.max(...spacings);
  // If the source uses generous spacing, require more whitespace in output
  if (maxSpacing >= 80) return 45;
  if (maxSpacing >= 48) return 40;
  if (maxSpacing >= 32) return 35;
  return 30;
}

function extractDominantColors(md) {
  const colorSection = extractSection(md, '2\\.\\s*Color');
  const hexes = colorSection.match(/#[0-9a-fA-F]{6}/g) || [];
  return [...new Set(hexes.map(h => h.toUpperCase()))].slice(0, 8);
}

function extractPrimaryFont(md) {
  const section = extractSection(md, '3\\.\\s*Typography');
  const m = section.match(/\*\*Primary\*\*:\s*([^\n]+)/i);
  if (m) return m[1].replace(/`/g, '').trim().split(',')[0].trim();
  return 'Inter';
}

function extractRules(designMd) {
  if (!designMd || typeof designMd !== 'string') {
    throw new Error('designMd must be a non-empty string');
  }

  const accentCount = countAccentColors(designMd);
  const primaryRadius = extractPrimaryRadius(designMd);
  const titleWeight = extractTitleWeight(designMd);
  const whitespaceTarget = extractWhitespaceTarget(designMd);
  const dominantColors = extractDominantColors(designMd);
  const primaryFont = extractPrimaryFont(designMd);

  const isBoldTitle = /bold|black|extrabold/i.test(titleWeight);

  const rules = [
    {
      id: 'accent-colors',
      label: `每屏不超过 ${accentCount} 种强调色`,
      metric: 'accentCount',
      target: accentCount
    },
    {
      id: 'corner-radius',
      label: `圆角统一 ${primaryRadius}px，不混用`,
      metric: 'radiusConsistency',
      target: primaryRadius
    },
    {
      id: 'title-weight',
      label: isBoldTitle
        ? `标题用 ${titleWeight} 字重`
        : `标题用 ${titleWeight} 字重，不用 Bold`,
      metric: 'titleWeight',
      target: titleWeight
    },
    {
      id: 'whitespace',
      label: `留白占比 ≥ ${whitespaceTarget}%`,
      metric: 'whitespacePercent',
      target: whitespaceTarget
    },
    {
      id: 'focal-points',
      label: '每页最多 3 个视觉焦点',
      metric: 'focalPoints',
      target: 3
    }
  ];

  return {
    rules,
    context: {
      dominantColors,
      primaryFont,
      primaryRadius,
      titleWeight,
      whitespaceTarget,
      accentCount
    }
  };
}

function rulesToPromptConstraints(rules, context) {
  const lines = rules.map(r => `- ${r.label}`);
  const colorList = context.dominantColors.slice(0, 5).join(', ');
  return [
    'HARD DESIGN CONSTRAINTS (follow exactly, do not deviate):',
    ...lines,
    `- Use colors from this palette only: ${colorList}`,
    `- Primary font family: ${context.primaryFont}`,
    `- All interactive elements (buttons, inputs, cards) use exactly ${context.primaryRadius}px border-radius`,
    `- Use font-weight: ${context.titleWeight === 'light' ? 300 : context.titleWeight === 'regular' ? 400 : context.titleWeight === 'medium' ? 500 : context.titleWeight === 'semibold' ? 600 : 700} for all h1/h2/h3 titles`,
    'Output HTML must visibly honor these constraints. Prefer generous whitespace over dense layouts.'
  ].join('\n');
}

module.exports = { extractRules, rulesToPromptConstraints };
