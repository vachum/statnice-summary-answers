const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MarkdownIt = require("markdown-it");
const katex = require("katex");
const hljs = require("highlight.js");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "pdf");
const HTML_DIR = path.join(OUTPUT_DIR, "_html");
const CHROME_EXECUTABLE =
  "/Users/vachum/.cache/puppeteer/chrome/mac_arm-138.0.7204.168/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const KATEX_CSS = "/tmp/study-pdf-deps/node_modules/katex/dist/katex.min.css";
const KATEX_FONTS = "/tmp/study-pdf-deps/node_modules/katex/dist/fonts";

const SUBJECTS = {
  IT: {
    label: "Informační technologie",
    short: "IT",
    subtitle: "Architektura, infrastruktura a bezpečnost informačních technologií",
    accent: "#0f766e",
    accentDark: "#134e4a",
    accentLight: "#ccfbf1",
    cover: "#f0fdfa",
  },
  SWI: {
    label: "Softwarové inženýrství",
    short: "SWI",
    subtitle: "Řízení projektu, analýza, procesy a dodávka informačních systémů",
    accent: "#4f46e5",
    accentDark: "#312e81",
    accentLight: "#e0e7ff",
    cover: "#f5f7ff",
  },
  TZI: {
    label: "Teoretické základy informatiky",
    short: "TZI",
    subtitle: "Matematické, algoritmické, kryptografické a virtualizační základy",
    accent: "#b45309",
    accentDark: "#78350f",
    accentLight: "#fef3c7",
    cover: "#fffbeb",
  },
};

const SUBJECT_ORDER = ["IT", "SWI", "TZI"];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripMarkdown(value) {
  return value
    .replace(/^#+\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\$([^$]+)\$/g, "$1")
    .trim();
}

function slugify(value) {
  return stripMarkdown(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 78);
}

function parseFrontMatter(markdown, fallbackTitle) {
  const lines = markdown.split(/\r?\n/);
  const titleLineIndex = lines.findIndex((line) => line.startsWith("# "));
  const rawTitle =
    titleLineIndex >= 0 ? lines[titleLineIndex].replace(/^#\s+/, "").trim() : fallbackTitle;

  let quoteStart = -1;
  let quoteEnd = -1;
  const quoteLines = [];

  for (let i = titleLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim() === "---") {
      continue;
    }
    if (line.startsWith(">")) {
      quoteStart = i;
      for (let j = i; j < lines.length; j += 1) {
        if (!lines[j].startsWith(">")) {
          quoteEnd = j - 1;
          break;
        }
        quoteLines.push(lines[j].replace(/^>\s?/, ""));
      }
      if (quoteEnd === -1) {
        quoteEnd = lines.length - 1;
      }
    }
    break;
  }

  const cleanedLines = lines.filter((_, index) => {
    if (index === titleLineIndex) {
      return false;
    }
    if (quoteStart >= 0 && index >= quoteStart && index <= quoteEnd) {
      return false;
    }
    if (quoteEnd >= 0 && (index === quoteEnd + 1 || index === quoteEnd + 2)) {
      return lines[index]?.trim() !== "---";
    }
    return true;
  });

  const match = rawTitle.match(/^(\d+)\.\s*(.+)$/);
  return {
    number: match ? match[1].padStart(2, "0") : "00",
    title: match ? match[2].trim() : rawTitle,
    fullTitle: rawTitle,
    question: quoteLines
      .join(" ")
      .trim()
      .replace(/^([*_])(.+)\1$/u, "$2")
      .trim(),
    body: cleanedLines.join("\n").replace(/^\s*---\s*/u, "").trim(),
  };
}

function createMarkdown() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight(code, language) {
      const validLanguage = language && hljs.getLanguage(language);
      if (validLanguage) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  });

  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

  md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const inline = tokens[index + 1];
    if (inline?.type === "inline") {
      const title = inline.content;
      const baseSlug = slugify(title) || `heading-${env.headings.length + 1}`;
      const count = (env.slugCounts.get(baseSlug) || 0) + 1;
      env.slugCounts.set(baseSlug, count);
      const slug = `${env.headingPrefix}-${baseSlug}${count > 1 ? `-${count}` : ""}`;
      token.attrSet("id", slug);
      env.headings.push({
        level: Number(token.tag.slice(1)),
        title: stripMarkdown(title),
        slug,
      });
    }
    return defaultHeadingOpen(tokens, index, options, env, self);
  };

  return md;
}

function renderMath(source, displayMode) {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      output: "htmlAndMathml",
      strict: "ignore",
    });
  } catch (error) {
    throw new Error(`Nejde vyrenderovat matematicky vzorec: ${source}\n${error.message}`);
  }
}

function findInlineMathEnd(markdown, start) {
  for (let index = start; index < markdown.length; index += 1) {
    if (markdown[index] === "$" && markdown[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

function lineAround(markdown, index) {
  const lineStart = markdown.lastIndexOf("\n", index - 1) + 1;
  const nextBreak = markdown.indexOf("\n", index);
  const lineEnd = nextBreak === -1 ? markdown.length : nextBreak;
  return {
    before: markdown.slice(lineStart, index),
    after: markdown.slice(index, lineEnd),
  };
}

function replaceMathWithPlaceholders(markdown) {
  const placeholders = [];
  let output = "";
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] === "`") {
      const codeEnd = markdown.indexOf("`", index + 1);
      if (codeEnd !== -1) {
        output += markdown.slice(index, codeEnd + 1);
        index = codeEnd + 1;
        continue;
      }
    }

    if (markdown.startsWith("$$", index)) {
      const end = markdown.indexOf("$$", index + 2);
      if (end !== -1) {
        const source = markdown.slice(index + 2, end).trim();
        const placeholder = `@@MATH${placeholders.length}@@`;
        placeholders.push({ placeholder, html: renderMath(source, true) });
        output += placeholder;
        index = end + 2;
        continue;
      }
    }

    if (markdown[index] === "$" && markdown[index - 1] !== "$" && markdown[index + 1] !== "$") {
      const end = findInlineMathEnd(markdown, index + 1);
      if (end !== -1) {
        const source = markdown.slice(index + 1, end).trim();
        if (source) {
          const around = lineAround(markdown, index);
          const displayMode = around.before.trim() === "" && around.after.slice(end - index + 1).trim() === "";
          const placeholder = `@@MATH${placeholders.length}@@`;
          placeholders.push({ placeholder, html: renderMath(source, displayMode) });
          output += placeholder;
          index = end + 1;
          continue;
        }
      }
    }

    output += markdown[index];
    index += 1;
  }

  return { markdown: output, placeholders };
}

function renderMarkdown(md, markdown, env) {
  const { markdown: withoutMath, placeholders } = replaceMathWithPlaceholders(markdown);
  let html = md.render(withoutMath, env);
  for (const { placeholder, html: mathHtml } of placeholders) {
    html = html.replaceAll(placeholder, mathHtml);
  }
  return html;
}

async function inlineKatexCss() {
  let css = await fs.readFile(KATEX_CSS, "utf8");
  const fontsUrl = pathToFileURL(KATEX_FONTS).href;
  css = css.replaceAll("url(fonts/", `url(${fontsUrl}/`);
  return css;
}

function buildSubjectIndex(subject, items) {
  const rows = items
    .map(
      (item) => `
        <li>
          <a href="#q-${item.meta.number}">
            <span class="index-number">${escapeHtml(item.meta.number)}</span>
            <span class="index-title">${escapeHtml(item.meta.title)}</span>
          </a>
        </li>`
    )
    .join("");

  return `
    <section class="subject-index">
      <div class="section-kicker">${escapeHtml(SUBJECTS[subject].short)}</div>
      <h2>Obsah všech otázek</h2>
      <ol>${rows}</ol>
    </section>
  `;
}

function cssForSubject(subject) {
  return `
    :root {
      --accent: ${subject.accent};
      --accent-dark: ${subject.accentDark};
      --accent-light: ${subject.accentLight};
      --cover: ${subject.cover};
      --ink: #15202b;
      --muted: #5b6472;
      --line: #d9e2ec;
      --soft: #f8fafc;
      --paper: #ffffff;
    }

    @page {
      size: A4;
      margin: 17mm 15mm 19mm;
    }

    * {
      box-sizing: border-box;
    }

    html {
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 10.4pt;
      line-height: 1.47;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      margin: 0;
      background: var(--paper);
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    .subject-cover {
      position: relative;
      min-height: 246mm;
      margin: -2mm -1mm 0;
      padding: 20mm 16mm 17mm;
      border: 1px solid #d9e2ec;
      border-radius: 8px;
      overflow: hidden;
      background: linear-gradient(135deg, var(--cover), #ffffff 72%);
      break-after: page;
    }

    .subject-cover::before {
      content: "";
      position: absolute;
      inset: 0;
      border-top: 7px solid var(--accent);
      pointer-events: none;
    }

    .meta-row {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 28mm;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 25px;
      padding: 0 10px;
      border-radius: 999px;
      color: var(--accent-dark);
      font-size: 8.5pt;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      background: var(--accent-light);
      border: 1px solid color-mix(in srgb, var(--accent) 28%, white);
    }

    .subject-mark {
      display: grid;
      place-items: center;
      width: 34mm;
      height: 34mm;
      margin-bottom: 11mm;
      border-radius: 8px;
      color: #ffffff;
      background: linear-gradient(135deg, var(--accent), var(--accent-dark));
      font-size: 25pt;
      font-weight: 850;
      line-height: 1;
      box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 22%, transparent);
    }

    h1 {
      max-width: 160mm;
      margin: 0;
      color: var(--accent-dark);
      font-size: 30pt;
      line-height: 1.06;
      letter-spacing: 0;
      text-wrap: balance;
    }

    .subtitle {
      max-width: 150mm;
      margin-top: 7mm;
      color: #334155;
      font-size: 13pt;
      line-height: 1.42;
    }

    .subject-index {
      margin: 0;
      padding: 5mm 0 0;
      break-after: page;
    }

    .section-kicker {
      color: var(--accent);
      font-size: 8pt;
      font-weight: 850;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .subject-index h2 {
      margin-top: 1mm;
      padding: 0;
      border: 0;
      color: var(--accent-dark);
      font-size: 16pt;
    }

    .subject-index ol {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      margin: 5mm 0 0;
      padding-left: 0;
      list-style: none;
      border-top: 1px solid var(--line);
    }

    .subject-index li {
      margin: 0;
      padding: 0;
      break-inside: avoid;
    }

    .subject-index a {
      display: grid;
      grid-template-columns: 10mm 1fr;
      align-items: start;
      gap: 3mm;
      min-height: 8mm;
      padding: 2.1mm 0;
      border-bottom: 1px solid var(--line);
    }

    .index-number {
      color: var(--accent);
      font-size: 9pt;
      font-weight: 850;
      line-height: 1;
      padding-top: .7mm;
    }

    .index-title {
      color: #243244;
      font-size: 9.8pt;
      font-weight: 680;
      line-height: 1.28;
    }

    .question-chapter {
      break-before: page;
    }

    .question-heading {
      margin: 0 0 6mm;
      padding: 7mm 7mm 6mm;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--accent) 22%, white);
      background: linear-gradient(135deg, var(--accent-light), #ffffff 86%);
      break-inside: avoid;
    }

    .question-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 12mm;
      height: 9mm;
      margin-bottom: 4mm;
      border-radius: 5px;
      color: #ffffff;
      background: var(--accent);
      font-size: 12pt;
      font-weight: 850;
      line-height: 1;
    }

    .question-heading h2 {
      margin: 0;
      padding: 0;
      border: 0;
      color: var(--accent-dark);
      font-size: 20pt;
      line-height: 1.12;
      text-wrap: balance;
    }

    .question-prompt {
      margin-top: 4mm;
      padding: 4mm 5mm;
      border-left: 4px solid var(--accent);
      border-radius: 5px;
      background: rgba(255, 255, 255, .72);
      color: #334155;
      font-size: 9.7pt;
      font-style: italic;
      line-height: 1.45;
    }

    .content {
      color: var(--ink);
    }

    .content > *:first-child {
      margin-top: 0;
    }

    .content h2 {
      margin: 9mm 0 4mm;
      padding-top: 0;
      border-top: 0;
      color: var(--accent-dark);
      font-size: 15.6pt;
      line-height: 1.18;
      letter-spacing: 0;
      break-after: avoid;
    }

    .content h3 {
      margin: 6mm 0 2.4mm;
      color: #1d2939;
      font-size: 12.3pt;
      line-height: 1.25;
      letter-spacing: 0;
      break-after: avoid;
    }

    .content h4,
    .content h5 {
      margin: 4mm 0 1.8mm;
      color: var(--accent-dark);
      font-size: 10.4pt;
      line-height: 1.32;
      letter-spacing: 0;
      break-after: avoid;
    }

    p {
      margin: 0 0 3.1mm;
      orphans: 3;
      widows: 3;
    }

    strong {
      color: #111827;
      font-weight: 800;
    }

    em {
      color: #334155;
    }

    ul,
    ol {
      margin: 0 0 3.6mm;
      padding-left: 6.5mm;
    }

    li {
      margin: 0 0 1.8mm;
      padding-left: 1mm;
    }

    li::marker {
      color: var(--accent);
      font-weight: 800;
    }

    hr {
      display: none;
    }

    blockquote {
      margin: 4mm 0;
      padding: 4mm 5mm;
      border-left: 4px solid var(--accent);
      border-radius: 5px;
      background: var(--soft);
      color: #334155;
    }

    code {
      padding: .7mm 1.2mm;
      border-radius: 4px;
      background: #eef2f7;
      color: #0f172a;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: .92em;
    }

    pre {
      margin: 4mm 0;
      padding: 4mm;
      border-radius: 6px;
      border: 1px solid #d8e0eb;
      background: #0f172a;
      color: #e5edf8;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      break-inside: avoid;
    }

    pre code {
      padding: 0;
      background: transparent;
      color: inherit;
      font-size: 8.8pt;
    }

    table {
      width: 100%;
      margin: 4mm 0;
      border-collapse: collapse;
      font-size: 9.2pt;
      break-inside: avoid;
    }

    th,
    td {
      padding: 2.3mm 2.6mm;
      border: 1px solid #d8e0eb;
      vertical-align: top;
    }

    th {
      color: var(--accent-dark);
      background: var(--accent-light);
      font-weight: 800;
    }

    .katex {
      font-size: 1.02em;
    }

    .katex-display {
      margin: 4mm 0;
      padding: 3mm 4mm;
      border-radius: 6px;
      background: #f8fafc;
      overflow: hidden;
      break-inside: avoid;
    }

    .header,
    .footer {
      width: 100%;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 8px;
      color: #64748b;
      padding: 0 14mm;
    }

    .header {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      border-top: 1px solid #e2e8f0;
      padding-top: 4px;
    }

    @media print {
      .subject-cover,
      .subject-index,
      .question-heading,
      pre,
      table {
        break-inside: avoid;
      }
    }
  `;
}

function buildSubjectCover(subject, items) {
  const theme = SUBJECTS[subject];
  return `
    <section class="subject-cover">
      <div class="meta-row">
        <span class="pill">${escapeHtml(theme.short)}</span>
        <span class="pill">Státnice</span>
      </div>
      <div class="subject-mark">${escapeHtml(theme.short)}</div>
      <h1>${escapeHtml(theme.label)}</h1>
      <div class="subtitle">${escapeHtml(theme.subtitle)}</div>
    </section>
  `;
}

function buildQuestionChapter(item) {
  return `
    <section class="question-chapter" id="q-${escapeHtml(item.meta.number)}">
      <header class="question-heading">
        <div class="question-number">${escapeHtml(item.meta.number)}</div>
        <h2>${escapeHtml(item.meta.title)}</h2>
        ${
          item.meta.question
            ? `<div class="question-prompt">${escapeHtml(item.meta.question)}</div>`
            : ""
        }
      </header>
      <article class="content">${item.bodyHtml}</article>
    </section>
  `;
}

function buildHtml({ subject, items, katexCss }) {
  const theme = SUBJECTS[subject];
  const chapters = items.map(buildQuestionChapter).join("\n");
  return `<!doctype html>
  <html lang="cs">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(theme.short)} - ${escapeHtml(theme.label)}</title>
      <style>${katexCss}</style>
      <style>${cssForSubject(theme)}</style>
    </head>
    <body>
      <main>
        ${buildSubjectCover(subject, items)}
        ${buildSubjectIndex(subject, items)}
        ${chapters}
      </main>
    </body>
  </html>`;
}

async function readSubjectItems(subject, md) {
  const directory = path.join(ROOT, subject);
  const entries = await fs.readdir(directory);
  const markdownFiles = entries
    .filter((entry) => /^\d+\.md$/u.test(entry))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));

  const items = [];
  for (const entry of markdownFiles) {
    const file = path.join(directory, entry);
    const markdown = await fs.readFile(file, "utf8");
    const meta = parseFrontMatter(markdown, path.basename(entry, ".md"));
    const env = {
      headings: [],
      headingPrefix: `${subject.toLowerCase()}-${meta.number}`,
      slugCounts: new Map(),
    };
    const bodyHtml = renderMarkdown(md, meta.body, env);
    items.push({
      file,
      meta,
      bodyHtml,
      headings: env.headings,
    });
  }

  return items;
}

function headerTemplate(subject) {
  const theme = SUBJECTS[subject];
  return `
    <div class="header">
      <span>${escapeHtml(theme.short)}</span>
      <span>${escapeHtml(theme.label)}</span>
    </div>
  `;
}

function footerTemplate(subject) {
  const theme = SUBJECTS[subject];
  return `
    <div class="footer">
      <span>${escapeHtml(theme.short)} - všechny otázky</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  `;
}

async function printPdf(page, subject, htmlFile, pdfFile) {
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "networkidle" });
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: pdfFile,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: headerTemplate(subject),
    footerTemplate: footerTemplate(subject),
    margin: {
      top: "17mm",
      right: "15mm",
      bottom: "19mm",
      left: "15mm",
    },
    preferCSSPageSize: true,
  });
}

async function cleanOldOutputs() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.rm(HTML_DIR, { recursive: true, force: true });
  await fs.mkdir(HTML_DIR, { recursive: true });
  const entries = await fs.readdir(OUTPUT_DIR);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".pdf"))
      .map((entry) => fs.rm(path.join(OUTPUT_DIR, entry), { force: true }))
  );
}

async function main() {
  const md = createMarkdown();
  const katexCss = await inlineKatexCss();

  await cleanOldOutputs();

  const rendered = [];
  for (const subject of SUBJECT_ORDER) {
    const items = await readSubjectItems(subject, md);
    const html = buildHtml({ subject, items, katexCss });
    const htmlFile = path.join(HTML_DIR, `${subject}.html`);
    const pdfFile = path.join(OUTPUT_DIR, `${subject}.pdf`);
    await fs.writeFile(htmlFile, html, "utf8");
    rendered.push({ subject, htmlFile, pdfFile, count: items.length });
  }

  const browser = await chromium.launch({
    executablePath: CHROME_EXECUTABLE,
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1240, height: 1754 },
      deviceScaleFactor: 1,
    });

    for (const item of rendered) {
      await printPdf(page, item.subject, item.htmlFile, item.pdfFile);
      console.log(
        `created ${path.relative(ROOT, item.pdfFile)} (${item.count} questions)`
      );
    }
  } finally {
    await browser.close();
  }

  await fs.rm(HTML_DIR, { recursive: true, force: true });
  console.log(`done: ${rendered.length} PDFs in ${path.relative(ROOT, OUTPUT_DIR)}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
